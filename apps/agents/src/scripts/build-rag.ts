import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Ollama } from "ollama";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.1:8b";
const ollama = new Ollama({ host: OLLAMA_HOST });

interface RawData {
  id: number;
  text: string;
  persons: number;
  score: number;
  severity: string;
  note: string;
}

interface RagRecord {
  id: number;
  text: string;
  persons: number;
  score: number;
  severity: string;
  vector: number[];
}

async function run() {
  console.log("🚀 RAG Veritabanı oluşturuluyor...");
  console.log(`🔗 Model: ${MODEL} | Host: ${OLLAMA_HOST}`);

  const rawPath = path.resolve(__dirname, "../lib/raw-dataset.json");
  const dbPath = path.resolve(__dirname, "../lib/rag-db.json");

  const rawContent = await fs.readFile(rawPath, "utf-8");
  const dataset: RawData[] = JSON.parse(rawContent);

  const ragDb: RagRecord[] = [];

  for (let i = 0; i < dataset.length; i++) {
    const item = dataset[i];
    
    // Embedding al
    try {
      const response = await ollama.embeddings({
        model: MODEL,
        prompt: item.text
      });

      ragDb.push({
        id: item.id,
        text: item.text,
        persons: item.persons,
        score: item.score,
        severity: item.severity,
        vector: response.embedding
      });

      console.log(`[${i + 1}/${dataset.length}] ✅ Vektörize edildi: ${item.text.slice(0, 40)}...`);
    } catch (err) {
      console.error(`[${i + 1}/${dataset.length}] ❌ Hata:`, err);
    }
  }

  await fs.writeFile(dbPath, JSON.stringify(ragDb, null, 2), "utf-8");
  console.log(`\n🎉 Bitti! ${ragDb.length} adet veri rag-db.json dosyasına kaydedildi.`);
}

run().catch(console.error);
