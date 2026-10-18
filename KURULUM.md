# KEMPLE — Hackathon Kurulum & Çalıştırma Kılavuzu

## ⚡ Hızlı Başlangıç (Sıfırdan)

```powershell
# 1. Altyapıyı başlat (Redis + PostgreSQL + Ollama)
npm run infra:up

# 2. DB şemasını uygula
npm run db:migrate

# 3. LLM modelini indir (4.9 GB — sadece bir kez)
npm run ollama:pull

# 4. Backend'i başlat
npm run dev:backend

# 5. Dashboard'u başlat (ayrı terminal)
npm run dev:dashboard

# 6. Mobil PWA'yı başlat (ayrı terminal)
npm run dev:mobile

# 7. BLE demo modu (ayrı terminal — bluetooth simülasyonu)
npm run ble:bridge
```

---

## 🌐 Servis Adresleri

| Servis | URL | Açıklama |
|---|---|---|
| Dashboard | http://localhost:5173 | Komuta merkezi |
| Mobil PWA | http://localhost:5174 | Vatandaş ihbar |
| Mobil PWA (LAN) | http://10.x.x.x:5174 | Telefon erişimi |
| Gateway API | http://localhost:3001 | REST endpoint |
| Command WS | ws://localhost:3002/ws | WebSocket |
| Ollama | http://localhost:11434 | LLM API |

---

## 📡 Offline / Bluetooth Çalışma Modları

### Mod 1: BLE Demo (Sunum için — internet gerekmez)
```powershell
# Arka planda sürekli sahte BLE paketi üretir
node apps/ble-bridge/src/index.mjs
```

### Mod 2: Gerçek BLE (Linux/Mac, Bluetooth adaptör gerekir)
```bash
DEMO_MODE=false node apps/ble-bridge/src/index.mjs
```

### Mod 3: Hotspot (Telefonlar + Laptop)
```
Laptop → Windows Hotspot aç
  Ad: "KEMPLE-CMD"  Şifre: "afet2026"
Telefon → KEMPLE-CMD WiFi'ya bağlan
Telefon → Tarayıcı → http://192.168.137.1:5174
```

---

## 🧪 Pipeline Testi

```powershell
# Enkaz senaryosu (8 paket)
node scripts/simulator.mjs --count=8 --scenario=enkaz

# Sybil saldırısı testi
node scripts/simulator.mjs --count=10 --scenario=sybil

# Karma senaryo
node scripts/simulator.mjs --count=15 --scenario=mixed
```

---

## 🗃️ Veritabanı Komutları

```powershell
# Tüm tabloları listele
docker exec kemple-postgres psql -U kemple -d kemple -c "\dt"

# Pipeline verisi kontrolü
docker exec kemple-postgres psql -U kemple -d kemple -c `
  "SELECT c.cluster_id, c.source_count, ROUND(cs.confidence_score,0) conf, ROUND(tr.triage_score,1) triage, tr.event_type FROM clusters c LEFT JOIN confidence_scores cs ON c.cluster_id=cs.cluster_id LEFT JOIN triage_results tr ON c.cluster_id=tr.cluster_id ORDER BY tr.triage_score DESC NULLS LAST LIMIT 10;"

# KVKK: Anonymize edilmiş paketler
docker exec kemple-postgres psql -U kemple -d kemple -c `
  "SELECT COUNT(*) FROM packets WHERE is_anonymized=true;"
```

---

## 🔧 Sorun Giderme

| Sorun | Çözüm |
|---|---|
| `npm: command not found` | PowerShell'i yeniden aç |
| `Cannot find module @kemple/shared` | `npm run build -w packages/shared` çalıştır |
| Gateway'e bağlanılamıyor | `npm run dev:backend` çalışıyor mu? |
| Harita görünmüyor | Normal — PMTiles yokken dark background gösterir |
| Ollama modeli yok | `npm run ollama:pull` (4.9GB, internet gerekir) |
| DB boş | `npm run db:migrate` çalıştır |

---

## 🏗️ Sistem Mimarisi

```
[Telefon/BLE] → [BLE Bridge] → [Gateway :3001]
                                      │
                              [Redis Streams]
                                      │
                   ┌──────────────────┼──────────────────┐
              [DeduplicationAgent] [ConfidenceAgent] [TriageAgent]
                                      │
                              [ReviewAgent]
                                      │
                              [StorageAgent]
                             /        │        \
                    [PostgreSQL]   [Redis]   [CommandAgent :3002]
                                               │ WebSocket
                                         [Dashboard :5173]
```

---

## ✅ Hackathon Demo Akışı

1. **"Sistem tamamen offline"** → Docker containers göster, internet kes
2. **"BLE simülasyonu"** → `node apps/ble-bridge/src/index.mjs` başlat
3. **Dashboard** → http://localhost:5173 aç, paketlerin geldiğini göster
4. **AI Triage** → Cluster A-0003 seç, triage skorunu göster
5. **Operatör kararı** → "Onayla" tıkla, kuyruktan kalktığını göster
6. **KVKK** → "90 gün sonra otomatik anonimleştiriliyor" vurgula
7. **Mobil** → Telefondan http://LAN_IP:5174 aç, gerçek form doldur
