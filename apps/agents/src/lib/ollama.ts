import { Ollama } from "ollama";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.1:8b";
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS ?? "5000");

export const ollama = new Ollama({ host: OLLAMA_HOST });

export const OLLAMA_MODEL = MODEL;

// JSON çıktısı için Triage prompt şablonu
export function buildTriagePrompt(
  clusterId: string,
  payloads: string[],
  sourceCount: number,
  confidenceScore: number,
  topExamples?: string
): string {
  const payloadText = payloads
    .map((p, i) => `${i + 1}. "${p}"`)
    .join("\n");

  return `Sen bir afet yönetim sistemi triyaj ajanısın. Aşağıdaki ihbar mesajlarını analiz et ve JSON formatında yanıt ver.

KÜME ID: ${clusterId}
BAĞIMSIZ KAYNAK SAYISI: ${sourceCount}
GÜVEN SKORU: ${confidenceScore}/100

İHBAR METİNLERİ:
${payloadText}

Aşağıdaki JSON formatında yanıt ver (başka hiçbir şey yazma):
{
  "triage_score": <0-10 arası sayı, ondalık olabilir>,
  "event_type": <"ENKAZ_MAHSUR"|"TIBBI_ACIL"|"YANGIN"|"LOJISTIK"|"BILGI_TALEBI"|"BELIRSIZ">,
  "extracted_persons": <sayı veya null>,
  "medical_urgency": <"KRITIK"|"YUKSEK"|"ORTA"|"DUSUK"|"YOK">,
  "access_type": <"ARAC"|"YAYA_ONLY"|"ENGELLI"|"BILINMIYOR">,
  "suggested_resources": [<string listesi, örn: "ambulans", "arama_kurtarma">],
  "criteria": {
    "hayati_tehlike": <0-10>,
    "kisi_sayisi": <0-10>,
    "tibbi_aciliyet": <0-10>,
    "confidence_input": <0-10>,
    "zaman_faktoru": <0-10>
  },
  "reasoning": "<kısa Türkçe gerekçe>"
}

Triyaj skoru (0-10) belirleme rehberi:
- 10.0: Çoklu kaynak, kesin hayati tehlike.
- 8.5 - 9.5: Ciddi hayati tehlike veya çoklu yaralı.
- 7.0 - 8.5: Acil tıbbi müdahale, tekil yangın.
- 4.0 - 6.8: Lojistik ihtiyaçlar (su, yemek, çadır).

ÖRNEK ANALİZLER:
${topExamples ? topExamples : `1. "Sesimi duyan var mı ablamla enkazdayız ablamın kafası kanıyor burnundan da kan geliyor konuşmuyor bayıldı lütfen yardım edin"
   -> Skor: 9.9, Tip: "ENKAZ_MAHSUR", Aciliyet: "KRITIK"
2. "Depremde evdeki büyük vitrin kapının arkasına devrildi odada iki kişi kaldık açamıyoruz kapıyı, yaralımız yok"
   -> Skor: 5.5, Tip: "BELIRSIZ", Aciliyet: "YOK"
3. "Depremden beri sokaktayız çadır bulamadık yağmur yağıyor çocuk çok üşüdü ateşi çıkmaya başladı ilaç yok"
   -> Skor: 6.5, Tip: "LOJISTIK", Aciliyet: "ORTA"
4. "Evimizde hiçbir hasar yok ama çok korkuyoruz içeri girmeye cesaret edemedik arabada kalıyoruz çadır istenecek yer neresi"
   -> Skor: 2.5, Tip: "BILGI_TALEBI", Aciliyet: "DUSUK"
5. "Yıkılan binanın altında doğalgaz borusu patladı heryer alev aldı enkaz altındakiler yanacak acil müdahale"
   -> Skor: 9.9, Tip: "YANGIN", Aciliyet: "KRITIK"`}

Ağırlıklar: hayati_tehlike(%35), kisi_sayisi(%20), tibbi_aciliyet(%20), güven(%15), zaman(%10)`;
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await ollama.embeddings({
      model: OLLAMA_MODEL,
      prompt: text
    });
    return response.embedding;
  } catch (err) {
    console.error("Embedding hatası:", err);
    return null;
  }
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Kural tabanlı fallback (LLM kapalıysa)
export function ruleBasedTriage(
  payloads: string[],
  confidenceScore: number
) {
  const combined = payloads.join(" ").toLowerCase();

  const hasEncaz = /enkaz|mahsur|altında|çöktü|yıkıldı/.test(combined);
  const hasYangın = /yangın|alev|duman|tutuş/.test(combined);
  const hasMedical = /yaralı|nefes|bayıldı|kırık|kan|acil/.test(combined);
  const hasLojistik = /yemek|gıda|su|köprü|ulaşım|çadır|battaniye|mama|ekmek/.test(combined);
  const isUrgent = /acil|hemen|çabuk|lütfen|hızlı|yardım edin|yalvarır/.test(combined);

  const personMatch = combined.match(/(\d+)\s*kişi/);
  const extracted_persons = personMatch ? parseInt(personMatch[1]) : null;

  let event_type: string = "BELIRSIZ";
  let base_score: number = 2.0;
  let medical_urgency: string = "DUSUK";

  // Additive Scoring System
  if (hasEncaz) { 
    base_score += 4.5; 
    event_type = "ENKAZ_MAHSUR";
    medical_urgency = "KRITIK";
  }
  if (hasYangın) { 
    base_score += 4.0; 
    if (event_type === "BELIRSIZ") event_type = "YANGIN";
    if (medical_urgency === "DUSUK") medical_urgency = "YUKSEK";
  }
  if (hasMedical) { 
    base_score += 3.5; 
    if (event_type === "BELIRSIZ") event_type = "TIBBI_ACIL";
    medical_urgency = "KRITIK";
  }
  if (hasLojistik) {
    if (event_type === "BELIRSIZ") {
      event_type = "LOJISTIK";
      base_score = 4.0;
    }
    // Lojistik içindeki aciliyet farkı
    if (isUrgent) base_score += 2.5; 
  }

  // Genel aciliyet bonusu (herhangi bir tipte "acil" geçiyorsa)
  if (isUrgent && base_score < 8) base_score += 1.0;

  let triage_score = Math.min(10, base_score);

  // Confidence etkisi
  const confNormalized = confidenceScore / 100;
  triage_score = Math.min(10, triage_score * (0.7 + 0.3 * confNormalized));

  return {
    triage_score: Math.round(triage_score * 10) / 10,
    event_type,
    extracted_persons,
    medical_urgency,
    access_type: "BILINMIYOR",
    suggested_resources: hasEncaz
      ? ["arama_kurtarma", "ambulans"]
      : hasYangın
      ? ["itfaiye", "ambulans"]
      : hasMedical
      ? ["ambulans"]
      : ["koordinasyon"],
    criteria: {
      hayati_tehlike: hasEncaz ? 9 : hasYangın ? 8 : hasMedical ? 7 : 3,
      kisi_sayisi: extracted_persons ? Math.min(10, extracted_persons * 2) : 5,
      tibbi_aciliyet: hasMedical ? 8 : hasEncaz ? 7 : 3,
      confidence_input: Math.round(confidenceScore / 10),
      zaman_faktoru: 5,
    },
    reasoning: `Kural motoru analizi: ${event_type} tespit edildi. Güven skoru: ${confidenceScore}/100.`,
  };
}

export async function callOllamaWithTimeout(
  prompt: string,
  timeoutMs: number = TIMEOUT_MS
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await ollama.generate({
      model: OLLAMA_MODEL,
      prompt,
      format: "json",
      options: {
        temperature: 0.1,
        num_predict: 512,
      },
      // @ts-ignore
      signal: controller.signal,
    });
    return response.response;
  } catch (err) {
    console.error("Ollama hatası:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
