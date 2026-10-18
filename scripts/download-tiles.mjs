/**
 * Erzurum bölgesi için offline harita tile'larını indir (HIZLI — paralel)
 * Kullanım: node scripts/download-tiles.mjs
 */

import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILES_DIR = path.join(__dirname, "..", "apps", "dashboard", "public", "tiles");

// Erzurum bounding box
const BBOX = {
  minLat: 39.84, maxLat: 40.00,
  minLng: 41.15, maxLng: 41.38,
};

const MIN_ZOOM = 8;
const MAX_ZOOM = 16;
const CONCURRENCY = 20; // paralel indirme sayısı

const TILE_URL = (z, x, y) =>
  `https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}@2x.png`;

function latLngToTile(lat, lng, zoom) {
  const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
  return { x, y };
}

function downloadTile(url, filePath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(filePath)) { resolve("skip"); return; }

    const file = fs.createWriteStream(filePath);
    https
      .get(url, { headers: { "User-Agent": "KEMPLE-Hackathon/1.0" } }, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(filePath); } catch {}
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve("ok"); });
      })
      .on("error", (err) => {
        file.close();
        try { fs.unlinkSync(filePath); } catch {}
        reject(err);
      });
  });
}

// Paralel batch işleme
async function processBatch(tasks, concurrency) {
  let downloaded = 0, skipped = 0, errors = 0;
  let idx = 0;
  
  async function worker() {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      try {
        const r = await downloadTile(task.url, task.path);
        if (r === "skip") skipped++; else downloaded++;
      } catch {
        errors++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return { downloaded, skipped, errors };
}

async function main() {
  console.log(`\n🗺️  Erzurum offline tile indirme (paralel x${CONCURRENCY})...`);
  
  let totalDown = 0, totalSkip = 0, totalErr = 0;

  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const tl = latLngToTile(BBOX.maxLat, BBOX.minLng, z);
    const br = latLngToTile(BBOX.minLat, BBOX.maxLng, z);

    const tasks = [];
    for (let x = tl.x; x <= br.x; x++) {
      for (let y = tl.y; y <= br.y; y++) {
        tasks.push({
          url: TILE_URL(z, x, y),
          path: path.join(TILES_DIR, `${z}`, `${x}`, `${y}.png`),
        });
      }
    }

    const t0 = Date.now();
    const { downloaded, skipped, errors } = await processBatch(tasks, CONCURRENCY);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    
    totalDown += downloaded;
    totalSkip += skipped;
    totalErr += errors;
    
    console.log(`  Zoom ${z.toString().padStart(2)}: ${tasks.length.toString().padStart(5)} tile → ${downloaded} yeni, ${skipped} var, ${errors} hata (${dt}s)`);
  }

  console.log(`\n📊 Toplam: ${totalDown} indirildi, ${totalSkip} zaten var, ${totalErr} hata`);
  console.log(`✅ Tiles: ${TILES_DIR}\n`);
}

main().catch(console.error);
