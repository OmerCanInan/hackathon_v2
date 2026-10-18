import React from "react";
import ReactDOM from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css"; // npm paketi — dış bağlantı yok, KVKK uyumlu
import App from "./App.tsx";
import "./index.css";

// PMTiles varlığını kontrol et — yoksa harita dark background ile çalışır
declare global {
  interface Window { __KEMPLE_HAS_PMTILES?: boolean; }
}

// /turkey.pmtiles var mı? (HEAD isteği — sunucu cevapsa offline tile var)
fetch("/turkey.pmtiles", { method: "HEAD" })
  .then(r => { window.__KEMPLE_HAS_PMTILES = r.ok; })
  .catch(() => { window.__KEMPLE_HAS_PMTILES = false; });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
