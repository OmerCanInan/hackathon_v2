/**
 * KEMPLE BLE Peripheral Client
 * Bu istemci telefonu bir "Akıllı Saat" (GATT Server / Yayıncı) gibi davranmaya zorlar.
 */
import { Capacitor } from "@capacitor/core";

// Geçerli UUID formatları (8-4-4-4-12)
const KEMPLE_SERVICE_UUID = "6b656d70-6c65-2d73-6572-766963652d30";
const KEMPLE_CHAR_UUID    = "6b656d70-6c65-2d63-6861-722d30303031";

export function isBLEAvailable(): boolean {
  // cordova-plugin-ble-peripheral sadece native'de çalışır
  return Capacitor.isNativePlatform() && !!(window as any).blePeripheral;
}

function stringToBytes(string: string) {
    const array = new Uint8Array(string.length);
    for (let i = 0, l = string.length; i < l; i++) {
        array[i] = string.charCodeAt(i);
    }
    return array.buffer;
}

let peripheralInitialized = false;

async function initPeripheral() {
  if (peripheralInitialized) return;
  
  const blePeripheral = (window as any).blePeripheral;
  if (!blePeripheral) return;

  return new Promise<void>((resolve, reject) => {
    blePeripheral.createServiceFromJSON({
      uuid: KEMPLE_SERVICE_UUID,
      characteristics: [
        {
          uuid: KEMPLE_CHAR_UUID,
          properties: ["Read", "Notify"],
          permissions: ["Readable"],
          value: stringToBytes(JSON.stringify({ status: "ready" }))
        }
      ]
    }, () => {
      blePeripheral.startAdvertising({
        name: "KEMPLE",
        services: [KEMPLE_SERVICE_UUID]
      }, () => {
        console.log("🔵 BLE Yayıncı (GATT Server) Başlatıldı!");
        peripheralInitialized = true;
        resolve();
      }, reject);
    }, reject);
  });
}

export async function sendViaBLE(packet: object): Promise<boolean> {
  if (!isBLEAvailable()) return false;

  try {
    await initPeripheral();

    const blePeripheral = (window as any).blePeripheral;
    
    // 1. Karakteristik değerini güncelle
    // 2. PC köprüsü (noble) bu telefona bağlanıp bu değeri okuyacaktır.
    const packetData = JSON.stringify(packet);
    
    return new Promise((resolve) => {
      blePeripheral.setCharacteristicValue(
        KEMPLE_SERVICE_UUID,
        KEMPLE_CHAR_UUID,
        stringToBytes(packetData),
        () => {
          console.log("✅ BLE servisine yazıldı, etrafa yayınlanıyor!");
          resolve(true);
        },
        () => resolve(false)
      );
    });

  } catch (err: any) {
    console.warn("BLE peripheral hatası:", err);
    return false;
  }
}

export async function sendViaHTTP(packet: object, gatewayUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${gatewayUrl}/api/packet`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "bypass-tunnel-reminder": "true" 
      },
      body: JSON.stringify(packet),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendPacket(
  packet: object,
  gatewayUrl: string
): Promise<{ method: "ble" | "http" | "failed"; success: boolean }> {
  // 1. Önce HTTP (Hotspot/WiFi) dene
  const httpOk = await sendViaHTTP(packet, gatewayUrl);
  if (httpOk) return { method: "http", success: true };

  // 2. HTTP başarısızsa ve BLE varsa BLE dene
  if (isBLEAvailable()) {
    // BLE işleminin asılı kalmaması için yarış (race) yapıyoruz
    const bleResult = await Promise.race([
      sendViaBLE(packet),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)) // 5sn timeout
    ]);
    
    if (bleResult) return { method: "ble", success: true };
  }

  return { method: "failed", success: false };
}
