// Ищем в ElevenLabs Voice Library НАТИВНЫЕ русские женские голоса и качаем их превью
// (без добавления в аккаунт и без траты кредитов). Запуск:
// node --env-file=.env voice-library-ru.mjs
import { writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error("нет ELEVENLABS_API_KEY"); process.exit(1); }
const headers = { "xi-api-key": KEY };

const url = "https://api.elevenlabs.io/v1/shared-voices?language=ru&gender=female&page_size=30";
const res = await fetch(url, { headers });
if (!res.ok) { console.error(`shared-voices ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const { voices } = await res.json();
if (!voices?.length) { console.log("Ничего не нашлось по фильтру ru/female"); process.exit(0); }

// Популярность как прокси качества: сколько раз голос добавили себе.
voices.sort((a, b) => (b.cloned_by_count || 0) - (a.cloned_by_count || 0));
const top = voices.slice(0, 8);

await mkdir("voice-samples", { recursive: true });
for (const v of top) {
  const name = (v.name || "noname").replace(/\W+/g, "_").slice(0, 30);
  const info = `${v.name} | добавили: ${v.cloned_by_count ?? "?"} | возраст: ${v.labels?.age ?? "?"} | кейс: ${v.labels?.use_case ?? v.category ?? "?"}`;
  if (!v.preview_url) { console.log(`нет превью: ${info}`); continue; }
  try {
    const p = await fetch(v.preview_url);
    if (!p.ok) { console.log(`превью ${p.status}: ${info}`); continue; }
    const buf = Buffer.from(await p.arrayBuffer());
    const file = `voice-samples/lib-ru-${name}.mp3`;
    await writeFile(file, buf);
    console.log(`OK ${file}`);
    console.log(`   ${info}`);
    console.log(`   voice_id: ${v.voice_id}  public_owner_id: ${v.public_owner_id}`);
  } catch (e) { console.log(`ERR ${v.name}: ${e.message}`); }
}
console.log("\nПревью — это родная запись голоса (обычно на русском): слушаем ТЕМБР и живость.");
console.log("Понравившийся голос добавь в аккаунт кнопкой в Voice Library (elevenlabs.io/app/voice-library,");
console.log("фильтр Language: Russian) — и я синтезирую им фразу Евы во flash и v3.");
