import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createRedisClient } from "./lib/redis.js";
import { GatewayAgent } from "./gateway-agent.js";

const PORT = parseInt(process.env.GATEWAY_PORT ?? "3001");
const NODE_ID = process.env.GATEWAY_NODE_ID ?? "gateway-1";

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
    },
  },
});

await fastify.register(cors, { origin: true });

const redis = createRedisClient();
const agent = new GatewayAgent(redis, NODE_ID, fastify.log);

// ─── Routes ──────────────────────────────────────────────────────────────────

// Sağlık kontrolü
fastify.get("/health", async () => ({
  status: "ok",
  node_id: NODE_ID,
  ts: new Date().toISOString(),
}));

// Ana paket endpoint — mobil PWA buraya gönderir
fastify.post("/api/packet", async (request, reply) => {
  const result = await agent.handleIncomingPacket(request.body);
  if (!result.ok) {
    return reply.status(result.status ?? 400).send({ error: result.error });
  }
  return reply.status(202).send({ accepted: true, packet_uuid: result.packet_uuid });
});

// Simülatör endpoint — demo için toplu paket gönderimi
fastify.post("/api/simulate", async (request, reply) => {
  const packets = request.body as unknown[];
  const results = await Promise.all(
    packets.map((p) => agent.handleIncomingPacket(p))
  );
  return reply.send({ results });
});

// Blacklist sorgulama (debug)
fastify.get("/api/blacklist", async () => {
  const members = await redis.smembers("blacklist:active");
  return { blacklisted: members };
});

// ─── Start ───────────────────────────────────────────────────────────────────
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  fastify.log.info(`🚀 GatewayAgent [${NODE_ID}] port ${PORT}'de dinliyor`);

  // Heartbeat
  agent.startHeartbeat();
  agent.startBlacklistSync();
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
