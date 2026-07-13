// Одноразовый скрипт: добираем страницы с сортировкой по использованию и ранжируем.
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.ELEVENLABS_API_KEY;
const BASE = "https://api.elevenlabs.io/v1/shared-voices";

async function query(params) {
  const url = `${BASE}?${new URLSearchParams({ page_size: "100", ...params })}`;
  const res = await fetch(url, { headers: { "xi-api-key": KEY } });
  if (!res.ok) { console.error(params, res.status, (await res.text()).slice(0, 200)); return []; }
  return (await res.json()).voices ?? [];
}

const prev = JSON.parse(await readFile("tmp-voice-search-results.json", "utf8"));
const seen = new Map(prev.voices.map(v => [v.voice_id, v]));

// Пробуем сортировки по популярности; неизвестные значения sort просто дадут 4xx в лог.
const sorts = ["usage_character_count_1y", "cloned_by_count", "trending"];
for (const sort of sorts) {
  for (let page = 0; page < 3; page++) {
    const voices = await query({ language: "ru", gender: "female", sort, page: String(page) });
    console.log(`sort=${sort} page=${page}: ${voices.length}`);
    if (!voices.length) break;
    for (const v of voices) {
      if (!seen.has(v.voice_id)) {
        seen.set(v.voice_id, {
          voice_id: v.voice_id, name: v.name, category: v.category, gender: v.gender,
          age: v.age, accent: v.accent, language: v.language, locale: v.locale,
          use_case: v.use_case, descriptive: v.descriptive, description: v.description,
          preview_url: v.preview_url, cloned_by_count: v.cloned_by_count,
          usage_1y: v.usage_character_count_1y, usage_7d: v.usage_character_count_7d,
          free_users_allowed: v.free_users_allowed, notice_period: v.notice_period,
          labels: v.labels, matched: [`sort:${sort}`],
        });
      }
    }
  }
}

const all = [...seen.values()];
await writeFile("tmp-voice-all.json", JSON.stringify(all, null, 2), "utf8");

// Ранжирование под задачу: молодой профессиональный разговорный голос для телефона.
const score = v => {
  let s = 0;
  s += Math.log10((v.usage_1y ?? 0) + 1) * 2;        // реальное использование = прокси реализма/качества
  s += Math.log10((v.cloned_by_count ?? 0) + 1);
  if (v.category === "professional") s += 3;          // PVC — самые реалистичные
  if (v.age === "young") s += 2;
  if (/conversational|podcast|social|narrat/i.test(v.use_case ?? "")) s += 1.5;
  if (/characters|animation|gaming/i.test(v.use_case ?? "")) s -= 1;
  return s;
};

const ranked = all
  .filter(v => v.gender === "female" && (v.language === "ru" || v.locale?.startsWith("ru")))
  .sort((a, b) => score(b) - score(a));

console.log(`\nвсего кандидаток: ${ranked.length}\n`);
for (const v of ranked.slice(0, 25)) {
  console.log(
    `${score(v).toFixed(1)}  ${v.name} [${v.voice_id}]  cat=${v.category} age=${v.age} use=${v.use_case} desc=${v.descriptive}` +
    `  usage1y=${((v.usage_1y ?? 0) / 1e6).toFixed(1)}M cloned=${v.cloned_by_count}` +
    `\n      ${String(v.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`
  );
}
await writeFile("tmp-voice-ranked.json", JSON.stringify(ranked.slice(0, 40), null, 2), "utf8");
console.log("\nтоп-40 записан в tmp-voice-ranked.json");
