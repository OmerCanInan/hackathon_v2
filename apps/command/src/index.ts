import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Redis from "ioredis";
import { CommandAgent } from "./command-agent.js";

const PORT = parseInt(process.env.COMMAND_PORT ?? "3002");
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const fastify = Fastify({
  logger: {
    level: "info",
    transport: { target: "pino-pretty", options: { colorize: true, ignore: "pid,hostname" } },
  },
});

await fastify.register(cors, { origin: true });
await fastify.register(websocket);

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const consumerRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const agent = new CommandAgent(redis, consumerRedis, fastify.log);

// ─── WebSocket — Dashboard bağlantısı ────────────────────────────────────────
fastify.get("/ws", { websocket: true }, (socket) => {
  fastify.log.info("📡 Dashboard bağlandı");
  agent.registerClient(socket);

  socket.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      await agent.handleOperatorMessage(msg);
    } catch (err) {
      fastify.log.error(err, "WS mesaj hatası");
    }
  });

  socket.on("close", () => {
    agent.unregisterClient(socket);
    fastify.log.info("📡 Dashboard bağlantısı kesildi");
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────
fastify.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

// Triage kuyruğunu listele (Dashboard ilk yüklenişinde kullanır)
fastify.get("/api/queue", async () => {
  return agent.getQueue();
});

// Eskalasyon kuyruğu
fastify.get("/api/escalated", async () => {
  return agent.getEscalated();
});

// Operatör kararı REST üzerinden
fastify.post("/api/decision", async (request, reply) => {
  const result = await agent.handleOperatorMessage(request.body);
  return reply.send(result);
});

// Dead zones
fastify.get("/api/dead-zones", async () => {
  return agent.getDeadZones();
});

// Simülatör — direkt cluster oluştur (demo için)
fastify.post("/api/inject", async (request, reply) => {
  await agent.injectReviewItem(request.body);
  return reply.send({ ok: true });
});

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  fastify.log.info(`🚀 CommandAgent port ${PORT}'de (WS: ws://localhost:${PORT}/ws)`);

  // Stream consumer'ları başlat
  agent.start();
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
