import { z } from "zod";

// ─── Temel Zod Şemaları ──────────────────────────────────────────────────────

export const GeoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const RawPacketSchema = z.object({
  packet_uuid: z.string().uuid(),
  device_id: z.string().min(1).max(64),
  payload: z.string().min(1).max(4096),
  timestamp: z.string().datetime(),
  origin_location: GeoPointSchema,
  last_seen_location: GeoPointSchema,
  schema_version: z.string().default("1.0"),
  iteration_count: z.literal(0),
});

export const ValidatedPacketSchema = RawPacketSchema.extend({
  validation_ts: z.string().datetime(),
  gateway_node_id: z.string(),
});

export const OperatorDecisionMsgSchema = z.object({
  cluster_id: z.string(),
  decision: z.enum(["approve", "reject", "hold", "edit"]),
  override_triage_score: z.number().min(0).max(10).optional(),
  override_confidence_score: z.number().min(0).max(100).optional(),
  reason: z.string().optional(),
  operator_id: z.string(),
  decided_at: z.string().datetime(),
});

// ─── Türkiye bounding box doğrulama ──────────────────────────────────────────
// Yaklaşık: 25.6–44.8 lng, 35.8–42.1 lat
export function isWithinTurkey(lat: number, lng: number): boolean {
  return lat >= 35.8 && lat <= 42.1 && lng >= 25.6 && lng <= 44.8;
}

// ─── Haversine mesafe hesabı (metre cinsinden) ───────────────────────────────
export function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371000; // Dünya yarıçapı (metre)
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Ağırlıklı ortalama koordinat (küme merkezi güncellemesi) ────────────────
export function weightedCentroid(
  points: Array<{ lat: number; lng: number; weight: number }>
): { lat: number; lng: number } {
  const totalWeight = points.reduce((s, p) => s + p.weight, 0);
  const lat = points.reduce((s, p) => s + p.lat * p.weight, 0) / totalWeight;
  const lng = points.reduce((s, p) => s + p.lng * p.weight, 0) / totalWeight;
  return { lat, lng };
}

export type RawPacketInput = z.infer<typeof RawPacketSchema>;
export type ValidatedPacketInput = z.infer<typeof ValidatedPacketSchema>;
