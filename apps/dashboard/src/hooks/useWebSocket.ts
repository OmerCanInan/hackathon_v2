import { useEffect, useRef } from "react";
import { useKemple } from "../store/kemple.ts";
import type { ReviewItem, DeadZoneAlert } from "@kemple/shared";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3002/ws";

type WsMsg =
  | { type: "NEW_ITEM";    payload: ReviewItem }
  | { type: "DEAD_ZONE";  payload: DeadZoneAlert }
  | { type: "QUEUE_INIT"; payload: ReviewItem[] }
  | { type: "ACK";        payload: { cluster_id: string; decision: string } }
  | { type: "OPERATOR_HOLD"; payload: { cluster_id: string } };

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { setConnected, addItem, setItems, addDeadZone, setHold, removeItem } = useKemple();

  const connect = () => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      console.log("✅ WebSocket bağlandı");
    };

    ws.onmessage = (e) => {
      try {
        const msg: WsMsg = JSON.parse(e.data);
        switch (msg.type) {
          case "QUEUE_INIT":
            setItems(msg.payload);
            break;
          case "NEW_ITEM":
            addItem(msg.payload);
            break;
          case "DEAD_ZONE":
            addDeadZone(msg.payload);
            break;
          case "OPERATOR_HOLD":
            setHold(msg.payload.cluster_id, true);
            break;
          case "ACK": {
            const { cluster_id, decision } = msg.payload;
            if (decision === "hold") {
              // Beklemede — hold flag'ini aç, triyaj listesinden çıkar
              setHold(cluster_id, true);
            } else if (decision === "approve" || decision === "reject") {
              // İşlem tamam — listeden kaldır
              removeItem(cluster_id, decision === "approve");
            }
            // approve_hold / reject_hold → hold'dan çıkar
            else if (decision === "approve_hold" || decision === "reject_hold" || decision === "escalate_now") {
              removeItem(cluster_id, true);
            }
            break;
          }
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      setConnected(false);
      console.log("🔌 WebSocket koptu, yeniden bağlanıyor...");
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
  };

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current ?? undefined);
      wsRef.current?.close();
    };
  }, []);

  const send = (msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  };

  return { send };
}
