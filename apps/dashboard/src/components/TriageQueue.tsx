import { useRef } from "react";
import { useKemple } from "../store/kemple.ts";
import type { ReviewItem } from "@kemple/shared";

function confidenceClass(score: number) {
  if (score >= 70) return "conf-high";
  if (score >= 45) return "conf-mid";
  return "conf-low";
}

function triageClass(score: number) {
  if (score >= 8) return "critical";
  if (score >= 6) return "high";
  if (score >= 4) return "medium";
  return "low";
}

function queueItemClass(item: ReviewItem) {
  const base = "queue-item";
  const severity = triageClass(item.triage_score);
  return `${base} ${severity}`;
}

interface Props {
  onDecision: (clusterId: string, decision: "approve" | "reject" | "hold") => void;
}

export function TriageQueue({ onDecision }: Props) {
  const { items, selectedId, setSelected, setFlyTo } = useKemple();
  const listRef = useRef<HTMLDivElement>(null);

  const sorted = [...items]
    .filter(i => !i.isHolding)
    .sort((a, b) => b.triage_score - a.triage_score);
  
  const critical = sorted.filter(i => i.triage_score >= 8).length;

  function handleSelect(item: ReviewItem) {
    setSelected(item.cluster_id);
    if (item.centroid && item.centroid.lat !== null && item.centroid.lng !== null) {
      setFlyTo({ lat: item.centroid.lat, lng: item.centroid.lng, zoom: 15 });
    }
  }

  return (
    <div className="triage-queue">
      <div className="panel-header">
        <h2>🚨 Triyaj Kuyruğu</h2>
        <div style={{ display: "flex", gap: 8 }}>
          {critical > 0 && (
            <span className="count-badge">{critical} KRİTİK</span>
          )}
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {sorted.length} ihbar
          </span>
        </div>
      </div>

      <div className="queue-list" ref={listRef}>
        {sorted.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📡</div>
            Bekleyen ihbar yok
          </div>
        )}

        {sorted.map((item) => (
          <div
            key={item.cluster_id}
            id={`item-${item.cluster_id}`}
            className={`${queueItemClass(item)}${selectedId === item.cluster_id ? " selected" : ""}`}
            onClick={() => handleSelect(item)}
          >
            <div className="queue-item-header">
              <div className="scores">
                <span className={`triage-score ${triageClass(item.triage_score)}`}>
                  {item.triage_score.toFixed(1)}
                </span>
                <span className={`confidence-pill ${confidenceClass(item.confidence_score)}`}>
                  %{item.confidence_score.toFixed(0)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {item.confidence_score < 45 && (
                  <span className="warning-badge">⚠ Düşük güven</span>
                )}
                {item.escalated && (
                  <span className="escalated-badge">ESKALASİYON</span>
                )}
                <span className={`event-type-badge event-${item.event_type}`}>
                  {item.event_type.replace("_", " ")}
                </span>
              </div>
            </div>

            <div className="queue-item-meta">
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--blue)" }}>
                  {item.cluster_id}
                </span>
                {item.extracted_persons && (
                  <span className="persons-info">
                    👥 {item.extracted_persons} kişi
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {selectedId === item.cluster_id && (
                  <>
                    <button
                      className="btn btn-approve"
                      style={{ padding: "3px 10px", fontSize: 11 }}
                      onClick={(e) => { e.stopPropagation(); onDecision(item.cluster_id, "approve"); }}
                    >
                      ✓ İlgilenildi
                    </button>
                    <button
                      className="btn btn-reject"
                      style={{ padding: "3px 10px", fontSize: 11 }}
                      onClick={(e) => { e.stopPropagation(); onDecision(item.cluster_id, "reject"); }}
                    >
                      ✗ Yanlış
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
