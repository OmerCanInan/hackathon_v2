import type { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  STREAMS,
  CONSUMER_GROUPS,
  TRIAGE_KEYS,
  type ScoredEvent,
  type TriageResult,
} from "@kemple/shared";
import type { PrismaClient } from "@prisma/client";
import {
  buildTriagePrompt,
  callOllamaWithTimeout,
  ruleBasedTriage,
  getEmbedding,
  cosineSimilarity,
  OLLAMA_MODEL,
} from "./lib/ollama.js";
import { writeToDLQ } from "./lib/redis.js";

const CONSUMER_NAME = `triage-${uuidv4().slice(0, 8)}`;

let ragDb: any[] | null = null;

export class TriageAgent {
  private circuitOpen = false;
  private circuitFailures = 0;
  private readonly circuitThreshold = 2;

  constructor(
    private readonly consumerRedis: Redis,
    private readonly writeRedis: Redis,
    private readonly prisma: PrismaClient
  ) {}

  async start(): Promise<void> {
    console.log("🏥 TriageAgent başladı");
    const { stream, group } = CONSUMER_GROUPS.CONFIDENCE;

    while (true) {
      try {
        // Circuit breaker durumunu kontrol et
        const cbState = await this.writeRedis.get(TRIAGE_KEYS.circuitBreaker);
        this.circuitOpen = cbState === "open";

        const results = await this.consumerRedis.xreadgroup(
          "GROUP", group, CONSUMER_NAME,
          "COUNT", "5",
          "BLOCK", "2000",
          "STREAMS", stream, ">"
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (results) {
          for (const [, messages] of results) {
            // Paralel işleme: 5 mesajı aynı anda LLM'e gönder
            await Promise.all(
              messages.map(([msgId, fields]) => 
                this.processMessage(msgId, fields, stream, group)
              )
            );
          }
        }

        // Revision stream'i de dinle
        await this.handleRevisions();

      } catch (err) {
        console.error("TriageAgent döngü hatası:", err);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  private async processMessage(
    msgId: string,
    fields: string[],
    stream: string,
    group: string
  ): Promise<void> {
    try {
      const data = fields[fields.indexOf("data") + 1];
      const event: ScoredEvent = JSON.parse(data);

      const result = await this.triage(event);

      // Sonucu stream'e yaz
      await this.writeRedis.xadd(STREAMS.TRIAGE, "*", "data", JSON.stringify(result));

      // Redis cache
      await this.writeRedis.setex(
        TRIAGE_KEYS.result(event.cluster_id),
        TRIAGE_KEYS.resultTTL,
        JSON.stringify(result)
      );

      // PostgreSQL
      await this.saveToPg(result, event);

      console.log(
        `🏥 Triage: ${event.cluster_id} → Skor:${result.triage_score} ` +
        `Tip:${result.event_type} [${this.circuitOpen ? "KURAL" : "LLM"}]`
      );

      await this.consumerRedis.xack(stream, group, msgId);
    } catch (err) {
      console.error("TriageAgent mesaj hatası:", err);
      await writeToDLQ(this.writeRedis, stream, msgId, {}, String(err));
      await this.consumerRedis.xack(stream, group, msgId);
    }
  }

  private async triage(event: ScoredEvent): Promise<TriageResult> {
    let triageData: ReturnType<typeof ruleBasedTriage>;

    if (!this.circuitOpen) {
      // RAG ile Benzer Senaryoları Bul
      let topExamplesStr = "";
      if (ragDb === null) {
        try {
          const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./lib/rag-db.json");
          const content = await fs.readFile(dbPath, "utf-8");
          ragDb = JSON.parse(content);
        } catch (e: any) {
          console.warn("RAG DB yüklenemedi (henüz oluşmamış olabilir):", e.message || e);
          ragDb = [];
        }
      }

      if (ragDb && ragDb.length > 0) {
        const text = event.raw_payloads.join(" ");
        const vector = await getEmbedding(text);
        if (vector) {
          const scored = ragDb.map(item => ({
            ...item,
            similarity: cosineSimilarity(vector, item.vector)
          }));
          scored.sort((a, b) => b.similarity - a.similarity);
          const top3 = scored.slice(0, 3);
          
          topExamplesStr = top3.map((ex, i) => {
            const evType = ex.severity === "Yüksek" ? "ENKAZ_MAHSUR" : ex.severity === "Orta" ? "LOJISTIK" : "BILGI_TALEBI";
            const urgency = ex.severity === "Yüksek" ? "KRITIK" : ex.severity === "Orta" ? "ORTA" : "DUSUK";
            return `${i + 1}. "${ex.text}"\n   -> Skor: ${ex.score.toFixed(1)}, Tip: "${evType}", Aciliyet: "${urgency}"`;
          }).join("\n");
        }
      }

      // LLM ile dene
      const prompt = buildTriagePrompt(
        event.cluster_id,
        event.raw_payloads,
        event.source_count,
        event.confidence_score,
        topExamplesStr || undefined
      );

      const llmResponse = await callOllamaWithTimeout(prompt);

      if (llmResponse) {
        try {
          const parsed = JSON.parse(llmResponse);
          
          // ─── KALİTE: LLM çıktısını doğrula ──────────────────────────────────
          if (typeof parsed.triage_score !== "number" || isNaN(parsed.triage_score)) {
            throw new Error("Geçersiz triage_score");
          }
          parsed.triage_score = Math.max(0, Math.min(10, parsed.triage_score));
          
          const validTypes = ["ENKAZ_MAHSUR", "TIBBI_ACIL", "YANGIN", "LOJISTIK", "BILGI_TALEBI", "BELIRSIZ"];
          if (!validTypes.includes(parsed.event_type)) {
            parsed.event_type = "BELIRSIZ";
          }
          
          triageData = parsed;
          this.circuitFailures = 0;
        } catch (err) {
          console.warn("LLM çıktı doğrulama hatası, fallback kullanılıyor:", err);
          this.incrementCircuitFailure();
          triageData = ruleBasedTriage(event.raw_payloads, event.confidence_score);
        }
      } else {
        this.incrementCircuitFailure();
        triageData = ruleBasedTriage(event.raw_payloads, event.confidence_score);
      }
    } else {
      // Circuit açık — sadece kural motoru
      triageData = ruleBasedTriage(event.raw_payloads, event.confidence_score);
    }

    return {
      cluster_id: event.cluster_id,
      triage_score: triageData.triage_score,
      event_type: triageData.event_type as TriageResult["event_type"],
      extracted_persons: triageData.extracted_persons,
      medical_urgency: triageData.medical_urgency as TriageResult["medical_urgency"],
      access_type: triageData.access_type as TriageResult["access_type"],
      suggested_resources: triageData.suggested_resources,
      criteria: triageData.criteria,
      reasoning: triageData.reasoning,
      enriched_text: (event as any).enriched_payloads?.[0] || event.raw_payloads[0],
      model_version: this.circuitOpen ? "rule-engine-v1" : OLLAMA_MODEL,
      iteration_count: event.iteration_count,
    };
  }

  private incrementCircuitFailure() {
    this.circuitFailures++;
    if (this.circuitFailures >= this.circuitThreshold) {
      this.writeRedis.setex(TRIAGE_KEYS.circuitBreaker, TRIAGE_KEYS.circuitBreakerTTL, "open");
      this.circuitOpen = true;
      console.warn("⚡ Circuit breaker AÇILDI — kural motoru devreye girdi");
    }
  }

  private async saveToPg(result: TriageResult, event: ScoredEvent): Promise<void> {
    // Cluster'ı önce upsert et (FK bağımlılığı — race condition koruması)
    await this.prisma.cluster.upsert({
      where: { cluster_id: event.cluster_id },
      update: {
        centroid_lat: event.centroid?.lat ?? null,
        centroid_lng: event.centroid?.lng ?? null,
        source_count: event.source_count,
        packet_count: event.packet_uuids.length,
        last_updated: new Date(),
      },
      create: {
        cluster_id: event.cluster_id,
        centroid_lat: event.centroid?.lat ?? null,
        centroid_lng: event.centroid?.lng ?? null,
        source_count: event.source_count,
        packet_count: event.packet_uuids.length,
        first_seen: new Date(event.first_seen),
      },
    }).catch((err: unknown) => console.warn("Cluster upsert (triage):", err));

    await this.prisma.triageResult.upsert({
      where: { cluster_id_iteration_count: { cluster_id: event.cluster_id, iteration_count: result.iteration_count } },
      update: {
        triage_score: result.triage_score,
        event_type: result.event_type,
        extracted_persons: result.extracted_persons,
        medical_urgency: result.medical_urgency,
        access_type: result.access_type,
        suggested_resources: result.suggested_resources,
        criteria_hayati_tehlike: result.criteria.hayati_tehlike,
        criteria_kisi_sayisi: result.criteria.kisi_sayisi,
        criteria_tibbi_aciliyet: result.criteria.tibbi_aciliyet,
        criteria_confidence_input: result.criteria.confidence_input,
        criteria_zaman_faktoru: result.criteria.zaman_faktoru,
        reasoning: result.reasoning,
        model_version: result.model_version,
      },
      create: {
        cluster_id: event.cluster_id,
        iteration_count: result.iteration_count,
        triage_score: result.triage_score,
        event_type: result.event_type,
        extracted_persons: result.extracted_persons,
        medical_urgency: result.medical_urgency,
        access_type: result.access_type,
        suggested_resources: result.suggested_resources,
        criteria_hayati_tehlike: result.criteria.hayati_tehlike,
        criteria_kisi_sayisi: result.criteria.kisi_sayisi,
        criteria_tibbi_aciliyet: result.criteria.tibbi_aciliyet,
        criteria_confidence_input: result.criteria.confidence_input,
        criteria_zaman_faktoru: result.criteria.zaman_faktoru,
        reasoning: result.reasoning,
        model_version: result.model_version,
      },
    }).catch((err: unknown) => console.warn("TriageResult write:", err));
  }

  private async handleRevisions(): Promise<void> {
    try {
      const { stream, group } = CONSUMER_GROUPS.REVISION_TRIAGE;
      const results = await this.writeRedis.xreadgroup(
        "GROUP", group, CONSUMER_NAME,
        "COUNT", "5",
        "BLOCK", "100",
        "STREAMS", stream, ">"
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results) return;

      for (const [, messages] of results) {
        for (const [msgId, fields] of messages) {
          const data = fields[fields.indexOf("data") + 1];
          const revision = JSON.parse(data);

          if (revision.target_agent !== "TriageAgent") {
            await this.writeRedis.xack(STREAMS.REVISION, CONSUMER_GROUPS.REVISION_TRIAGE.group, msgId);
            continue;
          }

          console.log(`🔄 TriageAgent revizyon alındı: ${revision.cluster_id}`);
          const cached = await this.writeRedis.get(`confidence:${revision.cluster_id}`);
          if (cached) {
            const confData = JSON.parse(cached);
            // Fake ScoredEvent oluştur
            const clusterMeta = await this.writeRedis.get(`cluster:meta:${revision.cluster_id}`);
            if (clusterMeta) {
              const meta = JSON.parse(clusterMeta);
              const fakeEvent: ScoredEvent = {
                cluster_id: revision.cluster_id,
                packet_uuids: meta.packet_uuids,
                device_ids: meta.device_ids ?? [],
                centroid: { lat: meta.centroid_lat, lng: meta.centroid_lng },
                source_count: meta.source_count,
                first_seen: meta.first_seen,
                last_updated: meta.last_updated,
                raw_payloads: meta.raw_payloads,
                iteration_count: revision.iteration_count + 1,
                confidence_score: confData.score,
                score_breakdown: confData.breakdown,
                anomaly_flags: confData.anomaly_flags,
                device_reputations: {},
              };
              const result = await this.triage(fakeEvent);
              await this.writeRedis.xadd(STREAMS.TRIAGE, "*", "data", JSON.stringify(result));
            }
          }

          await this.writeRedis.xack(STREAMS.REVISION, CONSUMER_GROUPS.REVISION_TRIAGE.group, msgId);
        }
      }
    } catch { /* revision stream henüz yok */ }
  }
}
