// ─── Redis Şema Sabitleri ─────────────────────────────────────────────────────

export const GATEWAY_KEYS = {
  rateLimit: (deviceId: string) => `ratelimit:${deviceId}`,
  rateLimitTTL: 60,
  rateLimitMax: 5,
  blacklistActive: "blacklist:active",
  heartbeat: (nodeId: string) => `gateway:heartbeat:${nodeId}`,
  heartbeatTTL: 10,
} as const;

export const DEDUP_KEYS = {
  packetSeen:      "dedup:packets",
  geoClusters:     "geo:clusters",          // GEOADD/GEOSEARCH index
  geoRadiusM:      50,                       // Küme birleştirme yarıçapı (metre)
  clusterMeta:     (clusterId: string) => `cluster:meta:${clusterId}`,
  clusterMetaTTL:  86400,
  clusterPackets:  (clusterId: string) => `cluster:packets:${clusterId}`,
} as const;

export const CONFIDENCE_KEYS = {
  score: (clusterId: string) => `confidence:${clusterId}`,
  scoreTTL: 86400,
  revisionLock: (clusterId: string) => `confidence:lock:${clusterId}`,
  revisionLockTTL: 30,
} as const;

export const TRIAGE_KEYS = {
  result: (clusterId: string) => `triage:${clusterId}`,
  resultTTL: 86400,
  revisionLock: (clusterId: string) => `triage:lock:${clusterId}`,
  revisionLockTTL: 60,
  circuitBreaker: "triage:circuit_breaker",
  circuitBreakerTTL: 30,
} as const;

export const REVIEW_KEYS = {
  pending:          (clusterId: string) => `review:pending:${clusterId}`,
  pendingTTL:       300,
  result:           (clusterId: string) => `review:result:${clusterId}`,
  resultTTL:        86400,
  iterations:       (clusterId: string) => `review:iterations:${clusterId}`,
  iterationsTTL:    86400,
  // Operatör onay bekleme: eskalasyon durumunda set edilir
  operatorHold:     (clusterId: string) => `review:operator_hold:${clusterId}`,
  operatorHoldTTL:  3600, // 60 dakika — operatör müdahalesi için makul süre
} as const;

export const STORAGE_KEYS = {
  triageQueue: "queue:triage",
  holdQueue: "queue:hold",
  escalatedQueue: "queue:escalated",
  deviceReputation: "reputation:devices",
  gridLastSeen: "grid:last_seen",
  deadZones: "grid:dead_zones",
  anomalyFlood: (deviceId: string) => `anomaly:flood:${deviceId}`,
  anomalyFloodTTL: 30,
  anomalyPayloadHash: "anomaly:payload_hash",
  anomalyPayloadHashTTL: 60,
} as const;

export const COMMAND_KEYS = {
  operatorSessions: "operator:sessions",
  wsConnections:    "command:ws_connections",
} as const;

export const STORAGE_KEYS_EXTRA = {
  wsConnections: "command:ws_connections", // StorageAgent'taki referans için alias
} as const;

export const CONSUMER_GROUPS = {
  INTAKE:      { stream: "stream:validated_packets",    group: "intake-consumers"   }, // IntakeAgent
  DEDUP_IN:    { stream: "stream:enriched_packets",     group: "dedup-consumers"    }, // DedupAgent
  DEDUP:       { stream: "stream:cluster_events",       group: "confidence-consumers"},
  CONFIDENCE:  { stream: "stream:scored_events",        group: "triage-consumers"   },
  TRIAGE:      { stream: "stream:triage_results",       group: "review-consumers"   },
  CONF_REVIEW: { stream: "stream:confidence_to_review", group: "review-consumers-2" },
  REVISION_CONFIDENCE: { stream: "stream:revision_requests", group: "revision-conf-group" },
  REVISION_TRIAGE:     { stream: "stream:revision_requests", group: "revision-triage-group" },
  REVIEW:      { stream: "stream:review_approved",      group: "storage-consumers"  },
  STORAGE:     { stream: "stream:review_items",         group: "command-consumers"  },
  OPERATOR:    { stream: "stream:operator_decisions",   group: "storage-op-consumers"},
  OPERATOR_ACK:{ stream: "stream:operator_ack",         group: "review-ack-consumers"},
} as const;

export const ANOMALY_RULES = {
  FLOOD_THRESHOLD:        5,
  GPS_SPOOF_THRESHOLD:    5,
  CONTENT_COPY_THRESHOLD: 10,
  BOT_TIME_GAP_MS:        1000,
  BLACKLIST_THRESHOLD:    0.1,
} as const;
