/**
 * KEMPLE BLE Bridge v2
 * ─────────────────────────────────────────────────────────────────
 * ÇALIŞMA MODLARI:
 *
 * 1. DEMO MODU (varsayılan — noble gerekmez, Windows'ta çalışır)
 *    node src/index.mjs
 *    → Her 3 saniyede sahte afet paketi üretir → Gateway'e gönderir
 *
 * 2. GERÇEK BLE MODU (Linux/Mac, noble kurulu olmalı)
 *    DEMO_MODE=false node src/index.mjs
 *    → BLE tarama yapar, KEMPLE cihazlarından paket alır
 *
 * 3. HTTP RELAY MODU (telefon aynı ağda, BLE yok)
 *    Otomatik — BLE yoksa HTTP üzerinden Gateway'e yönlendirir
 */

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3001";
const DEMO_MODE   = process.env.DEMO_MODE !== "false"; // varsayılan: true
const REDIS_URL   = process.env.REDIS_URL;             // Tanımlıysa doğrudan Redis'e yaz
const REDIS_STREAM = "stream:validated_packets";       // GatewayAgent'ı atlayarak doğrudan yaz

// ─── Renk yardımcıları (terminal output için) ────────────────────
const C = {
  reset:  "\x1b[0m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
};

function log(icon, color, msg) {
  const time = new Date().toLocaleTimeString("tr-TR");
  console.log(`${C.dim}[${time}]${C.reset} ${icon}  ${color}${msg}${C.reset}`);
}

// Redis doğrudan yazma (offline modda gateway'i atlayır)
let redisClient = null;
if (REDIS_URL) {
  try {
    // Dinamik import — ioredis ble-bridge package.json'a bağımlılık olarak eklenmeli
    const { default: Redis } = await import("ioredis");
    redisClient = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    await redisClient.connect().catch(() => {
      log("⚠️ ", C.yellow, `Redis bağlantısı kurulamadı (${REDIS_URL}) — HTTP fallback`);
      redisClient = null;
    });
    if (redisClient) {
      log("🔌", C.cyan, `Doğrudan Redis bağlantısı kuruldu: ${REDIS_URL}`);
    }
  } catch {
    log("⚠️ ", C.yellow, "ioredis kurulu değil — HTTP modunda devam");
  }
}

