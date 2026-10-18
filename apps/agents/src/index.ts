import "dotenv/config";
import { createRedisClient, ensureConsumerGroups } from "./lib/redis.js";
import { prisma } from "./lib/prisma.js";
import { IntakeAgent }         from "./intake-agent.js";
import { DeduplicationAgent } from "./dedup-agent.js";
import { ConfidenceAgent }    from "./confidence-agent.js";
import { TriageAgent }        from "./triage-agent.js";
import { ReviewAgent }        from "./review-agent.js";
import { StorageAgent }       from "./storage-agent.js";

console.log("🚀 KEMPLE Agents başlatılıyor...");

const redis = createRedisClient();

// Consumer group'larını oluştur (yoksa)
await ensureConsumerGroups(redis);

// Her agent kendi redis consumer'ını kullanır (blocking okuma için ayrı bağlantı)
const intakeRedis  = createRedisClient();
const dedupRedis   = createRedisClient();
const confRedis    = createRedisClient();
const triageRedis  = createRedisClient();
const reviewRedis  = createRedisClient();
const storeRedis   = createRedisClient();

const intake     = new IntakeAgent(intakeRedis, redis);
const dedup      = new DeduplicationAgent(dedupRedis,  redis);
const confidence = new ConfidenceAgent(confRedis,   redis, prisma);
const triage     = new TriageAgent(triageRedis, redis, prisma);
const review     = new ReviewAgent(reviewRedis, redis, prisma);
const storage    = new StorageAgent(storeRedis, redis, prisma);

// Tüm ajanları paralel başlat
await Promise.all([
  intake.start(),   // Prompt → JSON zenginleştirme (IntakeAgent)
  dedup.start(),
  confidence.start(),
  triage.start(),
  review.start(),
  storage.start(),
]);

console.log("✅ Tüm ajanlar çalışıyor");

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("⏹️ Kapatılıyor...");
  await prisma.$disconnect();
  process.exit(0);
});
