-- ============================================================
-- KEMPLE — PostgreSQL Başlangıç Şeması
-- Docker entrypoint tarafından otomatik çalıştırılır.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- ─────────────────────────────────────────────────────────────
-- 1. PACKETS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS packets (
  id                  BIGSERIAL PRIMARY KEY,
  packet_uuid         UUID        NOT NULL UNIQUE,
  device_id           TEXT        NOT NULL,
  payload             TEXT        NOT NULL,
  schema_version      TEXT        NOT NULL DEFAULT '1.0',
  origin_lat          DOUBLE PRECISION NOT NULL,
  origin_lng          DOUBLE PRECISION NOT NULL,
  last_seen_lat       DOUBLE PRECISION NOT NULL,
  last_seen_lng       DOUBLE PRECISION NOT NULL,
  device_timestamp    TIMESTAMPTZ NOT NULL,
  gateway_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gateway_node_id     TEXT        NOT NULL,
  iteration_count     SMALLINT    NOT NULL DEFAULT 0,
  anonymized_at       TIMESTAMPTZ,
  is_anonymized       BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_packets_device_id   ON packets (device_id);
CREATE INDEX IF NOT EXISTS idx_packets_received_at ON packets (gateway_received_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 2. CLUSTERS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clusters (
  id              BIGSERIAL PRIMARY KEY,
  cluster_id      TEXT        NOT NULL UNIQUE,
  centroid_lat    DOUBLE PRECISION NOT NULL,
  centroid_lng    DOUBLE PRECISION NOT NULL,
  radius_meters   NUMERIC(8,2) NOT NULL DEFAULT 50,
  source_count    INTEGER     NOT NULL DEFAULT 1,
  packet_count    INTEGER     NOT NULL DEFAULT 1,
  first_seen      TIMESTAMPTZ NOT NULL,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_merged       BOOLEAN     NOT NULL DEFAULT FALSE,
  merged_into     TEXT        REFERENCES clusters(cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_clusters_last_updated ON clusters (last_updated DESC);

CREATE TABLE IF NOT EXISTS cluster_packets (
  cluster_id  TEXT NOT NULL REFERENCES clusters(cluster_id),
  packet_uuid UUID NOT NULL REFERENCES packets(packet_uuid),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_id, packet_uuid)
);

-- ─────────────────────────────────────────────────────────────
-- 3. CONFIDENCE_SCORES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS confidence_scores (
  id               BIGSERIAL PRIMARY KEY,
  cluster_id       TEXT        NOT NULL REFERENCES clusters(cluster_id),
  iteration_count  SMALLINT    NOT NULL DEFAULT 0,
  confidence_score NUMERIC(5,2) NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  score_independent_sources NUMERIC(5,2),
  score_coord_consistency   NUMERIC(5,2),
  score_time_gap            NUMERIC(5,2),
  score_operator_history    NUMERIC(5,2),
  score_sybil_penalty       NUMERIC(5,2),
  score_blacklist_penalty   NUMERIC(5,2),
  anomaly_flags    TEXT[]      NOT NULL DEFAULT '{}',
  is_final         BOOLEAN     NOT NULL DEFAULT FALSE,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cluster_id, iteration_count)
);

CREATE INDEX IF NOT EXISTS idx_conf_cluster_id ON confidence_scores (cluster_id);

-- ─────────────────────────────────────────────────────────────
-- 4. TRIAGE_RESULTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS triage_results (
  id                  BIGSERIAL PRIMARY KEY,
  cluster_id          TEXT        NOT NULL REFERENCES clusters(cluster_id),
  iteration_count     SMALLINT    NOT NULL DEFAULT 0,
  triage_score        NUMERIC(4,2) NOT NULL CHECK (triage_score BETWEEN 0 AND 10),
  event_type          TEXT        NOT NULL,
  extracted_persons   INTEGER,
  medical_urgency     TEXT        NOT NULL,
  access_type         TEXT        NOT NULL,
  suggested_resources TEXT[]      NOT NULL DEFAULT '{}',
  criteria_hayati_tehlike   NUMERIC(4,2),
  criteria_kisi_sayisi      NUMERIC(4,2),
  criteria_tibbi_aciliyet   NUMERIC(4,2),
  criteria_confidence_input NUMERIC(4,2),
  criteria_zaman_faktoru    NUMERIC(4,2),
  reasoning           TEXT        NOT NULL,
  model_version       TEXT        NOT NULL,
  is_final            BOOLEAN     NOT NULL DEFAULT FALSE,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cluster_id, iteration_count)
);

CREATE INDEX IF NOT EXISTS idx_triage_cluster_id ON triage_results (cluster_id);
CREATE INDEX IF NOT EXISTS idx_triage_score      ON triage_results (triage_score DESC);

-- ─────────────────────────────────────────────────────────────
-- 5. REVIEW_DECISIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_decisions (
  id                  BIGSERIAL PRIMARY KEY,
  cluster_id          TEXT        NOT NULL REFERENCES clusters(cluster_id),
  iteration_count     SMALLINT    NOT NULL DEFAULT 0,
  review_status       TEXT        NOT NULL CHECK (review_status IN ('approved','escalated','revision_sent')),
  target_agent        TEXT        CHECK (target_agent IN ('ConfidenceAgent','TriageAgent')),
  fields_to_revise    TEXT[]      DEFAULT '{}',
  revision_reason     TEXT,
  final_triage_score        NUMERIC(4,2),
  final_confidence_score    NUMERIC(5,2),
  review_notes              TEXT,
  escalation_reason         TEXT,
  total_iterations          SMALLINT    NOT NULL DEFAULT 0,
  review_model_version TEXT,
  decided_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_cluster_id ON review_decisions (cluster_id);
CREATE INDEX IF NOT EXISTS idx_review_status     ON review_decisions (review_status);

-- ─────────────────────────────────────────────────────────────
-- 6. OPERATOR_DECISIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS operator_decisions (
  id                       BIGSERIAL PRIMARY KEY,
  cluster_id               TEXT        NOT NULL REFERENCES clusters(cluster_id),
  operator_id              TEXT        NOT NULL,
  decision                 TEXT        NOT NULL CHECK (decision IN ('approve','reject','hold','edit')),
  override_triage_score    NUMERIC(4,2),
  override_confidence_score NUMERIC(5,2),
  reason                   TEXT,
  decided_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot_triage_score    NUMERIC(4,2) NOT NULL,
  snapshot_confidence_score NUMERIC(5,2) NOT NULL,
  snapshot_review_status   TEXT         NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opdec_cluster_id  ON operator_decisions (cluster_id);
CREATE INDEX IF NOT EXISTS idx_opdec_operator_id ON operator_decisions (operator_id);
CREATE INDEX IF NOT EXISTS idx_opdec_decided_at  ON operator_decisions (decided_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 7. DEVICE_REPUTATION
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_reputation (
  id           BIGSERIAL PRIMARY KEY,
  device_id    TEXT        NOT NULL,
  score        NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (score BETWEEN 0 AND 1),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id)
);

CREATE TABLE IF NOT EXISTS device_reputation_log (
  id           BIGSERIAL PRIMARY KEY,
  device_id    TEXT        NOT NULL REFERENCES device_reputation(device_id),
  delta        NUMERIC(4,3) NOT NULL,
  reason       TEXT        NOT NULL,
  triggered_by TEXT        NOT NULL CHECK (triggered_by IN ('operator','anomaly_engine','blacklist')),
  cluster_id   TEXT,
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_replog_device_id ON device_reputation_log (device_id);

-- ─────────────────────────────────────────────────────────────
-- 8. BLACKLIST
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blacklist (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT        NOT NULL UNIQUE,
  reason      TEXT        NOT NULL,
  issued_by   TEXT        NOT NULL CHECK (issued_by IN ('operator','anomaly_engine')),
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_blacklist_device_id ON blacklist (device_id);
CREATE INDEX IF NOT EXISTS idx_blacklist_active    ON blacklist (is_active) WHERE is_active = TRUE;

-- ─────────────────────────────────────────────────────────────
-- 9. DEAD_ZONES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dead_zones (
  id                   BIGSERIAL PRIMARY KEY,
  grid_cell_id         TEXT        NOT NULL,
  centroid_lat         DOUBLE PRECISION NOT NULL,
  centroid_lng         DOUBLE PRECISION NOT NULL,
  silent_duration_mins INTEGER     NOT NULL,
  severity             TEXT        NOT NULL CHECK (severity IN ('YELLOW','ORANGE','BLACK')),
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
  operator_action      TEXT
);

CREATE INDEX IF NOT EXISTS idx_deadzones_active     ON dead_zones (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_deadzones_detected_at ON dead_zones (detected_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 10. RESOURCE_ASSIGNMENTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_assignments (
  id             BIGSERIAL PRIMARY KEY,
  cluster_id     TEXT        NOT NULL REFERENCES clusters(cluster_id),
  resource_type  TEXT        NOT NULL,
  resource_id    TEXT        NOT NULL,
  assigned_by    TEXT        NOT NULL,
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  eta_minutes    INTEGER,
  status         TEXT        NOT NULL DEFAULT 'assigned'
                             CHECK (status IN ('assigned','en_route','on_scene','completed','cancelled')),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_assign_cluster_id ON resource_assignments (cluster_id);

-- ─────────────────────────────────────────────────────────────
-- 11. DLQ_LOG
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dlq_log (
  id            BIGSERIAL PRIMARY KEY,
  stream_name   TEXT        NOT NULL,
  message_id    TEXT        NOT NULL,
  raw_payload   JSONB       NOT NULL,
  error_message TEXT        NOT NULL,
  failed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved      BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_dlq_stream     ON dlq_log (stream_name);
CREATE INDEX IF NOT EXISTS idx_dlq_unresolved ON dlq_log (resolved) WHERE resolved = FALSE;

-- ─────────────────────────────────────────────────────────────
-- VIEW: Operatör dashboard özet
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_active_events AS
SELECT
  c.cluster_id,
  c.centroid_lat,
  c.centroid_lng,
  c.source_count,
  cs.confidence_score,
  tr.triage_score,
  tr.event_type,
  tr.extracted_persons,
  tr.medical_urgency,
  tr.access_type,
  tr.suggested_resources,
  rd.review_status,
  rd.total_iterations,
  c.last_updated
FROM clusters c
LEFT JOIN confidence_scores cs
  ON cs.cluster_id = c.cluster_id AND cs.is_final = TRUE
LEFT JOIN triage_results tr
  ON tr.cluster_id = c.cluster_id AND tr.is_final = TRUE
LEFT JOIN review_decisions rd
  ON rd.cluster_id = c.cluster_id
 AND rd.decided_at = (
   SELECT MAX(decided_at) FROM review_decisions rd2
   WHERE rd2.cluster_id = c.cluster_id
 )
WHERE c.is_merged = FALSE
ORDER BY tr.triage_score DESC NULLS LAST;
