/**
 * KEMPLE SyncAgent v1
 * ─────────────────────────────────────────────────────────────────
 * UUID Bloom Filter tabanlı gossip protokolü.
 *
 * Görev: BLE peer'lar arasında have_uuids / want_uuids takası yaparak
 * paketlerin bant genişliğini verimli kullanarak yayılmasını sağlar.
 *
 * Çalışma Modu:
 *   - Her 30 saniyede kendi UUID havuzunu "have" mesajı olarak yayınlar
 *   - Gelen "want" mesajlarına sahip olduğu paketleri gönderir
 *   - 90 saniye görülmeyen UUID'leri temizler (TTL)
 *
 * Demo Modunda:
 *   - Gerçek BLE yokken birden fazla sanal peer simüle edilir
 *   - have/want takası log'lara basılır
 */

const ANNOUNCE_INTERVAL_MS = 30_000;  // 30s yayın döngüsü
const UUID_TTL_MS          = 90_000;  // 90s — daha sonra temizle
const MAX_WANT_RESPONSE    = 20;       // Bir seferde max kaç paket gönder

// ─── Bloom Filter Benzeri UUID Store ──────────────────────────────────────────
// Hafızada tutuyoruz. Cihaz yeniden başlatıldığında sıfırlanır.
// Gerçek uygulamada Redis BITFIELD veya harici BloomFilter kullanılır.
class UUIDStore {
  // Map: uuid -> { seen_at: timestamp, payload?: string }
  #store = new Map();

  add(uuid, payload = null) {
    if (!this.#store.has(uuid)) {
      this.#store.set(uuid, { seen_at: Date.now(), payload });
    }
  }

  has(uuid) {
    return this.#store.has(uuid);
  }

  // Zaman aşımlı UUID'leri temizle
  evict() {
    const cutoff = Date.now() - UUID_TTL_MS;
    let count = 0;
    for (const [uuid, meta] of this.#store) {
      if (meta.seen_at < cutoff) {
        this.#store.delete(uuid);
        count++;
      }
    }
    if (count > 0) {
      console.log(`🧹 SyncAgent: ${count} eski UUID temizlendi`);
    }
  }

