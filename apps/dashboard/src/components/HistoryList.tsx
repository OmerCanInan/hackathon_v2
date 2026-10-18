import { ReviewItem } from "@kemple/shared";
import { useKemple } from "../store/kemple";

interface Props {
  title: string;
  items: ReviewItem[];
  emptyText?: string;
  variant?: "pending" | "processed";
  onAction?: (clusterId: string, action: "correct" | "wrong") => void;
}

export function HistoryList({ title, items: rawItems, emptyText = "Kayıt yok", variant = "processed", onAction }: Props) {
  const { setSelected, setFlyTo } = useKemple();

  const items = variant === "pending" 
    ? rawItems.filter(i => (i as any).isHolding)
    : rawItems;

  return (
    <div className={`history-list-container ${variant}`}>
      <div className="history-header">
        <h4>{title}</h4>
        <span className="count">{items.length}</span>
      </div>
      <div className="history-scroll">
        {items.length === 0 ? (
          <div className="empty-state">{emptyText}</div>
        ) : (
          items.map((item) => (
            <div 
              key={item.cluster_id} 
              className="history-item-wrapper"
            >
              <div 
                className="history-item"
                onClick={() => {
                  setSelected(item.cluster_id);
                  if (item.centroid && item.centroid.lat !== null && item.centroid.lng !== null) {
                    setFlyTo({ lat: item.centroid.lat, lng: item.centroid.lng, zoom: 14 });
                  }
                }}
              >
                <div className="item-main">
                  <span className="id">{item.cluster_id}</span>
                  <span className="type">{item.event_type}</span>
                </div>
                <div className="item-meta">
                  <span className="score">★ {item.triage_score.toFixed(1)}</span>
                  <span className="time">{new Date(item.enqueued_at || Date.now()).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              </div>

              {variant === "pending" && onAction && (
                <div className="quick-actions">
                  <button 
                    className="qa-btn qa-correct" 
                    title="Doğru İhbar"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAction(item.cluster_id, "correct");
                    }}
                  >✓</button>
                  <button 
                    className="qa-btn qa-wrong" 
                    title="Yanlış İhbar (Kara Liste)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAction(item.cluster_id, "wrong");
                    }}
                  >✗</button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
