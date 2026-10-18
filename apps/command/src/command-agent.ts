import type { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import {
  STREAMS,
  CONSUMER_GROUPS,
  STORAGE_KEYS,
  COMMAND_KEYS,
  type ReviewItem,
  type OperatorDecisionMsg,
  type DeadZoneAlert,
} from "@kemple/shared";

const CONSUMER_NAME = `command-${uuidv4().slice(0, 8)}`;

type WsMessage =
  | { type: "NEW_ITEM";      payload: ReviewItem }
  | { type: "DEAD_ZONE";    payload: DeadZoneAlert }
  | { type: "STATS";        payload: Record<string, unknown> }
  | { type: "QUEUE_INIT";   payload: ReviewItem[] }
  | { type: "ACK";          payload: { cluster_id: string; decision: string } }
  | { type: "OPERATOR_HOLD"; payload: OperatorHoldPayload };

interface OperatorHoldPayload {
  cluster_id:       string;
  final_triage:     number;
  final_confidence: number;
  anomaly_flags:    string[];
  total_iterations: number;
  held_at:          string;
}

export class CommandAgent {
  private clients = new Set<WebSocket>();
  private running = false;
  private lastDeadZoneId = "0-0";
  private lastHoldId = "0-0";

  constructor(
    private readonly redis: Redis,
    private readonly consumerRedis: Redis,
    private readonly log: FastifyBaseLogger
  ) {}

  registerClient(socket: WebSocket) {
    this.clients.add(socket);
    this.redis.incr(COMMAND_KEYS.wsConnections);

    this.getQueue().then(queue => {
      this.sendToSocket(socket, { type: "QUEUE_INIT", payload: queue });
    });
  }

  unregisterClient(socket: WebSocket) {
    this.clients.delete(socket);
    this.redis.decr(COMMAND_KEYS.wsConnections);
  }

  private broadcast(msg: WsMessage) {
    const raw = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(raw);
      }
    }
  }

  private sendToSocket(socket: WebSocket, msg: WsMessage) {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(msg));
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.consumeLoop();
  }

  private async consumeLoop() {
    const { stream, group } = CONSUMER_GROUPS.STORAGE;

    while (this.running) {
      try {
        const results = await this.consumerRedis.xreadgroup(
          "GROUP", group, CONSUMER_NAME,
          "COUNT", "10",
          "BLOCK", "1000",
          "STREAMS", stream, ">"
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (results) {
          for (const [, messages] of results) {
            for (const [msgId, fields] of messages) {
              const data = fields[fields.indexOf("data") + 1];
              const item: ReviewItem = JSON.parse(data);
              this.broadcast({ type: "NEW_ITEM", payload: item });
              await this.consumerRedis.xack(stream, group, msgId);
            }
          }
        }

        await this.consumeDeadZones();
        await this.consumeHoldCreated();

      } catch (err) {
        this.log.error(err, "CommandAgent döngü hatası");
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  private async consumeDeadZones() {
    try {
      const results = await this.redis.xread(
        "COUNT", "5",
        "STREAMS", STREAMS.DEAD_ZONE, this.lastDeadZoneId
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results) return;

      for (const [, messages] of results) {
        for (const [msgId, fields] of messages) {
          const data = fields[fields.indexOf("data") + 1];
          const alert: DeadZoneAlert = JSON.parse(data);
          this.broadcast({ type: "DEAD_ZONE", payload: alert });
          this.lastDeadZoneId = msgId;
        }
      }
    } catch { /* stream yok */ }
  }

  private async consumeHoldCreated() {
    try {
      const results = await this.redis.xread(
        "COUNT", "5",
        "STREAMS", STREAMS.OPERATOR_ACK, this.lastHoldId
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results) return;

      for (const [, messages] of results) {
        for (const [msgId, fields] of messages) {
          const type      = fields[fields.indexOf("type") + 1];
          const data      = fields[fields.indexOf("data") + 1];

          if (type === "HOLD_CREATED" && data) {
            this.broadcast({ type: "OPERATOR_HOLD", payload: JSON.parse(data) });
          }
          this.lastHoldId = msgId;
        }
      }
    } catch { /* stream yok */ }
  }

  async handleOperatorMessage(body: unknown): Promise<{ ok: boolean }> {
    const msg = body as Partial<OperatorDecisionMsg> & {
      action?: "approve_hold" | "reject_hold" | "escalate_now";
    };
    if (!msg.cluster_id || !msg.decision || !msg.operator_id) return { ok: false };

    if (msg.action === "approve_hold" || msg.action === "reject_hold" || msg.action === "escalate_now") {
      await this.redis.xadd(STREAMS.OPERATOR_ACK, "*", "type", "HOLD_RELEASE", "cluster_id", msg.cluster_id, "data", JSON.stringify({
        cluster_id: msg.cluster_id,
        action: msg.action,
        operator_id: msg.operator_id,
        decided_at: new Date().toISOString(),
      }));
      this.broadcast({ type: "ACK", payload: { cluster_id: msg.cluster_id, decision: msg.action } });
      return { ok: true };
    }

    const decision: OperatorDecisionMsg = {
      cluster_id: msg.cluster_id,
      decision: msg.decision,
      override_triage_score: msg.override_triage_score,
      override_confidence_score: msg.override_confidence_score,
      reason: msg.reason,
      operator_id: msg.operator_id,
      decided_at: new Date().toISOString(),
    };
    await this.redis.xadd(STREAMS.OPERATOR, "*", "data", JSON.stringify(decision));
    this.broadcast({ type: "ACK", payload: { cluster_id: msg.cluster_id, decision: msg.decision } });
    return { ok: true };
  }

  async getQueue(): Promise<ReviewItem[]> {
    const activeMembers = await this.redis.zrevrange(STORAGE_KEYS.triageQueue, 0, 499, "WITHSCORES");
    const activeItems = await this.buildReviewItems(activeMembers, false);

    const holdMembers = await this.redis.zrevrange(STORAGE_KEYS.holdQueue, 0, 499, "WITHSCORES");
    const holdItems = await this.buildReviewItems(holdMembers, true);

    const holdIds = new Set(holdItems.map(i => i.cluster_id));
    return [...holdItems, ...activeItems.filter(i => !holdIds.has(i.cluster_id))];
  }

  private async buildReviewItems(members: string[], isHolding: boolean): Promise<ReviewItem[]> {
    if (members.length === 0) return [];
    const items: ReviewItem[] = [];
    const clusterIds: string[] = [];
    const scores: Record<string, number> = {};

    for (let i = 0; i < members.length; i += 2) {
      const cid = members[i];
      clusterIds.push(cid);
      scores[cid] = parseFloat(members[i + 1]) / 100;
    }

    const [triageData, confData, metaData] = await Promise.all([
      this.redis.mget(...clusterIds.map(id => `triage:${id}`)),
      this.redis.mget(...clusterIds.map(id => `confidence:${id}`)),
      this.redis.mget(...clusterIds.map(id => `cluster:meta:${id}`))
    ]);

    for (let i = 0; i < clusterIds.length; i++) {
      const cid = clusterIds[i];
      if (!triageData[i] || !metaData[i]) continue;
      const triage = JSON.parse(triageData[i]!);
      const conf = confData[i] ? JSON.parse(confData[i]!) : { score: 50 };
      const meta = JSON.parse(metaData[i]!);

      items.push({
        cluster_id: cid,
        triage_score: scores[cid],
        confidence_score: conf.score || conf.confidence_score,
        review_status: isHolding ? "pending" : "approved",
        escalated: false,
        event_type: triage.event_type,
        extracted_persons: triage.extracted_persons,
        centroid: { lat: meta.centroid_lat, lng: meta.centroid_lng },
        enqueued_at: meta.first_seen || new Date().toISOString(),
        source_count: meta.source_count ?? 1,
        raw_payloads: meta.raw_payloads ?? [],
        reasoning: triage.reasoning || null,
        enriched_text: triage.enriched_text || null,
        isHolding: isHolding,
      } as any);
    }
    return items;
  }

  async getEscalated(): Promise<ReviewItem[]> {
    const members = await this.redis.zrevrange(STORAGE_KEYS.escalatedQueue, 0, 499, "WITHSCORES");
    return this.buildReviewItems(members, false);
  }

  async getDeadZones(): Promise<string[]> {
    return this.redis.smembers(STORAGE_KEYS.deadZones);
  }

  // Demo: direkt inject
  async injectReviewItem(body: unknown): Promise<void> {
    const item = body as ReviewItem;
    await this.redis.xadd(STREAMS.REVIEW_ITEM, "*", "data", JSON.stringify(item));
    this.broadcast({ type: "NEW_ITEM", payload: item });

    // ZSET'e ekle
    await this.redis.zadd(
      item.escalated ? STORAGE_KEYS.escalatedQueue : STORAGE_KEYS.triageQueue,
      item.triage_score * 100,
      item.cluster_id
    );
  }
}
