import Redis from "ioredis";
import { CONSUMER_GROUPS, STREAMS } from "@kemple/shared";

export function createRedisClient(): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

// Tüm consumer group'larını oluştur (yoksa)
export async function ensureConsumerGroups(redis: Redis): Promise<void> {
  for (const cfg of Object.values(CONSUMER_GROUPS)) {
    try {
      await redis.xgroup("CREATE", cfg.stream, cfg.group, "$", "MKSTREAM");
      console.log(`✅ Consumer group oluşturuldu: ${cfg.group} @ ${cfg.stream}`);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("BUSYGROUP")) {
        // Zaten mevcut, sorun yok
      } else {
        console.warn(`⚠️ Consumer group oluşturulamadı: ${cfg.group}`, err);
      }
    }
  }

  // DLQ stream oluştur
  try {
    await redis.xgroup("CREATE", STREAMS.DLQ, "dlq-consumers", "$", "MKSTREAM");
  } catch { /* ignore */ }
}

// Dead Letter Queue'ya yaz
export async function writeToDLQ(
  redis: Redis,
  streamName: string,
  messageId: string,
  payload: unknown,
  errorMessage: string
): Promise<void> {
  await redis.xadd(
    STREAMS.DLQ,
    "*",
    "stream_name", streamName,
    "message_id", messageId,
    "payload", JSON.stringify(payload),
    "error", errorMessage,
    "failed_at", new Date().toISOString()
  );
}
