import type { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import {
  STREAMS,
  CONSUMER_GROUPS,
  REVIEW_KEYS,
  MAX_ITERATIONS,
  type TriageResult,
  type ConfidenceToReview,
  type RevisionRequest,
  type ReviewApproved,
} from "@kemple/shared";
import type { PrismaClient } from "@prisma/client";
import { writeToDLQ } from "./lib/redis.js";

// Operatör ACK mesaj tipi
interface OperatorAckMsg {
  cluster_id:  string;
  action:      "approve_hold" | "reject_hold" | "escalate_now";
  operator_id: string;
  decided_at:  string;
}

const CONSUMER_NAME = `review-${uuidv4().slice(0, 8)}`;

interface PendingReview {
  confidence_arrived: boolean;
  triage_arrived: boolean;
  confidence?: ConfidenceToReview;
  triage?: TriageResult;
  iteration_count: number;
}

export class ReviewAgent {
  constructor(
    private readonly consumerRedis: Redis,
    private readonly writeRedis: Redis,
    private readonly prisma: PrismaClient
  ) {}

  async start(): Promise<void> {
    console.log("🔍 ReviewAgent başladı");

    while (true) {
      try {
        // İki stream'i dinle: triage_results + confidence_to_review
        await Promise.all([
          this.consumeStream(
            STREAMS.TRIAGE,
            CONSUMER_GROUPS.TRIAGE.group,
            "triage"
          ),
          this.consumeStream(
            STREAMS.CONF_TO_REVIEW,
            CONSUMER_GROUPS.CONF_REVIEW.group,
            "confidence"
          ),
          // Operatör ACK stream'i: hold kaldırma / zorunlu eskalasyon
          this.consumeOperatorAck(),
        ]);
      } catch (err) {
        console.error("ReviewAgent döngü hatası:", err);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  private async consumeStream(
    stream: string,
    group: string,
    type: "triage" | "confidence"
  ): Promise<void> {
    const results = await this.consumerRedis.xreadgroup(
      "GROUP", group, CONSUMER_NAME,
      "COUNT", "10",
      "BLOCK", "1000",
      "STREAMS", stream, ">"
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!results) return;

    for (const [, messages] of results) {
      for (const [msgId, fields] of messages) {
        try {
          const data = fields[fields.indexOf("data") + 1];
          const payload = JSON.parse(data);

          await this.handleArrival(payload, type);
          await this.consumerRedis.xack(stream, group, msgId);
        } catch (err) {
          console.error("ReviewAgent mesaj hatası:", err);
          await writeToDLQ(this.writeRedis, stream, msgId, {}, String(err));
          await this.consumerRedis.xack(stream, group, msgId);
        }
      }
    }
  }

  private async handleArrival(
    payload: TriageResult | ConfidenceToReview,
    type: "triage" | "confidence"
  ): Promise<void> {
    const clusterId = payload.cluster_id;
    const pendingKey = REVIEW_KEYS.pending(clusterId);

    // ─── LUA SCRIPT: Atomik PendingReview Birleştirme ────────────────────────
    // Bu script Redis üzerinde tek seferde çalışır ve Check-and-Set işlemini atomik kılar
    const luaScript = `
      local key = KEYS[1]
      local ttl = ARGV[1]
      local payloadType = ARGV[2]
      local payloadData = ARGV[3]
      local iterCount = ARGV[4]

      local existing = redis.call("GET", key)
      local pending = {}

      if existing then
        pending = cjson.decode(existing)
      else
        pending = { confidence_arrived = false, triage_arrived = false, iteration_count = tonumber(iterCount) }
      end

      if payloadType == "triage" then
        pending.triage_arrived = true
        pending.triage_raw = payloadData
      else
        pending.confidence_arrived = true
        pending.confidence_raw = payloadData
      end

      local isComplete = pending.confidence_arrived and pending.triage_arrived

      if isComplete then
        redis.call("DEL", key)
      else
        redis.call("SETEX", key, ttl, cjson.encode(pending))
      end

      return { isComplete and 1 or 0, cjson.encode(pending) }
    `;

    // ─── REVISION FIX: Eğer diğer veriyi kaçırmışsak, önden cache'ten getirmeyi deneyelim
    let payloadToMerge = { ...payload };
    
    // Geçici olarak bu nodejs thread'inde eksik parçaları tamamla
    const triageCache = type === "confidence" ? await this.writeRedis.get(`triage:${clusterId}`) : null;
    const confCache   = type === "triage"     ? await this.writeRedis.get(`confidence:${clusterId}`) : null;

    let evalResult;
    try {
      evalResult = await this.writeRedis.eval(
        luaScript,
        1,
        pendingKey,
        REVIEW_KEYS.pendingTTL,
        type,
        JSON.stringify(payload),
        payload.iteration_count
      ) as [number, string];
    } catch (err) {
      console.error("Lua script hatası:", err);
      return;
    }

    let isComplete = evalResult[0] === 1;
    let pendingState: any = JSON.parse(evalResult[1]);

    // Eğer cache'de bulduysak ve Lua script eksik dediyse, cache'i de Lua'ya göndererek tamamla
    if (!isComplete) {
      if (type === "confidence" && triageCache && !pendingState.triage_arrived) {
         evalResult = await this.writeRedis.eval(
           luaScript, 1, pendingKey, REVIEW_KEYS.pendingTTL, "triage", triageCache, payload.iteration_count
         ) as [number, string];
         isComplete = evalResult[0] === 1;
         pendingState = JSON.parse(evalResult[1]);
      } else if (type === "triage" && confCache && !pendingState.confidence_arrived) {
         const parsedConf = JSON.parse(confCache);
         const mappedConf: ConfidenceToReview = {
           cluster_id: clusterId,
           confidence_score: parsedConf.score,
           score_breakdown: parsedConf.breakdown,
           anomaly_flags: Array.isArray(parsedConf.anomaly_flags) ? parsedConf.anomaly_flags : [],
           source_count: parsedConf.source_count ?? 1,
           iteration_count: parsedConf.iteration_count ?? 0,
         };
         evalResult = await this.writeRedis.eval(
           luaScript, 1, pendingKey, REVIEW_KEYS.pendingTTL, "confidence", JSON.stringify(mappedConf), payload.iteration_count
         ) as [number, string];
         isComplete = evalResult[0] === 1;
         pendingState = JSON.parse(evalResult[1]);
      }
    }

    if (pendingState.confidence_raw && !pendingState.confidence) {
      pendingState.confidence = JSON.parse(pendingState.confidence_raw);
    }
    if (pendingState.triage_raw && !pendingState.triage) {
      pendingState.triage = JSON.parse(pendingState.triage_raw);
    }

    if (isComplete && pendingState.confidence && pendingState.triage) {
      await this.performCrossCheck(clusterId, pendingState.confidence, pendingState.triage, pendingState.iteration_count);
    }
  }

  private async performCrossCheck(
    clusterId: string,
    confidence: ConfidenceToReview,
    triage: TriageResult,
    iterationCount: number
  ): Promise<void> {
    // İterasyon sayacını kontrol et
    const iterKey  = REVIEW_KEYS.iterations(clusterId);
    const iterations = parseInt((await this.writeRedis.get(iterKey)) ?? "0");

    console.log(`🔍 Cross-check: ${clusterId} (iter:${iterations})`);

    // Çapraz tutarsızlık tespiti
    const issues = this.detectInconsistencies(confidence, triage);

    if (issues.length > 0 && iterations < MAX_ITERATIONS) {
      // Revizyon iste
      await this.writeRedis.setex(iterKey, REVIEW_KEYS.iterationsTTL, String(iterations + 1));

      const targetAgent = Math.random() > 0.5 ? "TriageAgent" : "ConfidenceAgent";
      const revision: RevisionRequest = {
        cluster_id:        clusterId,
        target_agent:      targetAgent,
        fields_to_revise:  issues.map(i => i.field),
        revision_reason:   issues.map(i => i.reason).join("; "),
        original_values: {
          confidence_score: confidence.confidence_score,
          triage_score:     triage.triage_score,
          event_type:       triage.event_type,
        },
        iteration_count: iterations + 1,
      };

      await this.writeRedis.xadd(STREAMS.REVISION, "*", "data", JSON.stringify(revision));
      console.log(`📤 Revizyon gönderildi: ${clusterId} → ${targetAgent} (${issues.length} sorun)`);

      // Review kararını PG'ye yaz
      await this.saveReviewDecision(clusterId, "revision_sent", iterations, targetAgent, issues);

    } else {
      // Onayla veya eskalasyon
      const shouldEscalate =
        (confidence.confidence_score < 20 && triage.triage_score > 7) ||
        confidence.anomaly_flags.length >= 2;

      if (shouldEscalate) {
        // ── Operatör Onay Bekleme Modu ──────────────────────────────────────
        // Hold key'i yaz; CommandAgent bunu dashboard'a bildirir
        const holdData = {
          cluster_id:       clusterId,
          final_triage:     triage.triage_score,
          final_confidence: confidence.confidence_score,
          anomaly_flags:    confidence.anomaly_flags,
          source_count:     confidence.source_count,
          total_iterations: iterations,
          held_at:          new Date().toISOString(),
        };
        await this.writeRedis.setex(
          REVIEW_KEYS.operatorHold(clusterId),
          REVIEW_KEYS.operatorHoldTTL,
          JSON.stringify(holdData)
        );
        // Stream'e hold bildirimi yaz (CommandAgent dinler)
        await this.writeRedis.xadd(
          STREAMS.OPERATOR_ACK,
          "*",
          "type",       "HOLD_CREATED",
          "cluster_id", clusterId,
          "data",       JSON.stringify(holdData)
        );
        console.warn(
          `⏸️  Operatör onayı bekleniyor: ${clusterId} ` +
          `(conf:${confidence.confidence_score} triage:${triage.triage_score})`
        );
        await this.saveReviewDecision(clusterId, "escalated", iterations, undefined, []);
        return;
      }

      await this.publishApproved(clusterId, triage, confidence, iterations, false);
    }
  }

  // ─── Onaylı ReviewApproved yayınla ──────────────────────────────────────────
  private async publishApproved(
    clusterId: string,
    triage: TriageResult,
    confidence: ConfidenceToReview,
    iterations: number,
    wasOnHold: boolean,
    isEscalated: boolean = false
  ): Promise<void> {
    const reviewStatus = isEscalated ? "escalated" : "approved";
    const approved: ReviewApproved = {
      cluster_id:            clusterId,
      final_triage_score:    triage.triage_score,
      final_confidence_score: confidence.confidence_score,
      review_status:         reviewStatus as "approved" | "escalated",
      escalated:             isEscalated,
      escalation_reason:     isEscalated ? "Operatör tarafından acil eskalasyon" : undefined,
      review_notes:          `${
        wasOnHold ? "Operatör onayı sonrası: " : ""
      }${iterations} iterasyon sonrası ${reviewStatus}.`,
      total_iterations: iterations,
    };

    await this.writeRedis.xadd(STREAMS.REVIEW_APPROVED, "*", "data", JSON.stringify(approved));
    console.log(`✅ Review published: ${clusterId} (status:${reviewStatus}, triage:${triage.triage_score}, conf:${confidence.confidence_score})`);
    await this.saveReviewDecision(clusterId, reviewStatus, iterations, undefined, []);
  }

  private detectInconsistencies(
    confidence: ConfidenceToReview,
    triage: TriageResult
  ): Array<{ field: string; reason: string }> {
    const issues: Array<{ field: string; reason: string }> = [];

    // Yüksek triage + çok düşük confidence → şüpheli
    if (triage.triage_score > 8 && confidence.confidence_score < 30) {
      issues.push({
        field: "confidence_score",
        reason: `Kritik triyaj (${triage.triage_score}) ama güven çok düşük (${confidence.confidence_score})`,
      });
    }

    // Tek kaynak enkaz iddiası
    if (triage.event_type === "ENKAZ_MAHSUR" && confidence.source_count < 2 && confidence.confidence_score < 50) {
      issues.push({
        field: "event_type",
        reason: `ENKAZ_MAHSUR tek kaynaktan (${confidence.source_count}) doğrulanamıyor`,
      });
    }

    // Anomali bayrağı + yüksek triage
    const flags = Array.isArray(confidence.anomaly_flags) ? confidence.anomaly_flags : [];
    if (flags.includes("SYBIL_SUSPECT") && triage.triage_score > 6) {
      issues.push({
        field: "triage_score",
        reason: "Sybil şüphesi varken yüksek triyaj skoru",
      });
    }

    return issues;
  }

  private async saveReviewDecision(
    clusterId: string,
    status: string,
    totalIterations: number,
    targetAgent?: string,
    issues?: Array<{ field: string; reason: string }>
  ): Promise<void> {
    await this.prisma.reviewDecision.create({
      data: {
        cluster_id:          clusterId,
        iteration_count:     totalIterations,
        review_status:       status,
        target_agent:        targetAgent ?? null,
        fields_to_revise:    issues?.map(i => i.field) ?? [],
        revision_reason:     issues?.map(i => i.reason).join("; ") ?? null,
        total_iterations:    totalIterations,
        review_model_version: "kemple-review-v1",
      },
    }).catch(() => {});
  }

  // ─── Operatör ACK Stream Dinleyici ──────────────────────────────────────────
  // CommandAgent, operatör dashboard'dan gelen onay/ret kararını bu stream'e yazar.
  private async consumeOperatorAck(): Promise<void> {
    try {
      const { stream, group } = CONSUMER_GROUPS.OPERATOR_ACK;
      const results = await this.writeRedis.xreadgroup(
        "GROUP", group, CONSUMER_NAME,
        "COUNT", "10",
        "BLOCK", "200",
        "STREAMS", stream, ">"
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results) return;

      for (const [, messages] of results) {
        for (const [msgId, fields] of messages) {
          try {
            const type      = fields[fields.indexOf("type") + 1];
            const clusterId = fields[fields.indexOf("cluster_id") + 1];
            const data      = fields[fields.indexOf("data") + 1];

            if (type === "HOLD_RELEASE" && clusterId) {
              await this.handleHoldRelease(clusterId, data);
            }
            // HOLD_CREATED mesajları (kendi yazdığımız) — atla
            await this.writeRedis.xack(stream, group, msgId);
          } catch (err) {
            console.error("ReviewAgent ACK mesaj hatası:", err);
            await this.writeRedis.xack(stream, group, msgId);
          }
        }
      }
    } catch { /* stream henüz yok olabilir */ }
  }

  private async handleHoldRelease(clusterId: string, dataRaw: string): Promise<void> {
    const holdKey = REVIEW_KEYS.operatorHold(clusterId);
    const holdRaw = await this.writeRedis.get(holdKey);
    if (!holdRaw) {
      console.warn(`ReviewAgent: ${clusterId} için bekleyen hold bulunamadı`);
      return;
    }

    const holdData = JSON.parse(holdRaw);
    const ackMsg: OperatorAckMsg = dataRaw ? JSON.parse(dataRaw) : {};

    // Hold'u sil
    await this.writeRedis.del(holdKey);

    // Cached confidence + triage verilerini al
    const confCached   = await this.writeRedis.get(`confidence:${clusterId}`);
    const triageCached = await this.writeRedis.get(`triage:${clusterId}`);

    if (!confCached || !triageCached) {
      console.warn(`ReviewAgent: ${clusterId} için cache verisi eksik — hold release atlandı`);
      return;
    }

    const conf   = JSON.parse(confCached);
    const triage = JSON.parse(triageCached);

    const fakeConf: ConfidenceToReview = {
      cluster_id:       clusterId,
      confidence_score: conf.score,
      score_breakdown:  conf.breakdown,
      anomaly_flags:    conf.anomaly_flags ?? [],
      source_count:     holdData.source_count ?? 1,
      iteration_count:  holdData.total_iterations,
    };
    const fakeTriage: TriageResult = {
      cluster_id:        clusterId,
      triage_score:      triage.triage_score,
      event_type:        triage.event_type,
      extracted_persons: triage.extracted_persons,
      medical_urgency:   triage.medical_urgency,
      access_type:       triage.access_type,
      suggested_resources: triage.suggested_resources,
      criteria:          triage.criteria,
      reasoning:         triage.reasoning,
      model_version:     triage.model_version,
      iteration_count:   holdData.total_iterations,
    };

    if (ackMsg.action === "reject_hold") {
      // Operatör reddetti — DLQ'ya yaz, akışı durdur
      console.log("🚫 Operator hold reddetti: " + clusterId);
      await writeToDLQ(this.writeRedis, "review:hold", clusterId, holdData, "Operatör tarafından reddedildi");
      return;
    }

    // approve_hold veya escalate_now → ReviewApproved yayınla
    const isEscalated = ackMsg.action === "escalate_now";
    await this.publishApproved(clusterId, fakeTriage, fakeConf, holdData.total_iterations, true, isEscalated);
    console.log("✅ Operator onayli hold release: " + clusterId + " (" + ackMsg.action + ")");
  }
}
