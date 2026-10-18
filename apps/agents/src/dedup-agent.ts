import type { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import {
  STREAMS,
  CONSUMER_GROUPS,
  DEDUP_KEYS,
  haversineDistance,
  weightedCentroid,
  type ValidatedPacket,
  type ClusterEvent,
  STORAGE_KEYS,
} from "@kemple/shared";
import { writeToDLQ } from "./lib/redis.js";

const GRID_SIZE_DEG = 0.0005; // 50x50m

const CLUSTER_RADIUS_M  = parseInt(process.env.CLUSTER_RADIUS_M  ?? "50");
const CLUSTER_TIME_MS   = parseInt(process.env.CLUSTER_TIME_MS   ?? "1800000"); // 30 dk
const CONSUMER_NAME     = `dedup-${process.env.HOSTNAME ?? uuidv4().slice(0, 8)}`;

interface ClusterMeta {
  cluster_id: string;
  centroid_lat: number | null;
  centroid_lng: number | null;
  source_count: number;
  packet_count: number;
  first_seen: string;
  last_updated: string;
  device_ids: string[];
  raw_payloads: string[];
  enriched_payloads: string[];
  packet_uuids: string[];
  category: "FIRE" | "ENKAZ" | "MEDICAL" | "LOGISTIC" | "OTHER";
}

export class DeduplicationAgent {
  constructor(
    private readonly consumerRedis: Redis,  // blocking okuma
    private readonly writeRedis: Redis      // yazma
  ) {}

  async start(): Promise<void> {
    console.log("🔄 DeduplicationAgent başladı");
    const { stream, group } = CONSUMER_GROUPS.DEDUP_IN;

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
            await Promise.all(
              messages.map(([msgId, fields]) => 
                this.processMessage(msgId, fields, stream, group)
              )
            );
          }
        }
      } catch (err) {
        console.error("DeduplicationAgent döngü hatası:", err);
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
      const packet: ValidatedPacket = JSON.parse(data);

      // 1. Birebir UUID dedup (Bellek sızıntısı önleme: HSET yerine SETEX)
      const dedupKey = `dedup:packet:${packet.packet_uuid}`;
      const alreadySeen = await this.writeRedis.get(dedupKey);
      if (alreadySeen) {
        console.log(`⏭️ Duplicate paket atlandı: ${packet.packet_uuid}`);
        await this.consumerRedis.xack(stream, group, msgId);
        return;
      }

      // Grid aktivitesini anlık güncelle (Ölü bölge takibi için)
      await this.updateGridLastSeen(packet);

      // Görüldü olarak işaretle (24 saat TTL)
      await this.writeRedis.setex(dedupKey, 86400, "1");

      // 2. Coğrafi küme bul veya oluştur
      const clusterId = await this.findOrCreateCluster(packet);

      // IntakeAgent tarafından stream üzerinden eklenen zenginleştirilmiş metni kullan
      const payloadToSave = packet.enriched_text ?? packet.payload;
      const packetForMeta = { ...packet, payload: payloadToSave };

      // 3. Küme meta'sını güncelle ve ClusterEvent yay
      const clusterMeta = await this.updateClusterMeta(clusterId, packetForMeta);

      // 4. ClusterEvent'i stream'e yaz
      const clusterEvent: ClusterEvent = {
        cluster_id: clusterMeta.cluster_id,
        packet_uuids: clusterMeta.packet_uuids,
        device_ids: clusterMeta.device_ids,
        centroid: { lat: clusterMeta.centroid_lat, lng: clusterMeta.centroid_lng } as any,
        source_count: clusterMeta.source_count,
        first_seen: clusterMeta.first_seen,
        last_updated: clusterMeta.last_updated,
        raw_payloads: clusterMeta.raw_payloads,
        enriched_payloads: clusterMeta.enriched_payloads,
        iteration_count: 0,
      };

      await this.writeRedis.xadd(STREAMS.CLUSTER, "*", "data", JSON.stringify(clusterEvent));

      console.log(`📦 Küme güncellendi: ${clusterId} (${clusterMeta.source_count} kaynak)`);

      await this.consumerRedis.xack(stream, group, msgId);
    } catch (err) {
      console.error("DeduplicationAgent mesaj hatası:", err);
      await writeToDLQ(this.writeRedis, stream, msgId, {}, String(err));
      await this.consumerRedis.xack(stream, group, msgId);
    }
  }

  private async updateGridLastSeen(packet: ValidatedPacket) {
    if (packet.origin_location?.lat && packet.origin_location?.lng) {
      const gridId = this.latlngToGrid(packet.origin_location.lat, packet.origin_location.lng);
      await this.writeRedis.hset(STORAGE_KEYS.gridLastSeen, gridId, new Date().toISOString());
    }
  }

  private latlngToGrid(lat: number, lng: number): string {
    const gridLat = Math.floor(lat / GRID_SIZE_DEG);
    const gridLng = Math.floor(lng / GRID_SIZE_DEG);
    return `GRID-${gridLat}-${gridLng}`;
  }

  private async findOrCreateCluster(packet: ValidatedPacket): Promise<string> {
    if (!packet.origin_location || packet.origin_location.lat === null) {
      // Konum yoksa kümeleme yapma, yeni bir ID oluştur
      return this.generateNewClusterId();
    }

    const { lat, lng } = packet.origin_location;
    // GEO index: "geo:clusters" — her cluster_id burada kayıtlı
    try {
      const nearby = await this.writeRedis.call(
        "GEOSEARCH",
        DEDUP_KEYS.geoClusters,
        "FROMLONLAT", String(lng), String(lat),
        "BYRADIUS", String(CLUSTER_RADIUS_M), "m",
        "ASC",
        "COUNT", "10"
      ) as string[];

      const currentCategory = this.categorizePayload(packet.payload);

      for (const candidateId of nearby) {
        const raw = await this.writeRedis.get(DEDUP_KEYS.clusterMeta(candidateId));
        if (!raw) continue;

        const meta: ClusterMeta = JSON.parse(raw);
        const lastUpdated = new Date(meta.last_updated).getTime();

        // 30 dakika zaman penceresi VE kategori kontrolü
        if (Date.now() - lastUpdated <= CLUSTER_TIME_MS && meta.category === currentCategory) {
          return meta.cluster_id;
        }
      }
    } catch (geoErr) {
      // GEOSEARCH komutu yoksa (Redis < 6.2) fallback: GEORADIUS
      try {
        const nearby = await this.writeRedis.call(
          "GEORADIUS",
          DEDUP_KEYS.geoClusters,
          String(lng), String(lat),
          String(CLUSTER_RADIUS_M), "m",
          "ASC", "COUNT", "10"
        ) as string[];

        const currentCategory = this.categorizePayload(packet.payload);

        for (const candidateId of nearby) {
          const raw = await this.writeRedis.get(DEDUP_KEYS.clusterMeta(candidateId));
          if (!raw) continue;
          const meta: ClusterMeta = JSON.parse(raw);
          const lastUpdated = new Date(meta.last_updated).getTime();
          
          // Zaman VE Kategori kontrolü
          if (Date.now() - lastUpdated <= CLUSTER_TIME_MS && (meta.category || "OTHER") === currentCategory) {
            return meta.cluster_id;
          }
        }
      } catch {
        // Her iki GEO komutu da çalışmıyorsa log yaz, yeni küme oluştur
        console.warn("DeduplicationAgent: GEO komutları kullanılamıyor, yeni küme oluşturuluyor");
      }
    }

    // Yeni küme oluştur — mevcut sayıyı almak için GEO'daki üye sayısını kullan
    let clusterCount = 0;
    try {
      clusterCount = await this.writeRedis.zcard(DEDUP_KEYS.geoClusters);
    } catch { /* redis yoksa 0 */ }
    const clusterNum = (clusterCount + 1).toString().padStart(4, "0");
    return `A-${clusterNum}`;
  }

  private async generateNewClusterId(): Promise<string> {
    let clusterCount = 0;
    try {
      clusterCount = await this.writeRedis.zcard(DEDUP_KEYS.geoClusters);
    } catch { /* redis yoksa 0 */ }
    const clusterNum = (clusterCount + 1).toString().padStart(4, "0");
    return `U-${clusterNum}`; // Unknown location için U- prefix
  }

  private async updateClusterMeta(clusterId: string, packet: ValidatedPacket): Promise<ClusterMeta> {
    const key = DEDUP_KEYS.clusterMeta(clusterId);
    const existing = await this.writeRedis.get(key);

    const lat = packet.origin_location?.lat ?? null;
    const lng = packet.origin_location?.lng ?? null;

    if (!existing) {
      // Yeni küme
      const meta: ClusterMeta = {
        cluster_id: clusterId,
        centroid_lat: lat,
        centroid_lng: lng,
        source_count: 1,
        packet_count: 1,
        first_seen: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        device_ids: [packet.device_id],
        raw_payloads: [packet.payload],
        enriched_payloads: [packet.enriched_text ?? packet.payload],
        packet_uuids: [packet.packet_uuid],
        category: this.categorizePayload(packet.payload),
      };
      await this.writeRedis.setex(key, DEDUP_KEYS.clusterMetaTTL, JSON.stringify(meta));

      // ─── GEO index’e ekle (Eğer konum varsa) ───
      if (lat !== null && lng !== null) {
        await this.writeRedis.call("GEOADD", DEDUP_KEYS.geoClusters, String(lng), String(lat), clusterId)
          .catch((e: unknown) => console.warn("GEOADD hatası:", e));
      }

      return meta;
    }

    const meta: ClusterMeta = JSON.parse(existing);

    if (!meta.packet_uuids.includes(packet.packet_uuid)) {
      meta.packet_uuids.push(packet.packet_uuid);
      meta.device_ids.push(packet.device_id);
      meta.raw_payloads.push(packet.payload);
      meta.enriched_payloads = meta.enriched_payloads || [];
      meta.enriched_payloads.push(packet.enriched_text ?? packet.payload);
      
      const isNewDevice = !meta.device_ids.includes(packet.device_id);
      if (isNewDevice) {
        meta.source_count++;
      }
      meta.packet_count++;
    }

    meta.last_updated = new Date().toISOString();

    // Centroid'i ağırlıklı ortalama ile güncelle (Eğer konum varsa)
    if (lat !== null && lng !== null && meta.centroid_lat !== null && meta.centroid_lng !== null) {
      const points = [
        { lat: meta.centroid_lat, lng: meta.centroid_lng, weight: meta.packet_count - 1 },
        { lat, lng, weight: 1 },
      ];
      const newCentroid = weightedCentroid(points);
      meta.centroid_lat = newCentroid.lat;
      meta.centroid_lng = newCentroid.lng;

      // ─── GEO index centroid güncelle (GEOADD üzerine yazar) ───
      await this.writeRedis.call(
        "GEOADD", DEDUP_KEYS.geoClusters,
        String(newCentroid.lng), String(newCentroid.lat), clusterId
      ).catch((e: unknown) => console.warn("GEOADD güncelleme hatası:", e));
    }

    await this.writeRedis.setex(key, DEDUP_KEYS.clusterMetaTTL, JSON.stringify(meta));
    return meta;
  }

  private categorizePayload(payload: string): "FIRE" | "ENKAZ" | "MEDICAL" | "LOGISTIC" | "OTHER" {
    const p = payload.toLowerCase();
    
    if (/enkaz|mahsur|altında|çöktü|yıkıldı|göçük/.test(p)) {
      return "ENKAZ";
    }
    if (/yangın|alev|duman|patlama/.test(p)) {
      return "FIRE";
    }
    if (/kalp|kanama|yaralı|nefes|bayıldı|hasta|doğum/.test(p)) {
      return "MEDICAL";
    }
    if (/yemek|gıda|su|açız|çadır|battaniye|giysi|ekmek|mama/.test(p)) {
      return "LOGISTIC";
    }
    return "OTHER";
  }
}
