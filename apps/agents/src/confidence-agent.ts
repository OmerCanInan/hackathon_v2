import type { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import {
  STREAMS,
  CONSUMER_GROUPS,
  CONFIDENCE_KEYS,
  STORAGE_KEYS,
  ANOMALY_RULES,
  type ClusterEvent,
  type ScoredEvent,
  type ConfidenceToReview,
  type ScoreBreakdown,
} from "@kemple/shared";

import type { PrismaClient } from "@prisma/client";
import { writeToDLQ } from "./lib/redis.js";

const CONSUMER_NAME = `confidence-${uuidv4().slice(0, 8)}`;

export class ConfidenceAgent {
  constructor(
    private readonly consumerRedis: Redis,
    private readonly writeRedis: Redis,
    private readonly prisma: PrismaClient
  ) {}

  async start(): Promise<void> {
    console.log("📊 ConfidenceAgent başladı");
    const { stream, group } = CONSUMER_GROUPS.DEDUP;

    while (true) {
      try {
        const results = await this.consumerRedis.xreadgroup(
          "GROUP", group, CONSUMER_NAME,
          "COUNT", "10",
          "BLOCK", "2000",
          "STREAMS", stream, ">"
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (results) {
          for (const [, messages] of results) {
            for (const [msgId, fields] of messages) {
              await this.processMessage(msgId, fields, stream, group);
            }
          }
        }

        // Revision stream'i de dinle
        await this.handleRevisions();

      } catch (err) {
        console.error("ConfidenceAgent döngü hatası:", err);
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
      const clusterEvent: ClusterEvent = JSON.parse(data);

      const scored = await this.scoreCluster(clusterEvent);

      // ScoredEvent → TriageAgent
      await this.writeRedis.xadd(STREAMS.SCORED, "*", "data", JSON.stringify(scored));

      // ConfidenceToReview → ReviewAgent
      const confToReview: ConfidenceToReview = {
        cluster_id: scored.cluster_id,
        confidence_score: scored.confidence_score,
        score_breakdown: scored.score_breakdown,
        anomaly_flags: scored.anomaly_flags,
        source_count: scored.source_count,
        iteration_count: scored.iteration_count,
      };
      await this.writeRedis.xadd(STREAMS.CONF_TO_REVIEW, "*", "data", JSON.stringify(confToReview));

      // Redis cache'e yaz
      await this.writeRedis.setex(
        CONFIDENCE_KEYS.score(scored.cluster_id),
        CONFIDENCE_KEYS.scoreTTL,
        JSON.stringify({
          score: scored.confidence_score,
          breakdown: scored.score_breakdown,
          anomaly_flags: scored.anomaly_flags,
          iteration_count: scored.iteration_count,
          computed_at: new Date().toISOString(),
        })
      );

      // ── KRİTİK: Cluster kaydını önce PG'ye yaz (FK bağımlılığı) ──────────
      await this.prisma.cluster.upsert({
        where: { cluster_id: clusterEvent.cluster_id },
        update: {
          centroid_lat: clusterEvent.centroid?.lat ?? null,
          centroid_lng: clusterEvent.centroid?.lng ?? null,
          source_count: clusterEvent.source_count,
          packet_count: clusterEvent.packet_uuids.length,
          last_updated: new Date(),
        },
        create: {
          cluster_id: clusterEvent.cluster_id,
          centroid_lat: clusterEvent.centroid?.lat ?? null,
          centroid_lng: clusterEvent.centroid?.lng ?? null,
          source_count: clusterEvent.source_count,
          packet_count: clusterEvent.packet_uuids.length,
          first_seen: new Date(clusterEvent.first_seen),
        },
      }).catch((err: unknown) => console.warn("Cluster upsert:", err));

      // PostgreSQL'e yaz
      await this.prisma.confidenceScore.upsert({
        where: { cluster_id_iteration_count: { cluster_id: scored.cluster_id, iteration_count: scored.iteration_count } },
        update: {
          confidence_score: scored.confidence_score,
          score_independent_sources: scored.score_breakdown.independent_sources,
          score_coord_consistency: scored.score_breakdown.coord_consistency,
          score_time_gap: scored.score_breakdown.time_gap_organic,
          score_operator_history: scored.score_breakdown.operator_history,
          score_sybil_penalty: scored.score_breakdown.sybil_penalty,
          score_blacklist_penalty: scored.score_breakdown.blacklist_penalty,
          anomaly_flags: scored.anomaly_flags,
        },
        create: {
          cluster_id: scored.cluster_id,
          iteration_count: scored.iteration_count,
          confidence_score: scored.confidence_score,
          score_independent_sources: scored.score_breakdown.independent_sources,
          score_coord_consistency: scored.score_breakdown.coord_consistency,
          score_time_gap: scored.score_breakdown.time_gap_organic,
          score_operator_history: scored.score_breakdown.operator_history,
          score_sybil_penalty: scored.score_breakdown.sybil_penalty,
          score_blacklist_penalty: scored.score_breakdown.blacklist_penalty,
          anomaly_flags: scored.anomaly_flags,
        },
      }).catch((err: unknown) => console.warn("ConfidenceScore write:", err));


      console.log(
        `✅ Confidence: ${scored.cluster_id} → ${scored.confidence_score.toFixed(1)} ` +
        `(flags: ${scored.anomaly_flags.join(", ") || "yok"})`
      );

      await this.consumerRedis.xack(stream, group, msgId);
    } catch (err) {
      console.error("ConfidenceAgent mesaj hatası:", err);
      await writeToDLQ(this.writeRedis, stream, msgId, {}, String(err));
      await this.consumerRedis.xack(stream, group, msgId);
    }
  }

  // ─── Bayesian Confidence Scoring ─────────────────────────────────────────
  private async scoreCluster(event: ClusterEvent): Promise<ScoredEvent> {
    let score = 40; // Başlangıç
    const breakdown: ScoreBreakdown = {
      independent_sources: 0,
      coord_consistency: 0,
      time_gap_organic: 0,
      operator_history: 0,
      sybil_penalty: 0,
      blacklist_penalty: 0,
    };
    const anomaly_flags: string[] = [];
    const device_reputations: Record<string, number> = {};

    // 1. Bağımsız kaynak sayısı (+12/kaynak, max +48)
    const sourceBonus = Math.min(4, event.source_count - 1) * 12;
    breakdown.independent_sources = sourceBonus;
    score += sourceBonus;

    // 2. Sybil tespiti — çok paket az device
    const packetCount = event.packet_uuids.length;
    if (packetCount >= 5 && event.source_count <= 2) {
      breakdown.sybil_penalty = -30;
      score -= 30;
      anomaly_flags.push("SYBIL_SUSPECT");
    }

    // 3. Zaman aralığı organikliği
    const firstTime = new Date(event.first_seen).getTime();
    const lastTime = new Date(event.last_updated).getTime();
    const timeDiffMs = lastTime - firstTime;
    if (timeDiffMs > 1000 && timeDiffMs < 20 * 60 * 1000) {
      breakdown.time_gap_organic = 8;
      score += 8;
    } else if (timeDiffMs <= ANOMALY_RULES.BOT_TIME_GAP_MS && packetCount > 1) {
      breakdown.time_gap_organic = -25;
      score -= 25;
      anomaly_flags.push("BOT_TIME_GAP");
    }

    // 4. Koordinat tutarlılığı (küme içi — basit yaklaşım)
    // Centroid'e uzaklık > 200m olan paket varsa sorun işareti
    // MVP'de tek centroid var, kaynak sayısına göre basit heuristik
    if (event.source_count >= 3) {
      breakdown.coord_consistency = 10;
      score += 10;
    } else if (event.source_count === 1) {
      breakdown.coord_consistency = 0;
    }

    // 5. Device reputation (Sadece bu kümedeki cihazlar için — Yanlış filtreleme düzeltildi)
    for (const deviceId of event.device_ids) {
      const repStr = await this.writeRedis.hget(STORAGE_KEYS.deviceReputation, deviceId);
      const rep = parseFloat(repStr ?? "0.5");
      device_reputations[deviceId] = rep;

      if (rep < ANOMALY_RULES.BLACKLIST_THRESHOLD) {
        breakdown.blacklist_penalty = -40;
        score -= 40;
        anomaly_flags.push(`BLACKLISTED_DEVICE:${deviceId}`);
      }
    }

    // 6. Operatör geçmişi (son 24 saat)
    // Redis'te operatör kararı cache'i yok henüz — sonraki iterasyonlarda eklenir
    breakdown.operator_history = 0;

    // Skor sınırları [0-100]
    score = Math.max(0, Math.min(100, score));

    return {
      ...event,
      confidence_score: Math.round(score * 10) / 10,
      score_breakdown: breakdown,
      anomaly_flags,
      device_reputations,
    };
  }

  // ─── Revision talebi dinleyici ───────────────────────────────────────────
  private async handleRevisions(): Promise<void> {
    const { stream, group } = CONSUMER_GROUPS.REVISION_CONFIDENCE;
    const revisionStream = STREAMS.REVISION;

    try {
      const results = await this.writeRedis.xreadgroup(
        "GROUP", group, CONSUMER_NAME,
        "COUNT", "5",
        "BLOCK", "100",
        "STREAMS", revisionStream, ">"
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results) return;

      for (const [, messages] of results) {
        for (const [msgId, fields] of messages) {
          const data = fields[fields.indexOf("data") + 1];
          const revision = JSON.parse(data);

          if (revision.target_agent !== "ConfidenceAgent") {
            await this.writeRedis.xack(revisionStream, group, msgId);
            continue;
          }

          console.log(`🔄 ConfidenceAgent revizyon alındı: ${revision.cluster_id}`);
          // Mevcut cluster event'ini yeniden al ve yeniden skorla
          const cached = await this.writeRedis.get(`cluster:meta:${revision.cluster_id}`);
          if (cached) {
            const meta = JSON.parse(cached);
            const fakeEvent: ClusterEvent = {
              cluster_id: revision.cluster_id,
              packet_uuids: meta.packet_uuids,
              device_ids: meta.device_ids ?? [],
              centroid: { lat: meta.centroid_lat, lng: meta.centroid_lng },
              source_count: meta.source_count,
              first_seen: meta.first_seen,
              last_updated: meta.last_updated,
              raw_payloads: meta.raw_payloads,
              iteration_count: revision.iteration_count + 1,
            };
            const scored = await this.scoreCluster(fakeEvent);
            await this.writeRedis.xadd(STREAMS.SCORED, "*", "data", JSON.stringify(scored));
          }

          await this.writeRedis.xack(revisionStream, group, msgId);
        }
      }
    } catch { /* revision stream henüz yok olabilir */ }
  }
}
