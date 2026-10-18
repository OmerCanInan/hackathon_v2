import Redis from "ioredis";

export function createRedisClient(): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  client.on("connect", () => console.log("✅ Redis bağlandı"));
  client.on("error", (err) => console.error("❌ Redis hatası:", err.message));

  return client;
}
