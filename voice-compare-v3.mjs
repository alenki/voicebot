// Сравнение v3-only голосов Яндекса через REST utteranceSynthesis (без gRPC).
// Запуск: node --env-file=.env voice-compare-v3.mjs
// Пишет voice-samples/v3-<voice>-<role>.wav — послушать и выбрать на слух.
import { writeFile, mkdir } from "node:fs/promises";

const API_KEY = process.env.YANDEX_API_KEY;
const FOLDER_ID = process.env.YANDEX_FOLDER_ID;
if (!API_KEY || !FOLDER_ID) { console.error("нет YANDEX_API_KEY/YANDEX_FOLDER_ID"); process.exit(1); }

const TEXT = "Здравствуйте! Компания Альфа Принт, меня зовут Ева. Подскажите, какой тираж визиток вам нужен — и я сразу сориентирую по цене.";

// Роли по докам aistudio.yandex.ru/docs/ru/speechkit/tts/voices (не всё проверено —
// невалидная роль отдаст ошибку, это тоже результат).
const CASES = [
  ["marina", "friendly"], // эталон: то, что уже стоит в проде (для сравнения ушами)
  ["dasha", "friendly"],
  ["dasha", "good"],
  ["dasha", "neutral"],
  ["lera", "friendly"],
  ["lera", "neutral"],
  ["masha", "friendly"],
  ["masha", "good"],
  ["julia", "neutral"],
  ["jane", "good"],
];

await mkdir("voice-samples", { recursive: true });
for (const [voice, role] of CASES) {
  const body = {
    text: TEXT,
    hints: [{ voice }, { role }, { speed: 0.95 }],
    outputAudioSpec: { containerAudio: { containerAudioType: "WAV" } },
  };
  const t0 = Date.now();
  try {
    const res = await fetch("https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis", {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${API_KEY}`,
        "x-folder-id": FOLDER_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.log(`FAIL  ${voice}/${role}  ${res.status}  ${raw.slice(0, 160)}`);
      continue;
    }
    // Ответ — поток JSON-объектов построчно: {"result":{"audioChunk":{"data":"<base64>"}...}}
    const chunks = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      const b64 = obj.result?.audioChunk?.data;
      if (b64) chunks.push(Buffer.from(b64, "base64"));
    }
    if (!chunks.length) { console.log(`EMPTY ${voice}/${role}  (нет audioChunk) ${raw.slice(0, 160)}`); continue; }
    const buf = Buffer.concat(chunks);
    const file = `voice-samples/v3-${voice}-${role}.wav`;
    await writeFile(file, buf);
    console.log(`OK    ${voice}/${role}  ${ms}ms  ${buf.length}b  -> ${file}`);
  } catch (e) {
    console.log(`ERR   ${voice}/${role}  ${e.message}`);
  }
}
