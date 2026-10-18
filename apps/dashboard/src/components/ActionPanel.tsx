import { useKemple } from "../store/kemple.ts";

interface Props {
  onDecision: (clusterId: string, decision: "approve" | "reject" | "hold") => void;
}

export function ActionPanel({ onDecision }: Props) {
  const { items, selectedId, deadZones } = useKemple();
  const selected = items.find(i => i.cluster_id === selectedId) as any;

  return (
    <div className="action-panel">
      {selected ? (
        <>
          <h3>📋 Seçili İhbar — {selected.cluster_id}</h3>
          <div className="selected-detail">
            <div className="detail-row">
              <span className="label">Triyaj Skoru</span>
              <span className="value" style={{
                color: selected.triage_score >= 8 ? "var(--red)"
                     : selected.triage_score >= 6 ? "var(--orange)"
                     : "var(--text-primary)"
              }}>{selected.triage_score.toFixed(1)} / 10</span>
            </div>
            <div className="detail-row">
              <span className="label">Güven Skoru</span>
              <span className="value" style={{
                color: selected.confidence_score >= 70 ? "var(--green)"
                     : selected.confidence_score >= 45 ? "var(--orange)"
                     : "var(--red)"
              }}>%{selected.confidence_score.toFixed(0)}</span>
            </div>
            <div className="detail-row">
              <span className="label">Olay Tipi</span>
              <span className="value">{selected.event_type}</span>
            </div>
            {selected.extracted_persons && (
              <div className="detail-row">
                <span className="label">Kişi Sayısı</span>
                <span className="value">{selected.extracted_persons} kişi</span>
              </div>
            )}
            <div className="detail-row">
              <span className="label">Durum</span>
              <span className="value">{selected.review_status}</span>
            </div>
            <div className="detail-row">
              <span className="label">Koordinat</span>
              <span className="value">
                {selected.centroid && selected.centroid.lat !== null && selected.centroid.lng !== null
                  ? `${selected.centroid.lat.toFixed(4)}, ${selected.centroid.lng.toFixed(4)}`
                  : "Konum Yok"}
              </span>
            </div>
          </div>

          {selected.confidence_score < 45 && (
            <div style={{
              background: "rgba(255,211,42,0.08)",
              border: "1px solid rgba(255,211,42,0.3)",
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 11,
              color: "var(--yellow)",
              marginBottom: 10,
            }}>
              ⚠️ Güven skoru düşük — ekip göndermeden önce sahayı teyit edin
            </div>
          )}

          {selected.escalated && (
            <div style={{
              background: "rgba(255,71,87,0.08)",
              border: "1px solid rgba(255,71,87,0.3)",
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 11,
              color: "var(--red)",
              marginBottom: 10,
            }}>
              🚨 ESKALASİYON: {selected.escalation_reason}
            </div>
          )}

          <div className="detail-section">
            <div className="section-header">🤖 Yapay Zeka Analizi</div>
            <div className="ai-box">
              {selected.enriched_text && (
                <div className="ai-summary">
                  <strong>Özet:</strong> {selected.enriched_text}
                </div>
              )}
              <div className="ai-reasoning">
                <strong>Gerekçe:</strong> {selected.reasoning || "Analiz gerekçesi henüz yüklenmedi."}
              </div>
            </div>
          </div>

          <div className="detail-section">
            <div className="section-header">📩 Saha Raporları (Orijinal)</div>
            <div className="payloads-list">
              {selected.raw_payloads?.map((msg: string, i: number) => (
                <div key={i} className="payload-bubble original-text">
                  {msg}
                </div>
              ))}
            </div>
          </div>

          <div className="action-buttons">
            <button
              className="btn btn-hold"
              onClick={() => onDecision(selected.cluster_id, "hold")}
            >
              ⏳ İlgileniliyor
            </button>
            <button
              className="btn btn-approve"
              onClick={() => onDecision(selected.cluster_id, "approve")}
            >
              ✓ İlgilenildi
            </button>
          </div>
        </>
      ) : (
        <div>
          <h3>📋 İhbar Seçilmedi</h3>
          {deadZones.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
                ⚠️ Aktif Ölü Bölgeler ({deadZones.length})
              </div>
              {deadZones.slice(0, 3).map(dz => (
                <div key={dz.grid_cell_id} style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  marginBottom: 4,
                  background: dz.severity === "BLACK" ? "rgba(100,100,100,0.1)"
                             : dz.severity === "ORANGE" ? "var(--orange-dim)" : "var(--yellow-dim)",
                  borderRadius: 4,
                  color: dz.severity === "BLACK" ? "var(--text-muted)"
                       : dz.severity === "ORANGE" ? "var(--orange)" : "var(--yellow)",
                }}>
                  {dz.grid_cell_id} — {dz.silent_duration_mins} dk sessiz
                </div>
              ))}
            </div>
          )}
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 12 }}>
            Kuyruktaki bir ihbarı seçerek detayları görün ve karar verin.
          </p>
        </div>
      )}
    </div>
  );
}
