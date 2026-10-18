import type { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import {
  STREAMS,
  CONSUMER_GROUPS,
  type ValidatedPacket,
  type IntakePacket,
} from "@kemple/shared";
import {
  callOllamaWithTimeout,
  OLLAMA_MODEL,
} from "./lib/ollama.js";
import { writeToDLQ } from "./lib/redis.js";

const CONSUMER_NAME = `intake-${process.env.HOSTNAME ?? uuidv4().slice(0, 8)}`;

// Ollama'ya gönderilecek yapılandırma prompt'u
function buildIntakePrompt(payload: string): string {
  return `Sen bir afet yönetim sistemi giriş ajanısın. Aşağıdaki kısa ihbar metnini analiz et ve JSON formatında yanıt ver.

METİN: "${payload}"

Aşağıdaki JSON formatında yanıt ver (başka hiçbir şey yazma):
{
  "extracted_location": <konum bilgisi varsa Türkçe string, yoksa null>,
  "extracted_persons": <kişi sayısı varsa sayı, yoksa null>,
  "urgency_hint": <"KRITIK"|"YUKSEK"|"ORTA"|"DUSUK">,
  "enriched_text": <metnin kısa, net, standart Türkçeye çevrilmiş hali (max 200 karakter)>
}`;
}

export class IntakeAgent {
  private circuitOpen   = false;
  private circuitFails  = 0;
  private readonly circuitThreshold = 3;

  constructor(
    private readonly consumerRedis: Redis,
    private readonly writeRedis: Redis
  ) {}

  async start(): Promise<void> {
    console.log("📥 IntakeAgent başladı");
    const { stream, group } = CONSUMER_GROUPS.INTAKE;

    while (true) {
      try {
        const results = await this.consumerRedis.xreadgroup(
          "GROUP", group, CONSUMER_NAME,
          "COUNT", "10",
          "BLOCK", "2000",
          "STREAMS", stream, ">"
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (results) {
          for (const [, messages] of results) {
            // Paralel işleme: 10 mesajı aynı anda Ollama'ya gönder
            await Promise.all(
              messages.map(([msgId, fields]) =>
                this.processMessage(msgId, fields, stream, group)
              )
            );
          }
        }
      } catch (err) {
        console.error("IntakeAgent döngü hatası:", err);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  private async processMessage(
    msgId: string,
    fields: string[],
    stream: string,
    group: string
  ): Promise<void> {
    try {
      const data = fields[fields.indexOf("data") + 1];
      const packet: ValidatedPacket = JSON.parse(data);

      const enriched = await this.enrich(packet);

      if (enriched) {
        // Enriched text'i ValidatedPacket'e ekle
        packet.enriched_text = enriched.enriched_text;

        // Zenginleştirilmiş paketi ENRICHED stream'ine yaz (DedupAgent okuyacak)
        await this.writeRedis.xadd(
          STREAMS.ENRICHED,
          "*",
          "data", JSON.stringify(packet)
        );

        console.log(
          `📥 Intake: ${packet.packet_uuid} → ` +
          `urgency:${enriched.urgency_hint ?? "?"} ` +
          `persons:${enriched.extracted_persons ?? "?"} ` +
          `[${this.circuitOpen ? "FALLBACK" : "LLM"}]`
        );
      } else {
        // Fallback durumunda orijinal paketi stream'e yaz
        await this.writeRedis.xadd(
          STREAMS.ENRICHED,
          "*",
          "data", JSON.stringify(packet)
        );
      }

      await this.consumerRedis.xack(stream, group, msgId);
    } catch (err) {
      console.error("IntakeAgent mesaj hatası:", err);
      await writeToDLQ(this.writeRedis, stream, msgId, {}, String(err));
      await this.consumerRedis.xack(stream, group, msgId);
    }
  }

  private async enrich(packet: ValidatedPacket): Promise<IntakePacket | null> {
    if (!this.circuitOpen) {
      const prompt   = buildIntakePrompt(packet.payload);
      const response = await callOllamaWithTimeout(prompt, 10_000);

      if (response) {
        try {
          const parsed = JSON.parse(response);
          this.circuitFails = 0;

          return {
            cluster_id:         "pending", // DeduplicationAgent sonra doldurur
            original_payload:   packet.payload,
            extracted_location: parsed.extracted_location ?? undefined,
            extracted_persons:  parsed.extracted_persons ?? null,
            urgency_hint:       parsed.urgency_hint ?? undefined,
            enriched_text:      parsed.enriched_text ?? undefined,
            intake_model:       OLLAMA_MODEL,
            intake_ts:          new Date().toISOString(),
          };
        } catch {
          console.warn("IntakeAgent JSON parse hatası, fallback");
          this.incrementCircuitFailure();
        }
      } else {
        this.incrementCircuitFailure();
      }
    }

    // Fallback: Ollama kapalı veya hata — sadece orijinal payload sakla
    return {
      cluster_id:       "pending",
      original_payload: packet.payload,
      intake_model:     "fallback",
      intake_ts:        new Date().toISOString(),
    };
  }

  private incrementCircuitFailure() {
    this.circuitFails++;
    if (this.circuitFails >= this.circuitThreshold) {
      this.circuitOpen = true;
      console.warn("⚡ IntakeAgent circuit breaker AÇILDI — fallback moda geçildi");
      setTimeout(() => {
        this.circuitOpen  = false;
        this.circuitFails = 0;
        console.log("✅ IntakeAgent circuit breaker sıfırlandı");
      }, 5 * 60 * 1000);
    }
  }
}
