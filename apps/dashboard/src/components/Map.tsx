import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import * as pmtiles from "pmtiles";
import { useKemple } from "../store/kemple";
import type { ReviewItem, DeadZoneAlert } from "@kemple/shared";

// Confidence → renk
function confColor(score: number): string {
  if (score >= 70) return "#2ed573";
  if (score >= 45) return "#ff9f43";
  return "#ff4757";
}

// Triage → boyut
function triageRadius(score: number): number {
  return 6 + score * 2;
}

export function MapView() {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const [isHeatmap, setIsHeatmap] = useState(false);
  const { items, deadZones, flyTo, setSelected, setFlyTo } = useKemple();

  // Haritayı bir kez başlat
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    let protocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    // Tamamen PMTiles tabanlı offline vektörel harita stili
    const offlineStyle: maplibregl.StyleSpecification = {
      version: 8,
      // 100% Offline: Yazı tipleri local'den okunur
      glyphs: "/fonts/{fontstack}/{range}.pbf",
      sources: {
        "protomaps": {
          type: "vector",
          url: "pmtiles:///turkey.pmtiles",
        },
      },
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#0a0e1a" },
        },
        // PMTiles - Kara Parçası
        {
          id: "earth",
          type: "fill",
          source: "protomaps",
          "source-layer": "earth",
          paint: {
            "fill-color": "#131d35",
          },
        },
        // PMTiles - Su ve Deniz
        {
          id: "water",
          type: "fill",
          source: "protomaps",
          "source-layer": "water",
          paint: {
            "fill-color": "#0a0e1a",
          },
        },
        // PMTiles - Yollar
        {
          id: "roads",
          type: "line",
          source: "protomaps",
          "source-layer": "roads",
          paint: {
            "line-color": "#1e3a6e",
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 4],
            "line-opacity": 0.6,
          },
        },
        // PMTiles - Binalar
        {
          id: "buildings",
          type: "fill",
          source: "protomaps",
          "source-layer": "buildings",
          minzoom: 13,
          paint: {
            "fill-color": "#2a4a7f",
            "fill-opacity": 0.5,
          },
        },
        // PMTiles - Sınırlar
        {
          id: "boundaries",
          type: "line",
          source: "protomaps",
          "source-layer": "boundaries",
          paint: {
            "line-color": "#2a4a7f",
            "line-width": 2,
            "line-dasharray": [2, 2],
            "line-opacity": 0.8,
          },
        },
        // PMTiles - Şehir ve İlçe İsimleri
        {
          id: "places-city",
          type: "symbol",
          source: "protomaps",
          "source-layer": "places",
          filter: ["in", "pmap:kind", "city", "town"],
          layout: {
            "text-field": ["get", "name"],
            "text-font": ["Noto Sans Regular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 6, 12, 10, 16],
          },
          paint: {
            "text-color": "#4a7ab5",
            "text-halo-color": "#0a0e1a",
            "text-halo-width": 2,
          },
        },
        // PMTiles - Önemli Yerler (Sokak seviyesi)
        {
          id: "places-neighbourhood",
          type: "symbol",
          source: "protomaps",
          "source-layer": "places",
          filter: ["==", "pmap:kind", "neighbourhood"],
          minzoom: 12,
          layout: {
            "text-field": ["get", "name"],
            "text-font": ["Noto Sans Regular"],
            "text-size": 12,
          },
          paint: {
            "text-color": "#3a6fb5",
            "text-halo-color": "#0a0e1a",
            "text-halo-width": 1.5,
          },
        }
      ],
    };

    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: offlineStyle,
      center: [35.2433, 38.9637], // Türkiye merkez
      zoom: 5.5,
      minZoom: 5,
      maxBounds: [
        [25.664, 35.808], // Güneybatı (SW)
        [44.822, 42.104]  // Kuzeydoğu (NE)
      ],
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl(), "bottom-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Isı haritası katmanını ve kaynağını yöneten yardımcı
  const ensureHeatmapLayer = (map: maplibregl.Map) => {
    if (!map.getSource("heatmap-source")) {
      map.addSource("heatmap-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });
    }
    if (!map.getLayer("heatmap-layer")) {
      map.addLayer({
        id: "heatmap-layer",
        type: "heatmap",
        source: "heatmap-source",
        maxzoom: 18,
        paint: {
          // Triyaj skoruna göre ağırlık ver
          "heatmap-weight": ["interpolate", ["linear"], ["get", "triage_score"], 0, 0.1, 10, 1],
          // Yoğunluğu biraz artırarak ısı merkezlerini belirginleştir
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1.5, 15, 3],
          // Renk paleti: Neon Turkuaz -> Sarı -> Neon Kırmızı
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0, 255, 255, 0)",
            0.2, "rgba(0, 255, 255, 0.3)",
            0.5, "rgba(255, 255, 0, 0.6)",
            0.8, "rgba(255, 0, 0, 0.9)"
          ],
          // Yarıçapı biraz artırarak ısı yayılımını daha yumuşak ve geniş yap
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 5, 9, 25, 15, 55],
          "heatmap-opacity": 0.85
        },
        layout: { visibility: isHeatmap ? "visible" : "none" }
      });
    }
  };

  // Veri değişince marker ve heatmap güncelle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const updateMapData = () => {
      ensureHeatmapLayer(map);

      // 1. Silinen marker'ları temizle
      const currentIds = new Set(items.map(i => i.cluster_id));
      for (const [id, m] of markersRef.current.entries()) {
        if (!currentIds.has(id)) {
          m.remove();
          markersRef.current.delete(id);
        }
      }

      // 2. Marker'ları güncelle veya ekle
      items.forEach((item) => {
        if (!item.centroid || item.centroid.lat === null || item.centroid.lng === null) {
          // Konum yoksa marker çizme, varsa kaldır
          const existingMarker = markersRef.current.get(item.cluster_id);
          if (existingMarker) {
            existingMarker.remove();
            markersRef.current.delete(item.cluster_id);
          }
          return;
        }

        const lat = item.centroid.lat;
        const lng = item.centroid.lng;
        let marker = markersRef.current.get(item.cluster_id);
        
        if (!marker) {
          const el = document.createElement("div");
          const severity = item.triage_score >= 8 ? "critical" : item.triage_score >= 6 ? "high" : item.triage_score >= 4 ? "medium" : "low";
          const confidence = item.confidence_score >= 70 ? "conf-high" : item.confidence_score >= 45 ? "conf-mid" : "conf-low";
          el.className = `custom-marker ${severity} ${confidence}`;
          
          const popup = new maplibregl.Popup({
            offset: 20,
            closeButton: false,
            className: "kemple-popup",
          }).setHTML(`
            <div style="font-family:JetBrains Mono,monospace;font-size:11px;line-height:1.6;color:#e8eaf6">
              <div style="font-weight:700;font-size:13px;margin-bottom:4px">${item.cluster_id}</div>
              <div>🎯 Triyaj: <strong style="color:var(--red)">${item.triage_score.toFixed(1)}</strong></div>
              <div>🔐 Güven: <strong>${item.confidence_score.toFixed(0)}%</strong></div>
              <div>📋 Tip: ${item.event_type}</div>
            </div>
          `);

          marker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([lng, lat])
            .setPopup(popup)
            .addTo(map);
          
          markersRef.current.set(item.cluster_id, marker);
          
          el.onclick = () => {
            setSelected(item.cluster_id);
            map.flyTo({ center: [lng, lat], zoom: 14 });
          };
        }

        // Görünürlük kontrolü
        marker.getElement().style.display = isHeatmap ? "none" : "block";
        marker.setLngLat([lng, lat]);
      });

      // 3. Heatmap verisini güncelle
      const source = map.getSource("heatmap-source") as maplibregl.GeoJSONSource;
      if (source) {
        source.setData({
          type: "FeatureCollection",
          features: items
            .filter(item => item.centroid && item.centroid.lat !== null && item.centroid.lng !== null)
            .map(item => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: [item.centroid!.lng!, item.centroid!.lat!] },
              properties: { triage_score: item.triage_score }
            }))
        });
      }

      // 4. Görsel kontrast ayarı (Premium Kriz Modu)
      if (map.getLayer("earth")) {
        map.setPaintProperty("earth", "fill-color", isHeatmap ? "#0a0c14" : "#131d35"); // Daha derin siyah/lacivert
      }
      if (map.getLayer("buildings")) map.setPaintProperty("buildings", "fill-opacity", isHeatmap ? 0.02 : 0.5);
      if (map.getLayer("roads")) map.setPaintProperty("roads", "line-opacity", isHeatmap ? 0.1 : 0.6);
      if (map.getLayer("heatmap-layer")) {
        map.setLayoutProperty("heatmap-layer", "visibility", isHeatmap ? "visible" : "none");
      }
    };

    if (map.isStyleLoaded()) {
      updateMapData();
    } else {
      map.once("idle", updateMapData);
    }
  }, [items, isHeatmap]);


  // flyTo tetikleyici
  useEffect(() => {
    if (!flyTo || !mapRef.current) return;
    mapRef.current.flyTo({ center: [flyTo.lng, flyTo.lat], zoom: flyTo.zoom, duration: 1000 });
    setFlyTo(null);
  }, [flyTo]);

  // Dead zone'ları göster
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    deadZones.forEach((zone) => {
      if (!zone.centroid || zone.centroid.lat === null || zone.centroid.lng === null) return;
      const el = document.createElement("div");
      const color = zone.severity === "BLACK" ? "#ff4757" :
                    zone.severity === "ORANGE" ? "#ffa502" : "#eccc68";
      
      el.className = `dead-zone-marker ${zone.severity.toLowerCase()}`;
      el.style.cssText = `
        width: 32px; height: 32px;
        background: ${color};
        border: 2px solid white;
        border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
        font-size: 18px; cursor: help;
        box-shadow: 0 0 15px ${color}80;
        z-index: 100;
      `;
      el.innerHTML = "📡"; // Sinyal yok ikonu
      el.title = `${zone.grid_cell_id}: ${zone.silent_duration_mins} dk sessizlik (${zone.severity})`;

      if (zone.severity === "BLACK") {
        el.style.animation = "pulse-deadzone 2s infinite";
      }

      new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([zone.centroid.lng, zone.centroid.lat])
        .addTo(map);
    });
  }, [deadZones]);

  return (
    <div className="map-container">
      <div ref={containerRef} id="map" />
      <div className="map-overlay">
        <button 
          className={`heatmap-toggle ${isHeatmap ? "active" : ""}`}
          onClick={() => setIsHeatmap(!isHeatmap)}
        >
          {isHeatmap ? "🔥 Isı Haritası Açık" : "📍 Marker Modu"}
        </button>

        <div className="map-legend">
          <h4>Pin Rengi — Güven Skoru</h4>
          <div className="legend-item">
            <div className="legend-dot" style={{ background: "#2ed573" }} />
            <span>Yüksek güven (&gt;70)</span>
          </div>
          <div className="legend-item">
            <div className="legend-dot" style={{ background: "#ff9f43" }} />
            <span>Orta güven (45–70)</span>
          </div>
          <div className="legend-item">
            <div className="legend-dot" style={{ background: "#ff4757" }} />
            <span>Düşük güven (&lt;45)</span>
          </div>
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
            <h4>Pin Boyutu — Triyaj Skoru</h4>
          </div>
          <div className="legend-item">
            <div className="legend-dot" style={{ background: "#ff4757", width: 18, height: 18 }} />
            <span>Kritik (8–10)</span>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes pulse-deadzone {
          0% { box-shadow: 0 0 0 0 rgba(255, 71, 87, 0.7); }
          70% { box-shadow: 0 0 0 20px rgba(255, 71, 87, 0); }
          100% { box-shadow: 0 0 0 0 rgba(255, 71, 87, 0); }
        }
        @keyframes pulse-marker {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.2); opacity: 0.8; }
        }
        .kemple-popup .maplibregl-popup-content {
          background: #131d35;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          padding: 12px;
        }
        .kemple-popup .maplibregl-popup-tip {
          border-top-color: #131d35;
        }
      `}</style>
    </div>
  );
}
