// Одноразовый скрипт: полный набор сэмплов для голоса-кандидатки.
// Использование: node --env-file=.env tmp-try-voice.mjs <voice_id> <slug>
// Пишет voice-previews/<slug>-prod-settings.mp3, -stock-settings.mp3 и -8khz-phone.wav (прод-путь).
import { writeFile } from "node:fs/promises";

const [voiceId, slug] = process.argv.slice(2);
if (!voiceId || !slug) { console.error("нужно: <voice_id> <slug>"); process.exit(1); }
const KEY = process.env.ELEVENLABS_API_KEY;

const PHRASE = "Здравствуйте! Компания «Альфа Принт», меня зовут Ева. Подскажите, пожалуйста, что вы хотите напечатать — визитки, баннеры или листовки? Я сориентирую по вариантам и помогу оформить заказ.";

async function synth(outFile, settings) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ text: PHRASE, model_id: "eleven_flash_v2_5", ...(settings ? { voice_settings: settings } : {}) }),
  });
  if (!res.ok) { console.log(`${outFile}: ${res.status}: ${(await res.text()).slice(0, 300)}`); return false; }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(`voice-previews/${outFile}.mp3`, buf);
  console.log(`${outFile}.mp3  ${(buf.length / 1024).toFixed(0)} KB`);
  return true;
}

const ok = await synth(`${slug}-prod-settings`, { stability: 0.3, similarity_boost: 0.75, style: 0.4, speed: 0.9 });
if (ok) await synth(`${slug}-stock-settings`, null);

// 8 кГц через прод-путь (speech.mjs -> tts-elevenlabs.mjs); голос подменяем через env
process.env.ELEVENLABS_VOICE_ID = voiceId;
const m = await import("./speech.mjs");
const t0 = Date.now();
let first = 0;
const pcm = await m.synthesizePcm(PHRASE, 8000, { onChunk: () => { if (!first) first = Date.now() - t0; } });
console.log(`pcm байт: ${pcm.length} | до первого чанка: ${first} мс | всего: ${Date.now() - t0} мс`);
const h = Buffer.alloc(44);
h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
await writeFile(`voice-previews/${slug}-8khz-phone.wav`, Buffer.concat([h, pcm]));
console.log(`записан voice-previews/${slug}-8khz-phone.wav`);
