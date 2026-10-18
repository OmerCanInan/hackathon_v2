#!/usr/bin/env node
/**
 * KEMPLE — Demo Paket Simülatörü
 * Gerçekçi Türkçe ihbar mesajları üreterek GatewayAgent'a gönderir.
 * Kullanım: node scripts/simulator.mjs [--count=20] [--scenario=enkaz]
 */

import { randomUUID } from "crypto";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3001";
const args = process.argv.slice(2);
const count = parseInt(args.find(a => a.startsWith("--count="))?.split("=")[1] ?? "10");
const scenario = args.find(a => a.startsWith("--scenario="))?.split("=")[1] ?? "mixed";
const delay = parseInt(args.find(a => a.startsWith("--delay="))?.split("=")[1] ?? "500");

// ─── Senaryo Tanımları ─────────────────────────────────────────────────────

// Kadıköy bölgesi koordinatları (demo için)
const BASE_LAT = 40.9833;
const BASE_LNG = 29.0333;

const SCENARIOS = {
  enkaz: [
    "Bina çöktü 5 kişi mahsur altında yardım edin acil",
    "Enkaz var 3. katta mahsur kaldık çıkamıyoruz",
    "Apartman yıkıldı bodrum katta 2 kişi var",
    "İçerideyiz 4 kişiyiz enkaz altındayız nefes almakta güçlük çekiyoruz",
    "Bina çöktü komşularım mahsur arama kurtarma lazım",
    "Zemin kat çökmüş 3 yaralı var ambulans lazım",
  ],
  tibbi: [
    "Yaralı var yardım edin kolu kırık çok kan var",
    "Komşum bayıldı kalp krizi geçiriyor ambulans lazım",
    "Kaza oldu 2 kişi yaralı nefes alamıyor",
    "Çocuk kafasını çarptı bilincini kaybetti acil yardım",
  ],
  yangin: [
    "Yangın var 3. katta alev var kaçamıyoruz",
    "Bina yanıyor içeride mahsur kaldık",
    "Duman çok yoğun nefes alamıyoruz itfaiye çağırın",
  ],
  lojistik: [
    "Köprü yıkıldı geçiş yok ambulans giremez",
    "Yol kapalı enkaz var araçlar geçemiyor",
    "Su bitti içecek su yok 50 kişilik mahalle",
    "Elektrik yok oksijen makinesi olan hastalar tehlikede",
  ],
  sybil: [
    // Sybil saldırısı simülasyonu — tek device'tan çok mesaj
    "Enkaz var yardım",
  ],
  mixed: null, // Rastgele seçim
};

// ─── Paket Üretici ─────────────────────────────────────────────────────────

function randomOffset(range = 0.003) {
  return (Math.random() - 0.5) * range;
}

function generatePacket(overrideDeviceId = null, messageIndex = 0) {
  const deviceId = overrideDeviceId ?? `device-${randomUUID().slice(0, 8)}`;

  let messages;
  if (scenario === "sybil") {
    messages = SCENARIOS.sybil;
  } else if (scenario === "mixed") {
    const types = ["enkaz", "tibbi", "yangin", "lojistik"];
    messages = SCENARIOS[types[Math.floor(Math.random() * types.length)]];
  } else {
    messages = SCENARIOS[scenario] ?? SCENARIOS.enkaz;
  }

  const payload = messages[Math.floor(Math.random() * messages.length)];

  // %20 ihtimalle konum bilgisi alınamasın (null)
  const hasLocation = Math.random() > 0.2;

  return {
    packet_uuid: randomUUID(),
    device_id: deviceId,
    payload,
    timestamp: new Date().toISOString(),
    origin_location: hasLocation ? {
      lat: BASE_LAT + randomOffset(),
      lng: BASE_LNG + randomOffset(),
    } : null,
    last_seen_location: hasLocation ? {
      lat: BASE_LAT + randomOffset(0.01),
      lng: BASE_LNG + randomOffset(0.01),
    } : null,
    schema_version: "1.0",
    iteration_count: 0,
  };
}

// ─── Gönderici ─────────────────────────────────────────────────────────────

async function sendPacket(packet) {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/packet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(packet),
    });
    const body = await res.json();
    const status = res.ok ? "✅" : "❌";
    console.log(`${status} [${res.status}] ${packet.device_id.slice(0, 12)} → ${packet.payload.slice(0, 40)}...`);
    return { ok: res.ok, ...body };
  } catch (err) {
    console.error(`❌ Bağlantı hatası: ${err.message}`);
    return { ok: false };
  }
}

// ─── Ana Akış ──────────────────────────────────────────────────────────────

console.log(`\n🚀 KEMPLE Simülatör Başladı`);
console.log(`📍 Gateway: ${GATEWAY_URL}`);
console.log(`📦 Paket sayısı: ${count}`);
console.log(`🎭 Senaryo: ${scenario}`);
console.log(`⏱️  Gecikme: ${delay}ms\n`);

// Sybil saldırısı için tek device ID
const sybilDeviceId = scenario === "sybil" ? `sybil-device-${randomUUID().slice(0, 6)}` : null;

let sent = 0, accepted = 0, rejected = 0;

for (let i = 0; i < count; i++) {
  const packet = generatePacket(sybilDeviceId, i);
  const result = await sendPacket(packet);

  sent++;
  if (result.ok) accepted++;
  else rejected++;

  if (i < count - 1) {
    await new Promise(r => setTimeout(r, delay));
  }
}

console.log(`\n📊 Özet:`);
console.log(`   Gönderilen : ${sent}`);
console.log(`   Kabul edilen: ${accepted}`);
console.log(`   Reddedilen  : ${rejected}`);

if (scenario === "sybil") {
  console.log(`\n⚠️  Sybil saldırısı simüle edildi. Device ID: ${sybilDeviceId}`);
  console.log(`   Confidence skorunun düştüğünü dashboard'dan gözlemleyin.`);
}
