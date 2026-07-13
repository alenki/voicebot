// Одноразовый скрипт: пробуем синтез Nastya (Voice Library ID) напрямую на flash_v2_5.
// Если сработает — пишем два сэмпла: продовые настройки и стоковые (для сравнения).
import { writeFile } from "node:fs/promises";

const KEY = process.env.ELEVENLABS_API_KEY;
const NASTYA = "YjESejviApN7SHrbfnA2";

const PHRASE = "Здравствуйте! Компания «Альфа Принт», меня зовут Ева. Подскажите, пожалуйста, что вы хотите напечатать — визитки, баннеры или листовки? Я сориентирую по вариантам и помогу оформить заказ.";

async function synth(outFile, settings) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${NASTYA}?output_format=mp3_44100_128`, {
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

const ok = await synth("flash-03-nastya-prod-settings", { stability: 0.3, similarity_boost: 0.75, style: 0.4, speed: 0.9 });
if (ok) await synth("flash-03-nastya-stock-settings", null);
