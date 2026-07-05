// Одноразовый скрипт сравнения голосов: тот же v1 REST эндпоинт, что и в проде.
// Запуск: node --env-file=.env voice-compare.mjs
// Пишет voice-samples/<voice>-<role>.ogg — послушать и выбрать на слух.
import { writeFile, mkdir } from "node:fs/promises";

const API_KEY = process.env.YANDEX_API_KEY;
const FOLDER_ID = process.env.YANDEX_FOLDER_ID;
if (!API_KEY || !FOLDER_ID) { console.error("нет YANDEX_API_KEY/YANDEX_FOLDER_ID"); process.exit(1); }

const TEXT = "Здравствуйте! Компания Альфа Принт, меня зовут Ева. Подскажите, какой тираж визиток вам нужен — и я сразу сориентирую по цене.";

// alena/good — текущий боевой вариант (базовая линия).
// marina — по докам есть и в v1, роли neutral|whisper|friendly.
// dasha — по докам v3-only: ждём ошибку от v1 (негативный тест).
const CASES = [
  ["alena", "good"],
  ["marina", "neutral"],
  ["marina", "friendly"],
  ["marina", "whisper"],
  ["dasha", "friendly"],
  ["lera", "friendly"],
];

await mkdir("voice-samples", { recursive: true });
for (const [voice, emotion] of CASES) {
  const body = new URLSearchParams({
    text: TEXT, lang: "ru-RU", voice, emotion, speed: "0.95",
    format: "oggopus", folderId: FOLDER_ID,
  });
  const t0 = Date.now();
  try {
    const res = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
      method: "POST", headers: { Authorization: `Api-Key ${API_KEY}` }, body,
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.log(`FAIL  ${voice}/${emotion}  ${res.status}  ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const file = `voice-samples/${voice}-${emotion}.ogg`;
    await writeFile(file, buf);
    console.log(`OK    ${voice}/${emotion}  ${ms}ms  ${buf.length}b  -> ${file}`);
  } catch (e) {
    console.log(`ERR   ${voice}/${emotion}  ${e.message}`);
  }
}
