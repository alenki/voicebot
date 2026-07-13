// Одноразовый скрипт: добавляем финалисток в My Voices и синтезируем одну и ту же
// реплику Евы на eleven_flash_v2_5 с продовыми настройками голоса.
// Результат -> voice-previews/flash-*.mp3 (это то, как голос реально прозвучит в звонке).
import { writeFile } from "node:fs/promises";

const KEY = process.env.ELEVENLABS_API_KEY;
const H = { "xi-api-key": KEY };

const FINALISTS = [
  ["sNQyZH8Wfcnv7zh3rHxR", "Marusya G (candidate)", "flash-01-marusya"],
  ["Jbte7ht1CqapnZvc4KpK", "Kari (candidate)", "flash-02-kari"],
  ["YjESejviApN7SHrbfnA2", "Nastya (candidate)", "flash-03-nastya"],
  ["t6lBrEl93uCiLR1Lgm8v", "Alisa (candidate)", "flash-05-alisa"],
  ["dHAwRJVaEPhU907QLTPW", "Natalia M (candidate)", "flash-04-natalia"],
];

const PHRASE = "Здравствуйте! Компания «Альфа Принт», меня зовут Ева. Подскажите, пожалуйста, что вы хотите напечатать — визитки, баннеры или листовки? Я сориентирую по вариантам и помогу оформить заказ.";

// Продовые настройки из tts-elevenlabs.mjs (как в реальном звонке)
const VOICE_SETTINGS = { stability: 0.3, similarity_boost: 0.75, style: 0.4, speed: 0.9 };

// 1) находим public_owner_id финалисток в каталоге
const owners = new Map();
for (const sort of ["usage_character_count_1y", "cloned_by_count"]) {
  for (let page = 0; page < 3 && owners.size < FINALISTS.length; page++) {
    const url = `https://api.elevenlabs.io/v1/shared-voices?${new URLSearchParams({ page_size: "100", language: "ru", gender: "female", sort, page: String(page) })}`;
    const data = await (await fetch(url, { headers: H })).json();
    for (const v of data.voices ?? []) {
      if (FINALISTS.some(([id]) => id === v.voice_id)) owners.set(v.voice_id, v.public_owner_id);
    }
  }
}
console.log(`owner id найдено: ${owners.size}/${FINALISTS.length}`);

// 2) какие голоса уже в библиотеке (чтобы не добавлять повторно)
const lib = await (await fetch("https://api.elevenlabs.io/v1/voices", { headers: H })).json();
const have = new Set((lib.voices ?? []).map(v => v.voice_id));

async function synth(voiceId, outFile) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ text: PHRASE, model_id: "eleven_flash_v2_5", voice_settings: VOICE_SETTINGS }),
  });
  if (!res.ok) { console.log(`${outFile}: synth ${res.status}: ${(await res.text()).slice(0, 200)}`); return false; }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(`voice-previews/${outFile}.mp3`, buf);
  console.log(`${outFile}.mp3  ${(buf.length / 1024).toFixed(0)} KB`);
  return true;
}

// 3) добавляем и синтезируем
for (const [id, name, out] of FINALISTS) {
  if (!have.has(id)) {
    const owner = owners.get(id);
    if (!owner) { console.log(`${name}: не нашла public_owner_id, пропуск`); continue; }
    const add = await fetch(`https://api.elevenlabs.io/v1/voices/add/${owner}/${id}`, {
      method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ new_name: name }),
    });
    if (!add.ok) { console.log(`${name}: add ${add.status}: ${(await add.text()).slice(0, 200)}`); continue; }
    console.log(`${name}: добавлена в библиотеку`);
  }
  await synth(id, out);
}

// 4) текущая Elena Gromova той же фразой — для честного сравнения
await synth("0ArNnoIAWKlT4WweaVMY", "flash-00-CURRENT-elena");
console.log("готово");
