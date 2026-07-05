// Проба ElevenLabs на русском: реализм + скорость. Нужен ELEVENLABS_API_KEY в .env
// (бесплатный тариф даёт ~10 мин TTS/мес — на пробу хватит с запасом).
// Запуск: node --env-file=.env voice-compare-elevenlabs.mjs
// Пишет voice-samples/11labs-<voice>-<model>.mp3 (послушать) и меряет задержку
// до первого байта в pcm_8000 (то, что реально пойдёт в звонок).
import { writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error("Нет ELEVENLABS_API_KEY в .env. Бесплатная регистрация: elevenlabs.io → Profile → API Keys.");
  process.exit(1);
}

const TEXT = "Здравствуйте! Компания Альфа Принт, меня зовут Ева. Подскажите, какой тираж визиток вам нужен — и я сразу сориентирую по цене.";

// Модели: flash — низкая задержка (для прода), multilingual v2 — максимум качества
// (для сравнения потолка). Обе умеют русский.
const MODELS = ["eleven_flash_v2_5", "eleven_multilingual_v2"];

const headers = { "xi-api-key": KEY, "Content-Type": "application/json" };

// Берём женские премейд-голоса из аккаунта (мультиязычная модель говорит по-русски
// любым голосом; тембр у премейдов западный — для родного русского тембра потом
// можно взять голос из Voice Library, это тоже бесплатно).
const vres = await fetch("https://api.elevenlabs.io/v1/voices", { headers });
if (!vres.ok) { console.error(`GET /voices ${vres.status}: ${(await vres.text()).slice(0, 200)}`); process.exit(1); }
const { voices } = await vres.json();
const female = voices.filter(v => (v.labels?.gender || "").toLowerCase() === "female").slice(0, 3);
if (!female.length) { console.error("Женских голосов не нашлось — смотри список:", voices.map(v => v.name).join(", ")); process.exit(1); }
console.log("Пробуем голоса:", female.map(v => v.name).join(", "));

await mkdir("voice-samples", { recursive: true });
for (const v of female) {
  for (const model of MODELS) {
    const body = JSON.stringify({ text: TEXT, model_id: model, language_code: model.includes("flash") ? "ru" : undefined });
    // 1) mp3 — целиком, чтобы послушать
    const t0 = Date.now();
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.voice_id}?output_format=mp3_44100_128`, {
        method: "POST", headers, body,
      });
      if (!res.ok) { console.log(`FAIL  ${v.name}/${model}  ${res.status}  ${(await res.text()).slice(0, 160)}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const file = `voice-samples/11labs-${v.name.replace(/\W+/g, "_")}-${model.replace("eleven_", "")}.mp3`;
      await writeFile(file, buf);
      console.log(`OK    ${v.name}/${model}  полный синтез ${Date.now() - t0}ms  ${buf.length}b  -> ${file}`);
    } catch (e) { console.log(`ERR   ${v.name}/${model}  ${e.message}`); continue; }

    // 2) pcm_8000 стримом — время до ПЕРВОГО чанка (реальная задержка для звонка)
    try {
      const t1 = Date.now();
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.voice_id}/stream?output_format=pcm_8000`, {
        method: "POST", headers, body,
      });
      if (!res.ok) { console.log(`      pcm_8000 stream FAIL ${res.status}`); continue; }
      const reader = res.body.getReader();
      const first = await reader.read();
      console.log(`      pcm_8000: первый чанк через ${Date.now() - t1}ms (${first.value?.length ?? 0}b)`);
      await reader.cancel();
    } catch (e) { console.log(`      pcm_8000 ERR ${e.message}`); }
  }
}
console.log("\nГотово. Слушать: voice-samples/11labs-*.mp3 (сравнивай с v3-*.wav Яндекса).");