  // "have" listesi — son 90 saniyedeki tüm UUID'ler
  haveList() {
    return [...this.#store.keys()];
  }

  // "want" listesi — karşı tarafın have'inden bizde olmayanlar
  wantList(theirHaveList) {
    return theirHaveList.filter(uuid => !this.#store.has(uuid));
  }

  size() {
    return this.#store.size;
  }

  getPayload(uuid) {
    return this.#store.get(uuid)?.payload ?? null;
  }
}

// ─── Peer Simülasyonu (Demo) ──────────────────────────────────────────────────
class SyncAgent {
  #localStore  = new UUIDStore();
  #peers       = new Map();   // peerId -> UUIDStore
  #deviceId;
  #forwardFn;    // paket API'ye iletme callback'i
  #broadcastFn;  // BLE peer'larına HAVE mesajı yayma callback'i

  constructor(deviceId, forwardFn, broadcastFn) {
    this.#deviceId = deviceId;
    this.#forwardFn = forwardFn;
    this.#broadcastFn = broadcastFn;
  }

  // Yeni paket gördüğümüzde kaydet
  addLocal(uuid, payload) {
    this.#localStore.add(uuid, payload);
  }

  // Peer'dan "have" mesajı geldi
  onHaveReceived(peerId, theirHaveList) {
    if (!this.#peers.has(peerId)) {
      this.#peers.set(peerId, new UUIDStore());
    }

    // Peer'ın UUID'lerini kaydet
    for (const uuid of theirHaveList) {
      this.#peers.get(peerId).add(uuid);
    }

    // Bizde olmayan UUID'leri tespit et (want)
    const wantList = this.#localStore.wantList(theirHaveList).slice(0, MAX_WANT_RESPONSE);

    if (wantList.length > 0) {
      console.log(
        `🔄 SyncAgent [${this.#deviceId}]: ` +
        `peer ${peerId} → ${wantList.length} UUID isteniyor`
      );
      // Gerçek BLE'de want mesajı peer'a gönderilir
      // Demo'da: peer'dan payload'ları simüle et
      this.#simulateWantResponse(peerId, wantList);
    }
  }

  // Peer bize "want" listesi gönderdi — sahip olduklarımızı gönder
  onWantReceived(peerId, wantList) {
    const toSend = wantList
      .filter(uuid => this.#localStore.has(uuid))
      .slice(0, MAX_WANT_RESPONSE);

    for (const uuid of toSend) {
      const payload = this.#localStore.getPayload(uuid);
      if (payload && this.#forwardFn) {
        this.#forwardFn({ packet_uuid: uuid, ...JSON.parse(payload) });
        console.log(`📤 SyncAgent [${this.#deviceId}]: peer ${peerId}'e UUID gönderildi: ${uuid.slice(0, 8)}`);
      }
    }
  }

  // Demo: peer'dan eksik UUID'lerin geldiğini simüle et
  #simulateWantResponse(peerId, wantList) {
    for (const uuid of wantList) {
      // UUID bilinmiyorsa sahte payload oluştur (demo)
      this.#localStore.add(uuid, JSON.stringify({ simulated: true, from: peerId }));
      console.log(`  📥 Simüle edildi: ${uuid.slice(0, 8)} ← ${peerId}`);
    }
  }

  // Periyodik have yayını
  announceHave() {
    const haveList = this.#localStore.haveList();
    if (haveList.length === 0) return;

    console.log(
      `📢 SyncAgent [${this.#deviceId}]: ` +
      `${haveList.length} UUID yayınlanıyor (${this.#peers.size} peer)`
    );

    // Gerçek BLE için tüm peer'lara mesaj gönder
    if (this.#broadcastFn) {
      this.#broadcastFn({ type: "HAVE", uuids: haveList });
    } else {
      // Sadece demo modunda log bas
      console.log(`  [DEMO] Broadcast: ${haveList.length} UUID yayılıyor...`);
    }
  }

  // Temizlik döngüsü
  evict() {
    this.#localStore.evict();
    for (const store of this.#peers.values()) {
      store.evict();
    }
  }

  stats() {
    return {
      local_uuids: this.#localStore.size(),
      peer_count:  this.#peers.size,
      device_id:   this.#deviceId,
    };
  }
}

// ─── Ana export ───────────────────────────────────────────────────────────────
export { SyncAgent, UUIDStore };

// ─── Bağımsız çalıştırma (demo) ──────────────────────────────────────────────
if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log("\n🔄 SyncAgent standalone demo başlatıldı\n");

  const agent = new SyncAgent(
    "local-node",
    (pkt) => {
      console.log("  📦 Forward:", pkt.packet_uuid?.slice(0, 8));
    },
    (msg) => {
      console.log("  📡 Broadcast:", msg.type, "->", msg.uuids.length, "UUIDs");
    }
  );

  // Demo UUID'leri ekle
  const demoUUIDs = Array.from({ length: 10 }, () => crypto.randomUUID());
  for (const uuid of demoUUIDs) {
    agent.addLocal(uuid, JSON.stringify({ demo: true }));
  }

  // Peer simülasyonu
  const peerUUIDs = [
    ...demoUUIDs.slice(0, 5),            // 5 ortak
    ...Array.from({ length: 5 }, () => crypto.randomUUID()), // 5 yeni
  ];
  agent.onHaveReceived("peer-001", peerUUIDs);

  // Periyodik döngü
  setInterval(() => agent.announceHave(), ANNOUNCE_INTERVAL_MS);
  setInterval(() => agent.evict(),         UUID_TTL_MS);
  setInterval(() => console.log("📊 Stats:", agent.stats()), 10_000);

  console.log("✅ SyncAgent çalışıyor (Ctrl+C ile durdur)\n");
}
