
const crypto = require('crypto');

const GATEWAY_URL = 'http://localhost:3001/api/packet';

const scenarios = [
  { lat: 39.9086, lng: 41.2768, msg: "Yakutiye Medresesi yakınında bina çöktü, 4 kişi içeride!" },
  { lat: 39.9050, lng: 41.2720, msg: "Cumhuriyet Caddesi'nde doğalgaz patlaması, yangın var!" },
  { lat: 39.8850, lng: 41.2650, msg: "Palandöken kayak merkezi yolunda çığ düştü, araçlar mahsur." },
  { lat: 39.9120, lng: 41.2450, msg: "Atatürk Üniversitesi kampüsünde yaralılar var, acil ambulans!" },
  { lat: 39.9200, lng: 41.2800, msg: "Şükrüpaşa mahallesinde çok sayıda bina hasarlı, su ve gıda lazım." },
  { lat: 39.9000, lng: 41.3000, msg: "Erzurum Şehir Hastanesi çevresinde trafik kilit, tıbbi lojistik desteği gerek." },
  { lat: 39.8950, lng: 41.2500, msg: "Yenişehir bölgesinde elektrikler kesik, jeneratör ve battaniye talebi." },
  { lat: 39.9300, lng: 41.2600, msg: "Dadaşkent girişinde köprü çöktü, ulaşım sağlanamıyor." },
  { lat: 39.9080, lng: 41.2750, msg: "Tarihi Taşmağazalar çarşısında dumanlar yükseliyor, itfaiye!" },
  { lat: 39.8700, lng: 41.2800, msg: "Konaklı kayak merkezinde mahsur kalan bir grup var." },
  { lat: 39.9150, lng: 41.2550, msg: "Kâzım Karabekir Stadyumu yanında toplanma alanı doldu, çadır ihtiyacı." },
  { lat: 39.9020, lng: 41.2700, msg: "Lalapaşa Camii civarında yaşlı bir teyze mahsur, yardım bekliyor." },
  { lat: 39.9250, lng: 41.2900, msg: "Yıldızkent'te asansörde mahsur kalanlar var." },
  { lat: 39.9070, lng: 41.2850, msg: "Erzurum Kalesi arkasında göçük, sesler geliyor!" },
  { lat: 39.8900, lng: 41.2600, msg: "Abdurrahman Gazi mahallesinde heyelan riski var, tahliye gerek." },
  { lat: 39.9100, lng: 41.2400, msg: "Erzurum Teknik Üniversitesi laboratuvarında kimyasal sızıntı şüphesi." },
  { lat: 39.9350, lng: 41.2700, msg: "Tortum yolu üzerinde zincirleme kaza, çok sayıda yaralı." },
  { lat: 39.9050, lng: 41.2650, msg: "MNG AVM içerisinde panik var, çıkışlar kilitlendi." },
  { lat: 39.8800, lng: 41.2700, msg: "Erzurum Gar binasında hasar var, tren seferleri durdu." },
  { lat: 39.9180, lng: 41.2500, msg: "Hilalkent bölgesinde ısınma sorunu var, bebekler için mama gerek." }
];

async function run() {
  console.log(`🚀 20 senaryo gönderiliyor (STRICT SCHEMA)...`);
  for (const s of scenarios) {
    const packet = {
      packet_uuid: crypto.randomUUID(),
      device_id: `device-sim-${Math.floor(Math.random() * 1000)}`,
      payload: s.msg,
      timestamp: new Date().toISOString(),
      origin_location: { lat: s.lat, lng: s.lng },
      last_seen_location: { lat: s.lat, lng: s.lng },
      schema_version: "1.0",
      iteration_count: 0
    };
    try {
      const res = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet)
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`✅ OK: ${s.msg.substring(0, 25)}... ID: ${data.packet_uuid}`);
      } else {
        const error = await res.json();
        console.error(`❌ Error (${res.status}): ${JSON.stringify(error)}`);
      }
    } catch (err) {
      console.error(`❌ Connection Error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`🏁 Simülasyon tamamlandı.`);
}

run();
