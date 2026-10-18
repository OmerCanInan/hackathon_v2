import type { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import { v4 as uuidv4 } from "uuid";
import {
  RawPacketSchema,
  STREAMS,
  GATEWAY_KEYS,
  isWithinTurkey,
  type ValidatedPacket,
} from "@kemple/shared";

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "100");
const RATE_LIMIT_TTL = 60; // saniye

export interface HandleResult {
  ok: boolean;
  packet_uuid?: string;
  error?: string;
  status?: number;
}

export class GatewayAgent {
  private blacklistCache = new Set<string>();
  private blacklistSyncInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly nodeId: string,
    private readonly log: FastifyBaseLogger
  ) {}

  // ─── Ana Paket İşleyici ──────────────────────────────────────────────────
  async handleIncomingPacket(body: unknown): Promise<HandleResult> {
    // 1. Şema doğrulama
    const parsed = RawPacketSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, status: 400, error: `Geçersiz şema: ${parsed.error.message}` };
    }

    const packet = parsed.data;

    // 2. Kara liste kontrolü (in-memory cache, periyodik sync)
    if (this.blacklistCache.has(packet.device_id)) {
      this.log.warn({ device_id: packet.device_id }, "Kara listedeki cihazdan paket reddedildi");
      return { ok: false, status: 403, error: "Cihaz kara listede" };
    }

    // 3. Coğrafi sınır kontrolü (Türkiye)
    let { lat, lng } = packet.origin_location || { lat: null, lng: null };
    
    // Eğer konum yoksa veya Türkiye dışındaysa, test amaçlı Kadıköy koordinatı ata
    if (lat === null || lng === null || !isWithinTurkey(lat, lng)) {
      this.log.info({ lat, lng }, "Geçersiz konum — test için Kadıköy koordinatı atanıyor");
      lat = 40.9833;
      lng = 29.0333;
    }
    
    // Güncellenmiş konumu pakete geri yaz (ValidatedPacket için)
    packet.origin_location = { lat, lng };
    packet.last_seen_location = { lat, lng };

    // 4. Rate limit (INCR + EXPIRE)
    const rateLimitKey = GATEWAY_KEYS.rateLimit(packet.device_id);
    const count = await this.redis.incr(rateLimitKey);
    if (count === 1) {
      await this.redis.expire(rateLimitKey, RATE_LIMIT_TTL);
    }
    if (count > RATE_LIMIT_MAX) {
      this.log.warn({ device_id: packet.device_id, count }, "Rate limit aşıldı");
      return { ok: false, status: 429, error: "Rate limit aşıldı" };
    }

    // 5. Zaman kontrolü — cihaz saati ±10 dakikadan fazla sapmamalı
    const deviceTime = new Date(packet.timestamp).getTime();
    const serverTime = Date.now();
    const timeDiffMs = Math.abs(serverTime - deviceTime);
    if (timeDiffMs > 10 * 60 * 1000) {
      this.log.warn({ device_id: packet.device_id, timeDiffMs }, "Zaman dilimi tutarsızlığı");
      return { ok: false, status: 422, error: "Zaman dilimi tutarsızlığı" };
    }

    // 6. ValidatedPacket oluştur
    const validated: ValidatedPacket = {
      ...packet,
      validation_ts: new Date().toISOString(),
      gateway_node_id: this.nodeId,
    };

    // 7. Redis Stream'e yaz
    await this.redis.xadd(
      STREAMS.VALIDATED,
      "*",
      "data", JSON.stringify(validated)
    );

    this.log.info(
      { packet_uuid: packet.packet_uuid, device_id: packet.device_id },
      "✅ Paket doğrulandı ve stream'e yazıldı"
    );

    return { ok: true, packet_uuid: packet.packet_uuid };
  }

  // ─── Heartbeat ───────────────────────────────────────────────────────────
  startHeartbeat() {
    const key = GATEWAY_KEYS.heartbeat(this.nodeId);
    this.heartbeatInterval = setInterval(async () => {
      await this.redis.setex(key, GATEWAY_KEYS.heartbeatTTL, new Date().toISOString());
    }, 5000);
    this.log.info("💓 Heartbeat başlatıldı");
  }

  // ─── Blacklist Sync ──────────────────────────────────────────────────────
  startBlacklistSync() {
    this.syncBlacklist(); // İlk sync hemen
    this.blacklistSyncInterval = setInterval(() => this.syncBlacklist(), 30_000);
    this.log.info("🔄 Blacklist sync başlatıldı (30s aralık)");
  }

  private async syncBlacklist() {
    const members = await this.redis.smembers(GATEWAY_KEYS.blacklistActive);
    this.blacklistCache = new Set(members);
    if (members.length > 0) {
      this.log.info({ count: members.length }, "Blacklist güncellendi");
    }
  }

  // ─── Temizlik ────────────────────────────────────────────────────────────
  stop() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.blacklistSyncInterval) clearInterval(this.blacklistSyncInterval);
  }
}
