// Синтез фраз Евы добавленными из Voice Library голосами: flash_v2_5 (прод-задержка)
// и eleven_v3 (потолок выразительности). Запуск: node --env-file=.env synth-elevenlabs.mjs
import { writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error("нет ELEVENLABS_API_KEY"); process.exit(1); }
const headers = { "xi-api-key": KEY, "Content-Type": "application/json" };

// Две фразы: приветствие (визитка) и живая продажная реплика (слышно manner, не только тембр)
const PHRASES = [
  ["greet", "Здравствуйте! Компания Альфа Принт, меня зовут Ева. Подскажите, какой тираж визиток вам нужен — и я сразу сориентирую по цене."],
  ["sales", "Ага, поняла вас. Смотрите, по тиражу — если брать тысячу штук, цена за штуку выходит ощутимо ниже. Вам к какому числу нужно?"],
];
const MODELS = ["eleven_flash_v2_5", "eleven_v3"];

const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers });
if (!res.ok) { console.error(`GET /voices ${res.status}`); process.exit(1); }
const { voices } = await res.json();
const picked = voices.filter(v => /elena|victoria/i.test(v.name));
if (!picked.length) { console.log("Elena/Victoria не найдены. В аккаунте:", voices.map(v => v.name).join(" | ")); process.exit(1); }
console.log("Голоса:", picked.map(v => v.name).join(" | "));

await mkdir("voice-samples", { recursive: true });
for (const v of picked) {
  const vname = v.name.replace(/\W+/g, "_").slice(0, 24);
  for (const model of MODELS) {
    for (const [tag, text] of PHRASES) {
      const body = JSON.stringify({
        text, model_id: model,
        ...(model.includes("flash") ? { language_code: "ru" } : {}),
      });
      const t0 = Date.now();
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.voice_id}?output_format=mp3_44100_128`, {
          method: "POST", headers, body,
        });
        if (!r.ok) { console.log(`FAIL  ${v.name} ${model} ${tag}  ${r.status}  ${(await r.text()).slice(0, 140)}`); continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        const file = `voice-samples/11labs-${vname}-${model.replace("eleven_", "")}-${tag}.mp3`;
        await writeFile(file, buf);
        console.log(`OK    ${v.name}  ${model}  ${tag}  ${Date.now() - t0}ms  -> ${file}`);
      } catch (e) { console.log(`ERR   ${v.name} ${model} ${tag}  ${e.message}`); }
    }
  }
  // прод-метрика: pcm_8000 стримом, время до первого чанка (flash)
  try {
    const t1 = Date.now();
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.voice_id}/stream?output_format=pcm_8000`, {
      method: "POST", headers,
      body: JSON.stringify({ text: PHRASES[0][1], model_id: "eleven_flash_v2_5", language_code: "ru" }),
    });
    if (r.ok) {
      const reader = r.body.getReader();
      const first = await reader.read();
      console.log(`      ${v.name}: pcm_8000/flash первый чанк через ${Date.now() - t1}ms (${first.value?.length ?? 0}b)`);
      await reader.cancel();
    } else { console.log(`      ${v.name}: pcm_8000 stream FAIL ${r.status}`); }
  } catch (e) { console.log(`      pcm ERR ${e.message}`); }
}
