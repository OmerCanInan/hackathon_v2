import { useCallback, useEffect, useState } from "react";
import { useKemple } from "./store/kemple.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";
import { MapView } from "./components/Map.tsx";
import { TriageQueue } from "./components/TriageQueue.tsx";
import { ActionPanel } from "./components/ActionPanel.tsx";
import { HistoryList } from "./components/HistoryList.tsx";

const OPERATOR_ID = "operator-1";

// Canlı saat hook
function useClock() {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString("tr-TR"));
  useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString("tr-TR")), 1000);
    return () => clearInterval(t);
  }, []);
  return time;
}

export default function App() {
  const { connected, items, processedItems, totalProcessed, totalCarriedData, removeItem, setSelected, setHold } = useKemple();
  const { send } = useWebSocket();
  const time = useClock();

  const handleDecision = useCallback(
    (clusterId: string, decision: "approve" | "reject" | "hold") => {
      // REST API üzerinden kararı gönder (Daha güvenilir)
      const commandUrl = import.meta.env.VITE_COMMAND_URL ?? "http://localhost:3002";
      fetch(`${commandUrl}/api/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cluster_id: clusterId,
          decision,
          operator_id: OPERATOR_ID,
          decided_at: new Date().toISOString(),
        })
      }).catch(err => console.error("Karar gönderilemedi:", err));
      
      // "İlgilenildi" veya "Yanlış İhbar" → Geçmişe taşı
      if (decision === "approve" || decision === "reject") {
        removeItem(clusterId, true);
      }

      // "İlgileniliyor" (hold) → Beklemeye al (kuyruktan sakla)
      if (decision === "hold") {
        setHold(clusterId, true);
      }
      
      // Aktif triyajdan çıkar (odak değiştir)
      setSelected(null);
    },
    [removeItem, setSelected, setHold]
  );

  const handleHistoryAction = useCallback((clusterId: string, action: "correct" | "wrong") => {
    if (action === "correct") {
      // Bekleyenlerdeki iş bitti -> İşlem görmüşe (Geçmiş) al
      handleDecision(clusterId, "approve");
    } else {
      // Yanlış ihbar -> Tamamen kaldır
      handleDecision(clusterId, "reject");
    }
  }, [handleDecision]);

  const criticalCount = items.filter(i => i.triage_score >= 8).length;

  return (
    <div className="app">
      {/* ... header kısmı ... */}
      <header className="topbar">
        <div className="topbar-brand">
          <h1>KEMPLE</h1>
          <div className="badge">KOMUTA MERKEZİ</div>
        </div>

        <div className="topbar-status">
          <div className="stat-chip">
            <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
            {connected ? "Bağlı" : "Bağlantı kesik"}
          </div>
          <div className="stat-chip">
            <strong>{items.length}</strong> bekleyen
          </div>
          <div className="stat-chip">
            <strong>{processedItems.length}</strong> işlenen
          </div>
          <div className="stat-chip" style={{ color: "var(--text-muted)" }}>
            {OPERATOR_ID}
          </div>
        </div>
      </header>

      {/* ─── Main Grid ──────────────────────────────────── */}
      <div className="main-grid redesign">
        {/* SOL PANEL: Bekleyenler ve Geçmiş */}
        <aside className="left-sidebar">
          <HistoryList 
            title="BEKLEYENLER" 
            items={items} 
            emptyText="Bekleyen ihbar yok" 
            variant="pending" 
            onAction={handleHistoryAction}
          />
          <HistoryList title="İŞLEM GÖRMÜŞ" items={processedItems} emptyText="Henüz işlem yapılmadı" />
        </aside>

        {/* ORTA: Harita */}
        <main className="map-view-area">
          <MapView />
        </main>

        {/* SAĞ PANEL: Triyaj (Üst: Liste, Alt: Detay) */}
        <aside className="right-panel">
          <TriageQueue onDecision={handleDecision} />
          <ActionPanel onDecision={handleDecision} />
        </aside>
      </div>

      {/* ─── Status Bar ─────────────────────────────────── */}
      <footer className="statusbar">
        <span>{connected ? "🟢 Pipeline aktif" : "🔴 Bağlantı yok"}</span>
        <span>Redis: bağlı</span>
        <span>LLM: llama3.1:8b</span>
        <span className="time">{time}</span>
      </footer>
    </div>
  );
}
