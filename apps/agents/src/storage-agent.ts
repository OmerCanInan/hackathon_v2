import type { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import {
  STREAMS,
  CONSUMER_GROUPS,
  STORAGE_KEYS,
  type ReviewApproved,
  type OperatorDecisionMsg,
  type ReviewItem,
  type DeadZoneAlert,
} from "@kemple/shared";
import type { PrismaClient } from "@prisma/client";
import { writeToDLQ } from "./lib/redis.js";

const CONSUMER_NAME = `storage-${uuidv4().slice(0, 8)}`;

// Dead zone eşikleri (dakika)
const DEAD_ZONE_YELLOW = 30; // Kullanıcı isteği: 30 dk sessizlik
const DEAD_ZONE_ORANGE = 60;
const DEAD_ZONE_BLACK  = 120;

// Grid hücre boyutu: ~50m (Kullanıcı isteği: 50x50)
const GRID_SIZE_DEG = 0.0005; 

export class StorageAgent {
  private deadZoneTimer:       ReturnType<typeof setInterval> | null = null;
  private anonymizationTimer:  ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly consumerRedis: Redis,
    private readonly writeRedis: Redis,
    private readonly prisma: PrismaClient
  ) {}

  async start(): Promise<void> {
    console.log("💾 StorageAgent başladı");

    // Dead zone tarama timer'ı
    this.deadZoneTimer = setInterval(() => this.scanDeadZones(), 60_000);
    this.scanDeadZones(); // İlk tarama hemen

    // KVKK — 90 günlük anonimleştirme (her 24 saatte bir)
    this.anonymizationTimer = setInterval(() => this.anonymizeOldPackets(), 24 * 60 * 60_000);
    setTimeout(() => this.anonymizeOldPackets(), 5 * 60_000); // Açılış yükünü azaltmak için 5 dk geciktir

    while (true) {
      try {
        await Promise.all([
          this.consumeReviewApproved(),
          this.consumeOperatorDecisions(),
        ]);
      } catch (err) {
        console.error("StorageAgent döngü hatası:", err);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  // ─── Review Approved stream ───────────────────────────────────────────────
  private async consumeReviewApproved(): Promise<void> {
    const { stream, group } = CONSUMER_GROUPS.REVIEW;
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
          const approved: ReviewApproved = JSON.parse(data);
          await this.handleReviewApproved(approved);
          await this.consumerRedis.xack(stream, group, msgId);
        } catch (err) {
          await writeToDLQ(this.writeRedis, stream, msgId, {}, String(err));
          await this.consumerRedis.xack(stream, group, msgId);
        }
      }
    }
  }

  private async handleReviewApproved(approved: ReviewApproved): Promise<void> {
    // 1. Cluster meta'sından centroid al
    const clusterMeta = await this.writeRedis.get(`cluster:meta:${approved.cluster_id}`);
    let centroid: { lat: number | null; lng: number | null } = { lat: null, lng: null };
    let eventType = "BELIRSIZ";
    let extractedPersons: number | null = null;

    if (clusterMeta) {
      const meta = JSON.parse(clusterMeta);
      centroid = { lat: meta.centroid_lat ?? null, lng: meta.centroid_lng ?? null };

      // Grid last seen güncelle (Eğer konum varsa)
      if (centroid.lat !== null && centroid.lng !== null) {
        const gridId = this.latlngToGrid(centroid.lat, centroid.lng);
        await this.writeRedis.hset(STORAGE_KEYS.gridLastSeen, gridId, new Date().toISOString());
      }

      // ── KRİTİK: Cluster kaydını PostgreSQL'e yaz (FK bağımlılığı için) ─────
      await this.prisma.cluster.upsert({
        where: { cluster_id: approved.cluster_id },
        update: {
          centroid_lat: centroid.lat,
          centroid_lng: centroid.lng,
          source_count: meta.source_count,
          packet_count: meta.packet_count,
          last_updated: new Date(),
        },
        create: {
          cluster_id: approved.cluster_id,
        centroid_lat: (centroid.lat as number | null),
        centroid_lng: (centroid.lng as number | null),
          source_count: meta.source_count,
          packet_count: meta.packet_count,
          first_seen: new Date(meta.first_seen),
        },
      }).catch((err: unknown) =>
        console.warn("Cluster upsert hatası:", err)
      );
    }


    // Triage sonucundan event_type al
    const triageCached = await this.writeRedis.get(`triage:${approved.cluster_id}`);
    if (triageCached) {
      const triage = JSON.parse(triageCached);
      eventType = triage.event_type;
      extractedPersons = triage.extracted_persons;
    }

    // 2. Triage kuyruğuna ekle (ZSET, skor = triage_score * 100)
    const queueKey = approved.escalated
      ? STORAGE_KEYS.escalatedQueue
      : STORAGE_KEYS.triageQueue;

    await this.writeRedis.zadd(queueKey, approved.final_triage_score * 100, approved.cluster_id);

    // 3. ReviewItem oluştur → CommandAgent stream'ine yaz
    const reviewItem: any = {
      cluster_id: approved.cluster_id,
      triage_score: approved.final_triage_score,
      confidence_score: approved.final_confidence_score,
      review_status: approved.review_status,
      escalated: approved.review_status === "escalated",
      escalation_reason: approved.escalation_reason,
      event_type: eventType as any,
      extracted_persons: extractedPersons,
      centroid: centroid as any,
      enqueued_at: new Date().toISOString(),
      source_count: clusterMeta ? JSON.parse(clusterMeta).source_count : 1,
      raw_payloads: clusterMeta ? JSON.parse(clusterMeta).raw_payloads : [],
      reasoning: triageCached ? JSON.parse(triageCached).reasoning : null,
    };

    await this.writeRedis.xadd(STREAMS.REVIEW_ITEM, "*", "data", JSON.stringify(reviewItem));

    // 4. Final bayraklarını PostgreSQL'de güncellerken transaction ile race condition'ı engelle
    try {
      await this.prisma.$transaction([
        this.prisma.confidenceScore.updateMany({
          where: { cluster_id: approved.cluster_id },
          data: { is_final: false },
        }),
        this.prisma.triageResult.updateMany({
          where: { cluster_id: approved.cluster_id },
          data: { is_final: false },
        }),
        this.prisma.confidenceScore.updateMany({
          where: { cluster_id: approved.cluster_id, iteration_count: approved.total_iterations },
          data: { is_final: true },
        }),
        this.prisma.triageResult.updateMany({
          where: { cluster_id: approved.cluster_id, iteration_count: approved.total_iterations },
          data: { is_final: true },
        }),
      ]);
    } catch (err) {
      console.warn("StorageAgent is_final transaction error:", err);
    }

    console.log(
      `💾 StorageAgent: ${approved.cluster_id} kuyruğa alındı ` +
      `(triage:${approved.final_triage_score}, conf:${approved.final_confidence_score})`
    );
  }

  // ─── Operator Decisions stream ────────────────────────────────────────────
  private async consumeOperatorDecisions(): Promise<void> {
    const { stream, group } = CONSUMER_GROUPS.OPERATOR;
    const results = await this.writeRedis.xreadgroup(
      "GROUP", group, CONSUMER_NAME,
      "COUNT", "10",
      "BLOCK", "100",
      "STREAMS", stream, ">"
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!results) return;

    for (const [, messages] of results) {
      for (const [msgId, fields] of messages) {
        try {
          const data = fields[fields.indexOf("data") + 1];
          const decision: OperatorDecisionMsg = JSON.parse(data);
          await this.handleOperatorDecision(decision);
          await this.writeRedis.xack(stream, group, msgId);
        } catch (err) {
          await writeToDLQ(this.writeRedis, stream, msgId, {}, String(err));
          await this.writeRedis.xack(stream, group, msgId);
        }
      }
    }
  }

  private async handleOperatorDecision(decision: OperatorDecisionMsg): Promise<void> {
    // Reputation güncelle
    const repDelta = decision.decision === "approve" ? 0.1 :
                     decision.decision === "reject"  ? -0.2 : 0;

    if (repDelta !== 0) {
      // Cluster'daki device_id'leri bul
      const meta = await this.writeRedis.get(`cluster:meta:${decision.cluster_id}`);
      if (meta) {
        const { device_ids } = JSON.parse(meta);
        for (const deviceId of device_ids) {
          const currentRep = parseFloat(
            (await this.writeRedis.hget(STORAGE_KEYS.deviceReputation, deviceId)) ?? "0.5"
          );
          const newRep = Math.max(0, Math.min(1, currentRep + repDelta));
          await this.writeRedis.hset(STORAGE_KEYS.deviceReputation, deviceId, newRep.toFixed(3));

          // Kara liste eşiği
          if (newRep < 0.1) {
            await this.writeRedis.sadd("blacklist:active", deviceId);
            console.warn(`⛔ Device kara listeye alındı: ${deviceId}`);
          }
        }
      }
    }

    // Kuyruğu güncelle (Onay veya Bekletme durumunda ana kuyruktan çıkar)
    if (decision.decision === "approve") {
      await this.writeRedis.zrem(STORAGE_KEYS.triageQueue, decision.cluster_id);
      await this.writeRedis.zrem(STORAGE_KEYS.escalatedQueue, decision.cluster_id);
      await this.writeRedis.zrem(STORAGE_KEYS.holdQueue, decision.cluster_id);
    } else if (decision.decision === "hold") {
      // Ana kuyruktan çıkar, bekleme kuyruğuna taşı
      const triageCached = await this.writeRedis.get(`triage:${decision.cluster_id}`);
      const score = triageCached ? JSON.parse(triageCached).triage_score * 100 : 0;
      
      await this.writeRedis.zrem(STORAGE_KEYS.triageQueue, decision.cluster_id);
      await this.writeRedis.zrem(STORAGE_KEYS.escalatedQueue, decision.cluster_id);
      await this.writeRedis.zadd(STORAGE_KEYS.holdQueue, score, decision.cluster_id);
    }

    // PostgreSQL'e audit yaz
    // Snapshot değerlerini al
    const triageCached = await this.writeRedis.get(`triage:${decision.cluster_id}`);
    const confCached = await this.writeRedis.get(`confidence:${decision.cluster_id}`);
    const snapshotTriage = triageCached ? JSON.parse(triageCached).triage_score ?? 0 : 0;
    const snapshotConf = confCached ? JSON.parse(confCached).score ?? 0 : 0;

    await this.prisma.operatorDecision.create({
      data: {
        cluster_id: decision.cluster_id,
        operator_id: decision.operator_id,
        decision: decision.decision,
        override_triage_score: decision.override_triage_score ?? null,
        override_confidence_score: decision.override_confidence_score ?? null,
        reason: decision.reason ?? null,
        snapshot_triage_score: snapshotTriage,
        snapshot_confidence_score: snapshotConf,
        snapshot_review_status: decision.decision,
      },
    }).catch(() => {});

    console.log(`🎯 Operatör kararı: ${decision.cluster_id} → ${decision.decision}`);
  }

  // ─── Dead Zone Tespiti ────────────────────────────────────────────────────
  private async scanDeadZones(): Promise<void> {
    const gridData = await this.writeRedis.hgetall(STORAGE_KEYS.gridLastSeen);
    const now = Date.now();

    for (const [gridId, lastSeenStr] of Object.entries(gridData)) {
      const silentMins = Math.floor((now - new Date(lastSeenStr as string).getTime()) / 60_000);

      let severity: "YELLOW" | "ORANGE" | "BLACK" | null = null;
      if (silentMins >= DEAD_ZONE_BLACK) severity = "BLACK";
      else if (silentMins >= DEAD_ZONE_ORANGE) severity = "ORANGE";
      else if (silentMins >= DEAD_ZONE_YELLOW) severity = "YELLOW";

      // Aktivite geri geldiyse ölü bölgeyi kaldır
      if (!severity) {
        await this.writeRedis.srem(STORAGE_KEYS.deadZones, gridId);
        continue;
      }

      // Zaten aktif dead zone var mı?
      const alreadyActive = await this.writeRedis.sismember(STORAGE_KEYS.deadZones, gridId);
      if (alreadyActive) continue;

      await this.writeRedis.sadd(STORAGE_KEYS.deadZones, gridId);

      const centroid = this.gridToLatLng(gridId);
      const alert: DeadZoneAlert = {
        grid_cell_id: gridId,
        silent_duration_mins: silentMins,
        centroid,
        suggested_action: "Keşif aracı gönder",
        severity,
        detected_at: new Date().toISOString(),
      };

      await this.writeRedis.xadd(STREAMS.DEAD_ZONE, "*", "data", JSON.stringify(alert));
      console.warn(`⚠️ Ölü bölge tespit edildi: ${gridId} (${silentMins} dk, ${severity})`);
    }
  }

  private latlngToGrid(lat: number, lng: number): string {
    const gridLat = Math.floor(lat / GRID_SIZE_DEG);
    const gridLng = Math.floor(lng / GRID_SIZE_DEG);
    return `GRID-${gridLat}-${gridLng}`;
  }

  private gridToLatLng(gridId: string): { lat: number; lng: number } {
    const parts = gridId.replace("GRID-", "").split("-");
    return {
      lat: parseInt(parts[0]) * GRID_SIZE_DEG + GRID_SIZE_DEG / 2,
      lng: parseInt(parts[1]) * GRID_SIZE_DEG + GRID_SIZE_DEG / 2,
    };
  }

  // ─── KVKK — 90 Günlük Anonimleştirme ──────────────────────────────────────────
  private async anonymizeOldPackets(): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);

    try {
      // 90 günden eski, henüz anonimleştirilmemiş paketleri bul
      const oldPackets = await this.prisma.packet.findMany({
        where: {
          gateway_received_at: { lt: cutoffDate },
          is_anonymized: false,
        },
        select: { packet_uuid: true },
        take: 500, // Her çalışmada max 500
      });

      if (oldPackets.length === 0) return;

      const uuids = oldPackets.map((p: { packet_uuid: string }) => p.packet_uuid);

      // Payload ve konum verilerini temizle
      await this.prisma.packet.updateMany({
        where: { packet_uuid: { in: uuids } },
        data: {
          payload: "[KVKK-ANON]",
          origin_lat: null as any,
          origin_lng: null as any,
          last_seen_lat: null as any,
          last_seen_lng: null as any,
          is_anonymized: true,
          anonymized_at: new Date(),
        },
      });

      console.log(`🔒 KVKK: ${uuids.length} paket anonimleştirildi (90 gün kuralı)`);
    } catch (err) {
      console.error("Anonimleştirme hatası:", err);
    }
  }
}
