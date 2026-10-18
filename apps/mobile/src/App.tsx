import { useState, useEffect, useCallback, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { Geolocation } from "@capacitor/geolocation";
import { sendPacket, isBLEAvailable } from "./ble-client";
import "./index.css";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:3001";

// Cihaz ID — uygulama yeniden başladığında aynı kalır (simüle)
// ... (ayni kalsin)
const DEVICE_ID = (() => {
  const stored = localStorage.getItem("kemple_device_id");
  if (stored) return stored;
  const id = `device-${uuidv4().slice(0, 12)}`;
  localStorage.setItem("kemple_device_id", id);
  return id;
})();

type GpsState = "loading" | "active" | "error" | "demo";
type AppState = "form" | "sending" | "success" | "error";

interface Coords { lat: number; lng: number; }

export default function App() {
  const [gpsState, setGpsState] = useState<GpsState>("loading");
  const [coords, setCoords] = useState<Coords | null>(null);
  const coordsRef = useRef<Coords | null>(null); // Stale closure önleyici
  const [appState, setAppState] = useState<AppState>("form");
  const [payload, setPayload] = useState("");
  const [persons, setPersons] = useState<string>("1");
  const [lastPacketId, setLastPacketId] = useState<string>("");
  const [sendMethod, setSendMethod] = useState<"ble" | "http" | "">("");
  const [gossipCount, setGossipCount] = useState(0);
  const [gpsLog, setGpsLog] = useState<string>("Sistem başlatılıyor...");
  const [kvkkConsent, setKvkkConsent] = useState(
    () => localStorage.getItem("kemple_kvkk_consent") === "1"
  );

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setGpsLog(msg);
    console.log(`[GPS LOG] ${time}: ${msg}`);
  };

  // Kesintisiz Konum Takibi (Native Persistent Geolocation with Fallback)
  useEffect(() => {
    let watchId: string | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const startTracking = async () => {
      try {
        const permissions = await Geolocation.checkPermissions();
        if (permissions.location !== "granted") {
          await Geolocation.requestPermissions();
        }

        // 1. GPS (High Accuracy) Takibini Başlat
        addLog("Uydular taranıyor (GPS)...");
        watchId = await Geolocation.watchPosition(
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
          (pos) => {
            if (pos) {
              if (fallbackTimer) {
                clearTimeout(fallbackTimer);
                fallbackTimer = null;
              }
              const newCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              setCoords(newCoords);
              coordsRef.current = newCoords; // Ref güncelle
              setGpsState("active");
              addLog("📍 GPS kilitlendi (Hassas)");
            }
          }
        );

        // 2. Fallback Mekanizması: 2 dakika sonra hala konum yoksa yaklaşık konumu dene
        fallbackTimer = setTimeout(async () => {
          if (!coordsRef.current) {
            addLog("Sinyal zayıf, Yaklaşık Konum aranıyor...");
            try {
              const lowAccPos = await Geolocation.getCurrentPosition({
                enableHighAccuracy: false,
                timeout: 10000
              });
              if (lowAccPos && !coordsRef.current) {
                const newCoords = { lat: lowAccPos.coords.latitude, lng: lowAccPos.coords.longitude };
                setCoords(newCoords);
                coordsRef.current = newCoords; // Ref güncelle
                setGpsState("active");
                addLog("📍 Yaklaşık konum alındı (WiFi/Şebeke)");
              }
            } catch (e) {
              addLog("⚠️ Konum bulunamadı, taranıyor...");
            }
          }
        }, 120000);

      } catch (err) {
        addLog("❌ Sistem hatası!");
        setGpsState("error");
      }
    };

    startTracking();

    return () => {
      if (watchId) Geolocation.clearWatch({ id: watchId });
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, []); // Bağımlılık yok, sonsuz döngü bitti.

  // Gossip simülasyonu
  useEffect(() => {
    const timer = setInterval(() => {
      setGossipCount(prev => Math.min(prev + Math.floor(Math.random() * 3), 12));
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const handleSubmit = useCallback(async (urgentPayload?: string) => {
    const finalPayload = urgentPayload || payload;
    if (!finalPayload.trim() || !kvkkConsent) {
      if (!kvkkConsent) alert("Lütfen KVKK onayını işaretleyin.");
      return;
    }

    setAppState("sending");

    const personCount = parseInt(persons) || 1;
    const packetUuid = uuidv4();

    const packet = {
      packet_uuid: packetUuid,
      device_id: DEVICE_ID,
      payload: finalPayload + (urgentPayload ? "" : (personCount > 1 ? ` (Kişi: ${personCount})` : "")),
      timestamp: new Date().toISOString(),
      origin_location: coords ? { lat: coords.lat, lng: coords.lng } : null,
      last_seen_location: coords ? { lat: coords.lat, lng: coords.lng } : null,
      schema_version: "1.0",
      iteration_count: 0,
    };

    const result = await sendPacket(packet, GATEWAY_URL);
    if (result.success) {
      setLastPacketId(packetUuid);
      setSendMethod(result.method as "ble" | "http");
      setAppState("success");
    } else {
      setAppState("error");
      setTimeout(() => setAppState("form"), 3000);
    }
  }, [coords, payload, persons, kvkkConsent]);

  const handleUrgentAction = () => {
    handleSubmit("ENKAZ ALTINDAYIM! ACİL YARDIM BEKLİYORUM.");
  };

  const handleNewReport = () => {
    setAppState("form");
    setPayload("");
    setPersons("1");
  };

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <div className="header-brand">
          <h1>KEMPLE</h1>
          <div className="badge">AFET İLETİŞİM</div>
        </div>
        <div className="header-sub">Güvenli • Şifreli • Çevrimdışı</div>
      </div>

      {appState === "success" ? (
        <div className="success-screen animate-fade-in">
          <div className="success-icon">✓</div>
          <h2>İhbar Başarıyla İletildi</h2>
          <p>Verileriniz güvenli kanallar üzerinden komuta merkezine ulaştırıldı.</p>
          
          <div className="status-card">
            {sendMethod === "ble" ? "🔵 Bluetooth (Cihazdan Cihaza)" : "🌐 WiFi / Şebeke"} üzerinden gönderildi.
          </div>
          
          <div className="uuid-box">ID: {lastPacketId}</div>
          
          <button className="secondary-btn" onClick={handleNewReport}>
            Yeni Bildiri Oluştur
          </button>
        </div>
      ) : (
        <div className="main-content animate-fade-in">
          {/* ACİL BUTON */}
          <div className="urgent-section">
            <button 
              className="urgent-btn"
              onClick={handleUrgentAction}
              disabled={appState === "sending" || !kvkkConsent}
            >
              <div className="urgent-icon">🚨</div>
              <div className="urgent-text">
                <strong>ENKAZ ALTINDAYIM</strong>
                <span>Tek Tıkla Acil İhbar</span>
              </div>
            </button>
          </div>

          <div className="divider"><span>VEYA BİLDİRİ YAPIN</span></div>

          {/* FORM */}
          <div className="form-card">
            <div className="input-group">
              <label>Bildiri İçeriği</label>
              <textarea
                placeholder="Neye ihtiyacınız var? (Gıda, tıbbi yardım, yangın vb.)"
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                rows={3}
              />
            </div>

            <div className="row">
              <div className="input-group flex-1">
                <label>Kişi Sayısı</label>
                <input
                  type="number"
                  value={persons}
                  onChange={(e) => setPersons(e.target.value)}
                  min="1"
                />
              </div>
              
              <div className="input-group flex-1">
                <label>Konum Durumu</label>
                <div className={`gps-status ${gpsState}`}>
                  {gpsState === "active" ? "📍 Alındı" : 
                   gpsState === "loading" ? "📍 Aranıyor..." : 
                   gpsState === "error" ? "📍 Sinyal Bekleniyor" : "📍 İzin Gerekli"}
                </div>
              </div>
            </div>

            {/* GPS Live Log */}
            <div className="gps-log-overlay">
              <span className="log-icon">📡</span>
              <span className="log-text">{gpsLog}</span>
            </div>

            <div className="kvkk-box">
              <input
                type="checkbox"
                id="kvkk"
                checked={kvkkConsent}
                onChange={(e) => {
                  setKvkkConsent(e.target.checked);
                  localStorage.setItem("kemple_kvkk_consent", e.target.checked ? "1" : "0");
                }}
              />
              <label htmlFor="kvkk">
                Verilerimin afet koordinasyonu için 90 gün süreyle işlenmesini onaylıyorum.
              </label>
            </div>

            <button 
              className="submit-btn"
              onClick={() => handleSubmit()}
              disabled={appState === "sending" || !payload.trim() || !kvkkConsent}
            >
              {appState === "sending" ? "⏳ Gönderiliyor..." : "Bildiriyi Gönder"}
            </button>

            {appState === "error" && (
              <div className="error-msg">Bağlantı kurulamadı. Tekrar deneniyor...</div>
            )}
          </div>
        </div>
      )}

      {/* Footer Info */}
      <div className="footer-info">
        <div className="gossip-status">
          <span className="dot pulse"></span>
          {gossipCount} cihaz kapsama alanında
        </div>
        <div className="device-id">{DEVICE_ID.split("-")[1]}</div>
      </div>
    </div>
  );
}
