/**
 * KEMPLE — Shared Message Schema Package
 * Tüm ajanlar bu tipleri import eder. iteration_count her mesajda zorunludur.
 */

// ─── Temel Tipler ────────────────────────────────────────────────────────────

export interface GeoPoint {
  lat: number | null;
  lng: number | null;
}

export interface ScoreBreakdown {
  independent_sources: number;
  coord_consistency: number;
  time_gap_organic: number;
  operator_history: number;
  sybil_penalty: number;
  blacklist_penalty: number;
}

export interface TriageCriteriaBreakdown {
  hayati_tehlike: number;
  kisi_sayisi: number;
  tibbi_aciliyet: number;
  confidence_input: number;
  zaman_faktoru: number;
}

export type EventType =
  | "ENKAZ_MAHSUR"
  | "TIBBI_ACIL"
  | "YANGIN"
  | "LOJISTIK"
  | "BILGI_TALEBI"
  | "BELIRSIZ";

export type MedicalUrgency = "KRITIK" | "YUKSEK" | "ORTA" | "DUSUK" | "YOK";
export type AccessType = "ARAC" | "YAYA_ONLY" | "ENGELLI" | "BILINMIYOR";
export type ReviewStatus = "approved" | "escalated" | "pending";
export type OperatorDecision = "approve" | "reject" | "hold" | "edit";
export type TargetAgent = "ConfidenceAgent" | "TriageAgent";

// ─── 1. RAW_PACKET ───────────────────────────────────────────────────────────
export interface RawPacket {
  packet_uuid: string;
  device_id: string;
  payload: string;
  timestamp: string;
  origin_location: GeoPoint | null;
  last_seen_location: GeoPoint | null;
  schema_version: string;
  iteration_count: number;
}

// ─── 2. VALIDATED_PACKET ─────────────────────────────────────────────────────
export interface ValidatedPacket extends RawPacket {
  validation_ts: string;
  gateway_node_id: string;
  enriched_text?: string;
}

// ─── 3. CLUSTER_EVENT ────────────────────────────────────────────────────────
export interface ClusterEvent {
  cluster_id: string;
  packet_uuids: string[];
  device_ids: string[];
  centroid: GeoPoint | null;
  source_count: number;
  first_seen: string;
  last_updated: string;
  raw_payloads: string[];
  enriched_payloads?: string[];
  iteration_count: number;
}

// ─── 4. SCORED_EVENT ─────────────────────────────────────────────────────────
export interface ScoredEvent extends ClusterEvent {
  confidence_score: number;
  score_breakdown: ScoreBreakdown;
  anomaly_flags: string[];
  device_reputations: Record<string, number>;
}

// ─── 5. TRIAGE_RESULT ────────────────────────────────────────────────────────
export interface TriageResult {
  cluster_id: string;
  triage_score: number;
  event_type: EventType;
  extracted_persons: number | null;
  medical_urgency: MedicalUrgency;
  access_type: AccessType;
  suggested_resources: string[];
  criteria: TriageCriteriaBreakdown;
  reasoning: string;
  enriched_text?: string;
  model_version: string;
  iteration_count: number;
}

// ─── 6. CONFIDENCE_TO_REVIEW ─────────────────────────────────────────────────
export interface ConfidenceToReview {
  cluster_id: string;
  confidence_score: number;
  score_breakdown: ScoreBreakdown;
  anomaly_flags: string[];
  source_count: number;
  iteration_count: number;
}

// ─── 7. REVISION_REQUEST ─────────────────────────────────────────────────────
export interface RevisionRequest {
  cluster_id: string;
  target_agent: TargetAgent;
  fields_to_revise: string[];
  revision_reason: string;
  original_values: Record<string, unknown>;
  iteration_count: number;
}

// ─── 8. REVIEW_APPROVED ──────────────────────────────────────────────────────
export interface ReviewApproved {
  cluster_id: string;
  final_triage_score: number;
  final_confidence_score: number;
  review_status: ReviewStatus;
  review_notes: string;
  total_iterations: number;
  escalation_reason?: string;
  escalated?: boolean; // true ise eskalasyon kuyruğuna yazılır
}

// ─── 9. REVIEW_ITEM ──────────────────────────────────────────────────────────
export interface ReviewItem {
  cluster_id: string;
  triage_score: number;
  confidence_score: number;
  review_status: ReviewStatus;
  escalated: boolean;
  escalation_reason?: string;
  event_type: EventType;
  extracted_persons: number | null;
  centroid: GeoPoint | null;
  enqueued_at: string;
  source_count: number;
  raw_payloads: string[];
  reasoning: string | null;
  isHolding?: boolean;
}

// ─── 10. OPERATOR_DECISION ───────────────────────────────────────────────────
export interface OperatorDecisionMsg {
  cluster_id: string;
  decision: OperatorDecision;
  override_triage_score?: number;
  override_confidence_score?: number;
  reason?: string;
  operator_id: string;
  decided_at: string;
}

// ─── 11. REPUTATION_UPDATE ───────────────────────────────────────────────────
export interface ReputationUpdate {
  device_id: string;
  delta: number;
  reason: string;
  triggered_by: "operator" | "anomaly_engine" | "blacklist";
  cluster_id?: string;
}

// ─── 12. BLACKLIST_BROADCAST ─────────────────────────────────────────────────
export interface BlacklistBroadcast {
  device_id: string;
  reason: string;
  expires_at: string;
  issued_by: "operator" | "anomaly_engine";
}

// ─── 13. DEAD_ZONE_ALERT ─────────────────────────────────────────────────────
export interface DeadZoneAlert {
  grid_cell_id: string;
  silent_duration_mins: number;
  centroid: GeoPoint | null;
  suggested_action: string;
  severity: "YELLOW" | "ORANGE" | "BLACK";
  detected_at: string;
}

// ─── Redis STREAM key sabitleri ──────────────────────────────────────────────
export const STREAMS = {
  VALIDATED:        "stream:validated_packets",
  ENRICHED:         "stream:enriched_packets",
  CLUSTER:          "stream:cluster_events",
  SCORED:           "stream:scored_events",
  TRIAGE:           "stream:triage_results",
  CONF_TO_REVIEW:   "stream:confidence_to_review",
  REVISION:         "stream:revision_requests",
  REVIEW_APPROVED:  "stream:review_approved",
  REVIEW_ITEM:      "stream:review_items",
  OPERATOR:         "stream:operator_decisions",
  OPERATOR_ACK:     "stream:operator_ack",     // Operatör hold’u kaldırır
  REPUTATION:       "stream:reputation_updates",
  BLACKLIST:        "stream:blacklist_broadcast",
  DEAD_ZONE:        "stream:dead_zone_alerts",
  DLQ:              "stream:dead_letter_queue",
} as const;

export const MAX_ITERATIONS = 2;

// ─── 14. INTAKE_PACKET ───────────────────────────────────────────────────────
// Ollama'nın ham payload'dan çıkardığı yapılandırılmış bilgi
export interface IntakePacket {
  cluster_id:          string;
  original_payload:    string;
  extracted_location?: string;    // "Kadıköy, İstanbul" gibi doğal dil
  extracted_persons?:  number | null;
  urgency_hint?:       "KRITIK" | "YUKSEK" | "ORTA" | "DUSUK";
  enriched_text?:      string;    // Ollama'nın kısalttı/düzenlediği metin
  intake_model:        string;    // hangi model kullanıldı
  intake_ts:           string;
}
