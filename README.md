# KEMPLE — Afet İhbar Triyaj Sistemi

KEMPLE, deprem gibi afetlerde vatandaşlardan gelen yardım ihbarlarını toplayan, aynı olaya ait ihbarları birleştiren, güvenilirliğini ve aciliyetini puanlayan ve sonucu bir komuta merkezi ekranında öncelik sırasıyla gösteren bir sistemdir. İnternet olmadan da çalışacak şekilde tasarlanmıştır. Yapay zeka modeli (Ollama + Llama 3.1) yerelde çalışır, harita çevrimdışı açılır ve ihbarlar Wi-Fi hotspot ya da Bluetooth üzerinden taşınabilir.

Proje bir hackathon için geliştirilmiştir.

---

## İçindekiler

- [Ne yapar?](#ne-yapar)
- [Mimari](#mimari)
- [Ajanlar ve veri akışı](#ajanlar-ve-veri-akışı)
- [Puanlama mantığı](#puanlama-mantığı)
- [Proje yapısı](#proje-yapısı)
- [Kullanılan teknolojiler](#kullanılan-teknolojiler)
- [Kurulum](#kurulum)
- [Çalıştırma](#çalıştırma)
- [Demo ve simülasyon](#demo-ve-simülasyon)
- [Çevrimdışı çalışma ve Bluetooth](#çevrimdışı-çalışma-ve-bluetooth)
- [Ortam değişkenleri](#ortam-değişkenleri)
- [Veritabanı](#veritabanı)
- [KVKK](#kvkk)
- [Bilinen sınırlamalar](#bilinen-sınırlamalar)

---

## Ne yapar?

**Vatandaş tarafı (mobil uygulama)**
- Tek dokunuşla "ENKAZ ALTINDAYIM" acil ihbarı ya da serbest metinli bildiri (kişi sayısıyla birlikte) gönderilir.
- GPS konumu sürekli takip edilir. Hassas konum alınamazsa 2 dakika sonra Wi-Fi/şebeke tabanlı yaklaşık konuma geçilir.
- İhbar önce HTTP ile (hotspot/Wi-Fi) gönderilir. Bu başarısız olursa Android'de telefon bir Bluetooth (BLE) yayıncısına dönüşür ve paketi yayınlar.
- Gönderim için KVKK onayı gerekir.

**Sunucu tarafı (yapay zeka ajanları)**
- Gelen paket doğrulanır: şema, kara liste, Türkiye sınırı, hız limiti ve cihaz saati kontrol edilir.
- Yerel LLM, ihbar metninden konum, kişi sayısı ve aciliyet ipucu çıkarır ve metni sadeleştirir.
- 50 metre yarıçap, 30 dakika ve aynı olay kategorisi kriterleriyle aynı olaya ait ihbarlar tek bir **kümede** birleştirilir.
- Her küme için bir **güven skoru** (0–100) hesaplanır. Bu skor bağımsız kaynak sayısına, bot benzeri zamanlamaya, Sybil saldırısı şüphesine ve cihaz itibarına bakar.
- Her küme için bir **triyaj skoru** (0–10) ve olay tipi belirlenir. Bu işi LLM yapar ve 300 örneklik bir veri setinden RAG ile benzer örnekler alır. LLM çalışmazsa kural motoru devreye girer.
- Bir **inceleme ajanı** iki skoru çapraz kontrol eder. Tutarsızlık varsa ilgili ajandan revizyon ister (en fazla 2 tur). Şüpheli durumları operatör onayına bekletir.
- Bir süredir hiç ihbar gelmeyen bölgeler **ölü bölge** olarak işaretlenir. Bu bölgelerde iletişim kopmuş olabilir.

**Komuta merkezi (dashboard)**
- Çevrimdışı vektör harita gösterir. Pin rengi güven skorunu, pin boyutu triyaj skorunu belirtir. Isı haritası modu da vardır.
- Triyaj kuyruğu aciliyete göre sıralanır ve 8 ve üzeri skorlar "KRİTİK" olarak işaretlenir.
- Detay panelinde yapay zeka özeti, gerekçe ve orijinal saha mesajları görünür.
- Operatör kararları: **İlgileniliyor** (beklemeye al), **İlgilenildi** (onayla), **Yanlış ihbar** (reddet).
- Operatör kararları cihaz itibarını günceller. İtibarı düşen cihazlar otomatik olarak kara listeye alınır.

---

## Mimari

```mermaid
flowchart LR
    subgraph Saha
        M[Mobil uygulama<br/>React + Capacitor]
        B[BLE Bridge<br/>Node.js]
    end

    M -- HTTP --> G
    M -. BLE .-> B
    B -- HTTP / doğrudan Redis --> G

    G[Gateway :3001<br/>doğrulama, rate limit,<br/>kara liste]

    subgraph Ajanlar [Ajanlar · Redis Streams]
        I[IntakeAgent<br/>LLM zenginleştirme]
        D[DeduplicationAgent<br/>coğrafi kümeleme]
        C[ConfidenceAgent<br/>güven skoru]
        T[TriageAgent<br/>LLM + RAG triyaj]
        R[ReviewAgent<br/>çapraz kontrol]
        S[StorageAgent<br/>kuyruk, itibar,<br/>ölü bölge, KVKK]
    end

    G --> I --> D --> C
    C --> T
    C --> R
    T --> R
    R -. revizyon .-> C
    R -. revizyon .-> T
    R --> S

    S --> CMD[CommandAgent :3002<br/>REST + WebSocket]
    CMD <--> DB[Dashboard :5173<br/>React + MapLibre]

    O[(Ollama<br/>llama3.1:8b)] --- I
    O --- T
    PG[(PostgreSQL + PostGIS)] --- C
    PG --- T
    PG --- R
    PG --- S
```

Tüm servisler birbirleriyle **Redis Streams** ve consumer group'lar üzerinden haberleşir. İşlenemeyen mesajlar `stream:dead_letter_queue` akışına yazılır.

---

## Ajanlar ve veri akışı

| Ajan | Okuduğu stream | Yazdığı stream | Görevi |
|---|---|---|---|
| **GatewayAgent** (`apps/gateway`) | HTTP `POST /api/packet` | `validated_packets` | Zod şema doğrulaması, kara liste (30 sn'de bir senkronize edilir), Türkiye sınır kutusu, cihaz başına dakikalık hız limiti, ±10 dk saat sapması kontrolü |
| **IntakeAgent** | `validated_packets` | `enriched_packets` | LLM ile metinden konum, kişi sayısı ve aciliyet çıkarır, metni sadeleştirir. 3 hatadan sonra 5 dakikalığına devre kesici açılır. |
| **DeduplicationAgent** | `enriched_packets` | `cluster_events` | UUID ile tekrar engelleme, Redis GEO ile 50 m / 30 dk / aynı kategori kümeleme, ağırlıklı merkez hesabı, ölü bölge takibi için grid aktivitesi |
| **ConfidenceAgent** | `cluster_events`, `revision_requests` | `scored_events`, `confidence_to_review` | Güven skoru (0–100) ve anomali bayrakları |
| **TriageAgent** | `scored_events`, `revision_requests` | `triage_results` | LLM + RAG ile triyaj skoru, olay tipi, tıbbi aciliyet, önerilen kaynaklar. 2 hatadan sonra devre kesici açılır ve kural motoru çalışır. |
| **ReviewAgent** | `triage_results`, `confidence_to_review`, `operator_ack` | `review_approved`, `revision_requests`, `operator_ack` | İki skoru Lua script ile atomik olarak eşleştirir, tutarsızlıkta revizyon ister (en fazla 2 tur), şüpheli kümeleri operatör onayına bekletir |
| **StorageAgent** | `review_approved`, `operator_decisions` | `review_items`, `dead_zone_alerts` | Öncelik kuyrukları (ZSET), cihaz itibarı ve kara liste, ölü bölge taraması, 90 günlük KVKK anonimleştirme |
| **CommandAgent** (`apps/command`) | `review_items`, `dead_zone_alerts`, `operator_ack` | `operator_decisions`, `operator_ack` | Dashboard'a WebSocket ile canlı yayın, REST API |

Altı ajan (`Intake`'ten `Storage`'a kadar) tek bir Node.js sürecinde (`apps/agents`) paralel çalışır. Her ajanın kendi Redis bağlantısı vardır.

### Olay tipleri

`ENKAZ_MAHSUR`, `TIBBI_ACIL`, `YANGIN`, `LOJISTIK`, `BILGI_TALEBI`, `BELIRSIZ`

---

## Puanlama mantığı

### Güven skoru (ConfidenceAgent, 0–100)

| Kural | Etki |
|---|---|
| Başlangıç | 40 |
| Her ek bağımsız kaynak | +12 (en fazla +48) |
| ≥5 paket ama ≤2 cihaz (Sybil şüphesi) | −30, `SYBIL_SUSPECT` |
| Paketler arası süre 1 sn – 20 dk (organik) | +8 |
| Paketler arası süre ≤1 sn (bot) | −25, `BOT_TIME_GAP` |
| ≥3 kaynak (koordinat tutarlılığı) | +10 |
| İtibarı 0.1'in altında olan her cihaz | −40, `BLACKLISTED_DEVICE` |

### Triyaj skoru (TriageAgent, 0–10)

LLM'e verilen ağırlıklar şunlardır: hayati tehlike %35, kişi sayısı %20, tıbbi aciliyet %20, güven %15, zaman %10. Prompt'a, `raw-dataset.json` dosyasındaki 300 etiketli gerçekçi ihbardan embedding benzerliğine göre seçilen en yakın 3 örnek eklenir (RAG).

LLM yanıt vermezse ya da geçersiz JSON dönerse **kural motoru** devreye girer. Kural motoru anahtar kelimelere (enkaz, yangın, yaralı, gıda vb.) göre toplamalı puan verir ve sonucu güven skoruyla ölçekler.

### İnceleme ve eskalasyon (ReviewAgent)

Aşağıdaki durumlar tutarsızlık sayılır ve revizyon istenir:
- Triyaj > 8 ama güven < 30
- Tek kaynaklı ve güveni < 50 olan `ENKAZ_MAHSUR`
- `SYBIL_SUSPECT` bayrağı varken triyaj > 6

İki revizyon turundan sonra şu durumlarda küme **operatör onayına** bekletilir: (güven < 20 **ve** triyaj > 7) **ya da** 2 veya daha fazla anomali bayrağı varsa. Diğer kümeler doğrudan onaylanır ve kuyruğa girer.

### Cihaz itibarı ve kara liste

Her cihaz 0.5 itibarla başlar. Operatör onayı +0.1, red −0.2 etki eder. İtibarı 0.1'in altına düşen cihaz `blacklist:active` kümesine alınır ve Gateway bu cihazdan gelen paketleri 403 ile reddeder.

### Ölü bölgeler

Harita yaklaşık 50×50 m'lik grid hücrelerine bölünür. StorageAgent her dakika, daha önce ihbar gelmiş ama sonra sessizleşmiş hücreleri tarar:

| Sessizlik | Seviye |
|---|---|
| ≥30 dk | Sarı |
| ≥60 dk | Turuncu |
| ≥120 dk | Siyah (haritada yanıp söner) |

---

## Proje yapısı

npm workspaces ile yönetilen bir monorepo:

```
hackathon_v2/
├── apps/
│   ├── gateway/        # Fastify — paket kabul ve doğrulama (:3001)
│   ├── agents/         # 6 ajan + Prisma şeması + RAG
│   │   ├── prisma/schema.prisma
│   │   └── src/
│   │       ├── intake-agent.ts
│   │       ├── dedup-agent.ts
│   │       ├── confidence-agent.ts
│   │       ├── triage-agent.ts
│   │       ├── review-agent.ts
│   │       ├── storage-agent.ts
│   │       ├── lib/ollama.ts          # prompt, kural motoru, embedding
│   │       ├── lib/raw-dataset.json   # 300 etiketli örnek ihbar
│   │       └── scripts/build-rag.ts   # RAG vektör veritabanını üretir
│   ├── command/        # Fastify + WebSocket — dashboard köprüsü (:3002)
│   ├── dashboard/      # React + MapLibre komuta ekranı (:5173)
│   │   └── public/     # çevrimdışı fontlar ve sprite'lar
│   ├── mobile/         # React + Capacitor vatandaş uygulaması (:5174, Android)
│   └── ble-bridge/     # BLE → Gateway köprüsü (demo / gerçek mod)
├── packages/
│   └── shared/         # Ortak tipler, Zod şemaları, Redis anahtarları
├── infra/
│   ├── docker-compose.yml   # Redis 7, PostgreSQL 16 + PostGIS, Ollama
│   └── init.sql             # Veritabanı tabloları
├── scripts/
│   ├── simulator.mjs        # Senaryolu paket simülatörü
│   └── download-tiles.mjs   # (eski) Erzurum raster tile indirici
├── simulate.py              # 300 ihbarlık veri setini gönderir
├── simulate_100.py          # Rastgele 100 tanesini gönderir
├── KURULUM.md               # Kısa kurulum ve demo kılavuzu
└── .env.example
```

---

## Kullanılan teknolojiler

| Katman | Teknoloji |
|---|---|
| Dil | TypeScript (Node.js ≥ 18, ESM) |
| Sunucu | Fastify, @fastify/websocket |
| Mesajlaşma | Redis 7 Streams, consumer groups, GEO komutları, Lua |
| Veritabanı | PostgreSQL 16 + PostGIS, Prisma ORM |
| Yapay zeka | Ollama, `llama3.1:8b` (üretim + embedding) |
| Doğrulama | Zod |
| Dashboard | React 19, Vite, Zustand, MapLibre GL, PMTiles |
| Mobil | React 19, Vite, Capacitor 8 (Android), `@capacitor/geolocation`, `cordova-plugin-ble-peripheral` |
| BLE köprüsü | `@abandonware/noble` (isteğe bağlı) |
| Altyapı | Docker Compose |

---

## Kurulum

### Gereksinimler

- Node.js 18 veya üzeri ve npm
- Docker ve Docker Compose
- Ollama modeli için yaklaşık 5 GB disk ve en az 8 GB RAM. GPU şart değil ama hız için önerilir; `infra/docker-compose.yml` içindeki GPU satırlarını açabilirsin.
- Android uygulaması için (isteğe bağlı): Android Studio

### Adımlar

```bash
# 1. Bağımlılıkları kur
npm install

# 2. Ortak paketi derle (diğer tüm uygulamalar buna bağlı)
npm run build -w packages/shared

# 3. Ortam değişkenlerini ayarla
#    Ajanlar .env dosyasını kendi klasöründen okur (apps/agents/.env).
#    En azından DATABASE_URL gereklidir:
echo 'DATABASE_URL=postgresql://kemple:kemple123@localhost:5432/kemple' > apps/agents/.env

# 4. Redis, PostgreSQL ve Ollama'yı başlat
npm run infra:up

# 5. Veritabanı şemasını uygula
npm run db:migrate

# 6. LLM modelini indir (~4.9 GB, yalnızca bir kez)
npm run ollama:pull

# 7. (İsteğe bağlı ama önerilir) RAG vektör veritabanını üret
#    300 örneği vektörleştirip apps/agents/src/lib/rag-db.json dosyasına yazar.
cd apps/agents && npx tsx src/scripts/build-rag.ts && cd ../..
```

> **Windows:** Komutlar PowerShell'de çalışır. Sadece 3. adımdaki `echo` satırı yerine `apps/agents/.env` dosyasını elle oluştur.

### Çevrimdışı harita

Dashboard, haritayı `apps/dashboard/public/turkey.pmtiles` dosyasından okur. Bu dosya büyük olduğu için repoda yok (`.gitignore`'da). [Protomaps](https://docs.protomaps.com/guide/getting-started) üzerinden Türkiye (ya da demo bölgesi) için bir `.pmtiles` çıkarımı alıp bu konuma koy. Dosya yoksa harita koyu bir arka planla açılır ve pinler yine görünür.

Fontlar ve sprite'lar `apps/dashboard/public/` altında hazırdır.

---

## Çalıştırma

Her biri ayrı bir terminalde:

```bash
npm run dev:backend     # Gateway + Ajanlar + Command
npm run dev:dashboard   # Komuta merkezi
npm run dev:mobile      # Vatandaş uygulaması
```

Ya da hepsini tek terminalde: `npm run dev`

| Servis | Adres |
|---|---|
| Dashboard | http://localhost:5173 |
| Mobil uygulama | http://localhost:5174 (LAN'dan `http://<bilgisayar-ip>:5174`) |
| Gateway API | http://localhost:3001 |
| Command API / WebSocket | http://localhost:3002 · `ws://localhost:3002/ws` |
| Ollama | http://localhost:11434 |

### API uçları

**Gateway (:3001)**
- `GET /health`
- `POST /api/packet`: tek ihbar paketi (202 kabul / 400 / 403 / 422 / 429)
- `POST /api/simulate`: paket dizisi
- `GET /api/blacklist`

**Command (:3002)**
- `GET /health`
- `GET /api/queue`: aktif ve bekleyen kuyruk
- `GET /api/escalated`
- `GET /api/dead-zones`
- `POST /api/decision`: operatör kararı (`approve` / `reject` / `hold`)
- `POST /api/inject`: kuyruğa doğrudan öğe ekler (demo)
- `GET /ws`: WebSocket (`QUEUE_INIT`, `NEW_ITEM`, `DEAD_ZONE`, `OPERATOR_HOLD`, `ACK`)

### Paket formatı

```json
{
  "packet_uuid": "c0a8f3e2-...",
  "device_id": "device-1a2b3c4d5e6f",
  "payload": "Bina çöktü 3 kişi mahsur",
  "timestamp": "2026-11-13T10:00:00.000Z",
  "origin_location": { "lat": 40.9833, "lng": 29.0333 },
  "last_seen_location": { "lat": 40.9833, "lng": 29.0333 },
  "schema_version": "1.0",
  "iteration_count": 0
}
```

### Telefondan kullanım

Mobil uygulama varsayılan olarak `http://localhost:3001` adresine gönderir. Telefondan test ederken gateway adresini bilgisayarın LAN IP'si yap:

```bash
# apps/mobile/.env
VITE_GATEWAY_URL=http://192.168.137.1:3001
```

Ardından telefonun tarayıcısından `http://<bilgisayar-ip>:5174` adresini aç. Android uygulaması için `apps/mobile` içinde `npm run build && npx cap sync android` çalıştırıp `android/` klasörünü Android Studio ile aç.

---

## Demo ve simülasyon

```bash
# Senaryolu simülatör (Kadıköy çevresi)
node scripts/simulator.mjs --count=8  --scenario=enkaz
node scripts/simulator.mjs --count=10 --scenario=sybil    # tek cihazdan sel → güven düşer
node scripts/simulator.mjs --count=15 --scenario=mixed
# Diğer senaryolar: tibbi, yangin, lojistik · ek parametre: --delay=500 (ms)

# Gerçekçi veri seti
python simulate.py        # 300 etiketli ihbar
python simulate_100.py    # rastgele 100 tanesi

# BLE köprüsü demo modu: 3 sn'de bir sahte Bluetooth paketi
npm run ble:bridge
```

### Önerilen sunum akışı

1. Docker konteynerlerini göster ve interneti kes. Sistem çevrimdışı çalışır.
2. `npm run ble:bridge` ile Bluetooth simülasyonunu başlat.
3. Dashboard'da paketlerin gelişini ve kümelenmesini göster.
4. Bir kümeyi seçip triyaj skorunu, yapay zeka gerekçesini ve orijinal mesajları göster.
5. "İlgilenildi" ile kararı ver; küme kuyruktan çıkar.
6. `--scenario=sybil` ile sahte ihbar saldırısını ve güvenin düşmesini göster.
7. Telefondan `http://<LAN-IP>:5174` adresini açıp gerçek bir ihbar gönder.

---

## Çevrimdışı çalışma ve Bluetooth

| Mod | Nasıl | Not |
|---|---|---|
| **Hotspot** | Bilgisayar Wi-Fi hotspot açar, telefonlar bağlanıp `http://192.168.137.1:5174` adresini kullanır | İnternet gerekmez |
| **BLE demo** | `node apps/ble-bridge/src/index.mjs` | Gerçek Bluetooth gerekmez, Windows'ta çalışır |
| **Gerçek BLE** | `DEMO_MODE=false node apps/ble-bridge/src/index.mjs` | Linux/macOS + Bluetooth adaptörü + `@abandonware/noble`. "KEMPLE" adıyla yayın yapan telefonlara bağlanıp paketi okur. |
| **Doğrudan Redis** | `REDIS_URL=redis://localhost:6379 node apps/ble-bridge/src/index.mjs` | Köprü, Gateway'i atlayıp doğrudan `validated_packets` akışına yazar |

Mobil tarafta HTTP gönderimi başarısız olursa ve uygulama Android'de native çalışıyorsa, telefon `6b656d70-6c65-2d73-6572-766963652d30` servis UUID'siyle bir GATT sunucusu olarak paketi yayınlar.

`apps/ble-bridge/src/sync-agent.mjs`, cihazlar arası UUID gossip (have/want) protokolünün bağımsız bir prototipidir.

---

## Ortam değişkenleri

Tüm değişkenler isteğe bağlıdır ve varsayılan değerleri vardır. Tek zorunlu değişken `DATABASE_URL`'dir. Şablon için kök dizindeki `.env.example` dosyasına bak.

| Değişken | Varsayılan | Kullanan |
|---|---|---|
| `DATABASE_URL` | yok | agents (Prisma) |
| `REDIS_URL` | `redis://localhost:6379` | gateway, agents, command, ble-bridge |
| `OLLAMA_HOST` | `http://localhost:11434` | agents |
| `OLLAMA_MODEL` | `llama3.1:8b` | agents |
| `OLLAMA_TIMEOUT_MS` | `5000` | agents (triyaj) |
| `GATEWAY_PORT` | `3001` | gateway |
| `GATEWAY_NODE_ID` | `gateway-1` | gateway |
| `RATE_LIMIT_MAX` | `100` | gateway (cihaz/dakika) |
| `LOG_LEVEL` | `info` | gateway |
| `COMMAND_PORT` | `3002` | command |
| `CLUSTER_RADIUS_M` | `50` | agents (kümeleme yarıçapı) |
| `CLUSTER_TIME_MS` | `1800000` | agents (kümeleme zaman penceresi) |
| `GATEWAY_URL` | `http://localhost:3001` | ble-bridge, simülatör |
| `DEMO_MODE` | `true` | ble-bridge |
| `VITE_GATEWAY_URL` | `http://localhost:3001` | mobil |
| `VITE_COMMAND_URL` | `http://localhost:3002` | dashboard |
| `VITE_WS_URL` | `ws://localhost:3002/ws` | dashboard |

> `VITE_` ile başlayan değişkenler tarayıcıya gömülür. Bunlara gizli değer koyma.

---

## Veritabanı

Docker'daki varsayılan bağlantı: `postgresql://kemple:kemple123@localhost:5432/kemple`. Bu şifre yalnızca yerel geliştirme içindir.

Başlıca tablolar: `clusters`, `confidence_scores`, `triage_results` (her iterasyon ayrı satır, sonuncusu `is_final`), `review_decisions`, `operator_decisions` (anlık skor görüntüsüyle denetim kaydı), `packets`, `device_reputation`, `blacklist`, `dead_zones`, `resource_assignments`, `dlq_log`.

Şema hem `infra/init.sql` (konteyner ilk açıldığında) hem de `apps/agents/prisma/schema.prisma` (`npm run db:migrate`) ile tanımlıdır.

```bash
# Son kümeler, skorlarıyla
docker exec kemple-postgres psql -U kemple -d kemple -c \
  "SELECT c.cluster_id, c.source_count, ROUND(cs.confidence_score,0) conf, ROUND(tr.triage_score,1) triage, tr.event_type
   FROM clusters c
   LEFT JOIN confidence_scores cs ON c.cluster_id=cs.cluster_id
   LEFT JOIN triage_results tr ON c.cluster_id=tr.cluster_id
   ORDER BY tr.triage_score DESC NULLS LAST LIMIT 10;"
```

---

## KVKK

- Mobil uygulamada, verilerin afet koordinasyonu için 90 gün işlenmesine onay verilmeden ihbar gönderilemez.
- StorageAgent 24 saatte bir, 90 günden eski paketlerin metnini `[KVKK-ANON]` ile değiştirir ve konum bilgisini siler (`is_anonymized = true`).

---

## Bilinen sınırlamalar

Bu bir hackathon prototipidir. Gerçek kullanımdan önce şu noktalara dikkat edilmeli:

- **Kimlik doğrulama yok.** Gateway ve Command API'leri herkese açıktır; operatör kimliği sabit (`operator-1`).
- **Test için konum ataması:** Gateway, konumu Türkiye dışında olan paketlere Kadıköy koordinatı atar (`gateway-agent.ts`). Üretimde bu paketlerin reddedilmesi gerekir.
- **Konumsuz paketler reddedilir:** Mobil uygulama GPS yokken `origin_location: null` gönderir, ancak Zod şeması null kabul etmez ve Gateway 400 döner.
- **Bağımsız kaynak sayısı artmıyor:** `dedup-agent.ts` içinde yeni cihaz kontrolü (`isNewDevice`), cihaz listeye eklendikten sonra yapıldığı için `source_count` 1'de kalıyor. Bu yüzden güven skorundaki kaynak bonusu ve koordinat tutarlılığı puanı devreye girmiyor. Ayrıca farklı cihazlardan gelen 5+ paketlik kümeler yanlışlıkla Sybil şüphesi alabiliyor.
- **`packets` tablosuna yazılmıyor:** Paketler yalnızca Redis'te tutuluyor. Bu yüzden KVKK anonimleştirmesi şu an işleyecek veri bulamıyor.
- **Mobil uygulamadaki "N cihaz kapsama alanında"** göstergesi rastgele üretilen bir simülasyondur.
- `@kemple/shared` içindeki `rateLimitMax: 5` sabiti kullanılmıyor; gerçek limit `RATE_LIMIT_MAX` (varsayılan 100).
- `scripts/download-tiles.mjs` eski raster yaklaşımına aittir; dashboard artık PMTiles kullanıyor.

---

Daha kısa bir kurulum ve sorun giderme rehberi için [KURULUM.md](KURULUM.md) dosyasına bakabilirsin.
