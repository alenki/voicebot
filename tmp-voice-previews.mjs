// Одноразовый скрипт: качаем превью топ-кандидаток в voice-previews/ (бесплатно, это публичные mp3).
// Плюс: сводка по подписке и занятым слотам голосов.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.ELEVENLABS_API_KEY;
const H = { "xi-api-key": KEY };

// Кандидатки под телефонного ассистента: young/professional/conversational + customer-care.
const PICKS = [
  ["sNQyZH8Wfcnv7zh3rHxR", "01-marusya-customer-care"],
  ["Jbte7ht1CqapnZvc4KpK", "02-kari-friendly-warm"],
  ["YjESejviApN7SHrbfnA2", "03-nastya-conversational"],
  ["dHAwRJVaEPhU907QLTPW", "04-natalia-gentle"],
  ["t6lBrEl93uCiLR1Lgm8v", "05-alisa-natural"],
  ["tOo2BJ74frmnPadsDNIi", "06-kate-calm-friendly"],
  ["wUndevsXFk0ArF7vJ61U", "07-polina-customer-care"],
  ["GN4wbsbejSnGSa1AzjH5", "08-ekaterina-soft-silky"],
  ["ycbyWsnf4hqZgdpKHqiU", "09-rina-soft-clear"],
  ["AB9XsbSA4eLG12t2myjN", "10-larisa-actrisa"],
];

const ranked = JSON.parse(await readFile("tmp-voice-ranked.json", "utf8"));
const byId = new Map(ranked.map(v => [v.voice_id, v]));

await mkdir("voice-previews", { recursive: true });
for (const [id, slug] of PICKS) {
  const v = byId.get(id);
  if (!v?.preview_url) { console.log(`${slug}: нет preview_url`); continue; }
  const res = await fetch(v.preview_url);
  if (!res.ok) { console.log(`${slug}: ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(`voice-previews/${slug}.mp3`, buf);
  console.log(`${slug}.mp3  ${(buf.length / 1024).toFixed(0)} KB`);
}

// Текущий голос (Elena Gromova) для сравнения
const cur = await fetch("https://api.elevenlabs.io/v1/voices/0ArNnoIAWKlT4WweaVMY", { headers: H });
if (cur.ok) {
  const v = await cur.json();
  if (v.preview_url) {
    const buf = Buffer.from(await (await fetch(v.preview_url)).arrayBuffer());
    await writeFile("voice-previews/00-CURRENT-elena-gromova.mp3", buf);
    console.log(`00-CURRENT-elena-gromova.mp3  ${(buf.length / 1024).toFixed(0)} KB`);
  }
}

// Подписка и слоты
const sub = await (await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: H })).json();
console.log(`\nплан: ${sub.tier}; символы: ${sub.character_count}/${sub.character_limit}; лимит голосов: ${sub.voice_limit ?? sub.voice_slots_used ?? "?"}`);
const voices = await (await fetch("https://api.elevenlabs.io/v1/voices", { headers: H })).json();
const mine = (voices.voices ?? []).filter(v => v.category !== "premade");
console.log(`своих голосов: ${mine.length} -> ${mine.map(v => `${v.name} [${v.voice_id}]`).join(", ")}`);