// ─── Gateway'e veya Redis'e paket gönder ─────────────────────────────
async function forwardToGateway(payload) {
  const packet = {
    packet_uuid:        crypto.randomUUID(),
    device_id:          payload.device_id ?? `ble-${crypto.randomUUID().slice(0, 8)}`,
    payload:            payload.text ?? payload.payload ?? "BLE ihbar alındı",
    timestamp:          payload.timestamp ?? new Date().toISOString(),
    origin_location:    payload.location ?? { lat: 40.9833, lng: 29.0333 },
    last_seen_location: payload.location ?? { lat: 40.9833, lng: 29.0333 },
    schema_version:     "1.0",
    iteration_count:    0,
    // BLE bridge meta
    gateway_node_id:    `ble-bridge-${process.pid}`,
    validation_ts:      new Date().toISOString(),
  };

  // ─── Offline: Doğrudan Redis stream'e yaz ─────────────────────
  if (redisClient) {
    try {
      await redisClient.xadd(REDIS_STREAM, "*", "data", JSON.stringify(packet));
      log("✅", C.green, `[BLE→Redis] ${packet.device_id}: "${packet.payload.slice(0, 55)}"`);
      return;
    } catch (err) {
      log("⚠️ ", C.yellow, `Redis yazma hatası: ${err.message} — HTTP'ye dönülüyor`);
    }
  }

  // ─── Online: HTTP Gateway'e gönder (mevcut davranış) ───────────
  try {
    const res = await fetch(`${GATEWAY_URL}/api/packet`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(packet),
    });

    if (res.ok) {
      log("✅", C.green, `[BLE→GW] ${packet.device_id}: "${packet.payload.slice(0, 55)}"`);
    } else {
      log("⚠️ ", C.yellow, `Gateway ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    log("❌", C.red, `Gateway ulaşılamıyor (${GATEWAY_URL}): ${err.message}`);
    log("💡", C.dim, "Gateway çalışıyor mu? → npm run dev:backend");
  }
}

// ─── Demo Senaryolar ─────────────────────────────────────────────
const SCENARIOS = [
  { device_id: "ble-001", text: "Bina çöktü, enkaz altında mahsur kaldık!", location: { lat: 40.9812, lng: 29.0287 } },
  { device_id: "ble-002", text: "Zemin kat çökmüş, 3 yaralı var ambulans lazım.", location: { lat: 40.9833, lng: 29.0333 } },
  { device_id: "ble-003", text: "Yangın var, dumanla boğuluyoruz!", location: { lat: 40.9788, lng: 29.0401 } },
  { device_id: "ble-004", text: "Enkaz altında 5 kişi, ses geliyor!", location: { lat: 40.9855, lng: 29.0261 } },
  { device_id: "ble-005", text: "Ağır yaralı var, ambulans lütfen gelin.", location: { lat: 40.9801, lng: 29.0345 } },
  { device_id: "ble-002", text: "Hâlâ buradayız, yardım gelmedi.", location: { lat: 40.9833, lng: 29.0333 } }, // aynı device tekrar → gossip
  { device_id: "ble-006", text: "Apartman yıkıldı, bodrum katta 2 kişi.", location: { lat: 40.9866, lng: 29.0318 } },
  { device_id: "ble-007", text: "Su borusu patladı, elektrik var tehlikeli!", location: { lat: 40.9775, lng: 29.0412 } },
];

// ─── UUID Gossip Simülasyonu (Demo Modu) ─────────────────────────────
// Gerçek BLE'de SyncAgent bu mantığı peer-to-peer olarak yürütür.
// Demo'da: her cihaz kendi UUID havuzunu tutar, eksik olanları exchange eder.
const deviceUUIDs = new Map(); // device_id -> Set<packet_uuid>

function gossipExchange(senderDeviceId, packetUUID) {
  // Gönderen cihazın UUID'sini kaydet
  if (!deviceUUIDs.has(senderDeviceId)) {
    deviceUUIDs.set(senderDeviceId, new Set());
  }
  deviceUUIDs.get(senderDeviceId).add(packetUUID);

  // Toplam benzersiz UUID sayısını log'a yaz (gossip metrikleri)
  const totalUnique = new Set([...deviceUUIDs.values()].flatMap(s => [...s])).size;
  if (totalUnique % 5 === 0) {
    log("🔄", C.dim, `Gossip pool: ${totalUnique} benzersiz UUID, ${deviceUUIDs.size} cihaz`);
  }
}

async function startDemoMode() {
  let idx = 0;
  const total = SCENARIOS.length;

  log("🎭", C.cyan, `Demo modu — ${total} senaryo, 3s aralıkla`);
  log("📡", C.dim, `Gateway: ${GATEWAY_URL}${redisClient ? " | Redis: " + REDIS_URL : ""}`);
  console.log("");

  const send = async () => {
    const scenario = SCENARIOS[idx % total];
    const packetUUID = crypto.randomUUID();
    idx++;

    // UUID gossip exchange simülasyonu
    gossipExchange(scenario.device_id, packetUUID);

    await forwardToGateway({ ...scenario, packet_uuid: packetUUID });
  };

  // İlk paketi hemen gönder
  await send();

  // Sonrakileri 3s aralıkla
  const interval = setInterval(send, 3000);

  // 30 paket sonra döngü tekrar başlar (sonsuz demo)
  // Ctrl+C ile durdur
  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("\n\n👋 BLE Bridge kapatıldı.");
    process.exit(0);
  });
}

// ─── Gerçek BLE Modu (noble) ─────────────────────────────────────
async function startBLEMode() {
  let noble;
  try {
    noble = (await import("@abandonware/noble")).default;
  } catch {
    log("⚠️ ", C.yellow, "noble kurulu değil — demo moduna geçiliyor");
    log("💡", C.dim, "Gerçek BLE için: npm install @abandonware/noble (Linux/Mac gerekir)");
    return startDemoMode();
  }

  log("🔵", C.cyan, "BLE tarayıcı başlatılıyor...");

  noble.on("stateChange", (state) => {
    log("📡", C.dim, `BLE durumu: ${state}`);
    if (state === "poweredOn") {
      noble.startScanning([], true);
      log("🔍", C.cyan, "BLE tarama başladı — KEMPLE cihazları bekleniyor");
    } else if (state === "poweredOff") {
      log("⚠️ ", C.yellow, "Bluetooth kapalı — demo moduna geçiliyor");
      noble.stopScanning();
      startDemoMode();
    }
  });

  noble.on("discover", async (peripheral) => {
    const { localName } = peripheral.advertisement;
    // Advertisement ismi KEMPLE veya KEMPLE_NODE olabilir
    if (!localName || !localName.startsWith("KEMPLE")) return;

    log("📶", C.cyan, `KEMPLE cihazı: ${peripheral.id} "${localName}"`);

    try {
      await peripheral.connectAsync();
      // noble kütüphanesi UUID'leri tireli veya tiresiz kabul eder ama genelde küçük harf tiresiz kullanır
      const svcUuid = "6b656d706c652d736572766963652d30";
      const chrUuid = "6b656d706c652d636861722d30303031";
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [svcUuid], [chrUuid]
      );
      if (characteristics.length > 0) {
        const data = await characteristics[0].readAsync();
        const payloadStr = data.toString("utf-8");
        log("📦", C.green, `Cihazdan veri okundu: ${payloadStr.slice(0, 50)}...`);
        const payload = JSON.parse(payloadStr);
        await forwardToGateway({ ...payload, device_id: `ble-${peripheral.id.slice(0, 8)}` });
      }
      await peripheral.disconnectAsync();
    } catch (err) {
      log("⚠️ ", C.yellow, `BLE bağlantı hatası (${peripheral.id}): ${err.message}`);
    }
  });
}

// ─── Ana Giriş ───────────────────────────────────────────────────

console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════╗`);
console.log(`║   KEMPLE BLE Bridge v2.0             ║`);
console.log(`║   Bluetooth → Gateway köprüsü        ║`);
console.log(`╚══════════════════════════════════════╝${C.reset}\n`);

if (DEMO_MODE) {
  await startDemoMode();
} else {
  await startBLEMode();
}
