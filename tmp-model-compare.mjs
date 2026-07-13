// Одноразовый скрипт: сравнение моделей ElevenLabs на одной фразе, стоковые настройки голоса.
// Пишет voice-previews/models/<voice>-<model>.mp3 и -8k.wav, замеряет первый чанк/всего.
import { writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.ELEVENLABS_API_KEY;
const PHRASE = "Здравствуйте! Компания «Альфа Принт», меня зовут Ева. Подскажите, пожалуйста, что вы хотите напечатать — визитки, баннеры или листовки? Я сориентирую по вариантам и помогу оформить заказ.";

const VOICES = [
  ["nastya", "YjESejviApN7SHrbfnA2"],
  ["marusya", "sNQyZH8Wfcnv7zh3rHxR"],
];
const MODELS = ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_v3"];

await mkdir("voice-previews/models", { recursive: true });

function wav8k(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function synthStream(voiceId, model, format) {
  const t0 = Date.now();
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${format}`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ text: PHRASE, model_id: model }), // без voice_settings = стоковые
  });
  if (!res.ok) return { error: `${res.status}: ${(await res.text()).slice(0, 150)}` };
  const chunks = [];
  let first = 0;
  for await (const c of res.body) {
    if (!first) first = Date.now() - t0;
    chunks.push(Buffer.from(c));
  }
  return { buf: Buffer.concat(chunks), first, total: Date.now() - t0 };
}

// прогрев TLS-соединения, чтобы первый замер не был несправедливо холодным
await synthStream(VOICES[0][1], "eleven_flash_v2_5", "mp3_44100_128");
console.log("(соединение прогрето)\n");

const results = [];
for (const [vname, vid] of VOICES) {
  for (const model of MODELS) {
    const mp3 = await synthStream(vid, model, "mp3_44100_128");
    if (mp3.error) { console.log(`${vname} × ${model}: ${mp3.error}`); results.push({ vname, model, error: mp3.error }); continue; }
    await writeFile(`voice-previews/models/${vname}-${model}.mp3`, mp3.buf);
    const pcm = await synthStream(vid, model, "pcm_8000");
    if (!pcm.error) await writeFile(`voice-previews/models/${vname}-${model}-8k.wav`, wav8k(pcm.buf));
    console.log(`${vname} × ${model}: первый чанк ${mp3.first} мс, всего ${mp3.total} мс, mp3 ${(mp3.buf.length/1024).toFixed(0)} KB${pcm.error ? " (8k: " + pcm.error + ")" : ""}`);
    results.push({ vname, model, first: mp3.first, total: mp3.total });
  }
}
console.log("\nготово: voice-previews/models/");
