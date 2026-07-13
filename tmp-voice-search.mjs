// Одноразовый скрипт: обзор русских женских голосов в ElevenLabs Voice Library.
// Ничего не тратит: только читает каталог. Результат -> tmp-voice-search-results.json
import { writeFile } from "node:fs/promises";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error("нет ELEVENLABS_API_KEY"); process.exit(1); }

const BASE = "https://api.elevenlabs.io/v1/shared-voices";

async function query(label, params) {
  const url = `${BASE}?${new URLSearchParams({ page_size: "100", ...params })}`;
  const res = await fetch(url, { headers: { "xi-api-key": KEY } });
  if (!res.ok) {
    const body = await res.text();
    return { label, error: `${res.status}: ${body.slice(0, 300)}` };
  }
  const data = await res.json();
  return { label, count: data.voices?.length ?? 0, voices: data.voices ?? [] };
}

const queries = [
  ["ru-female-all",          { language: "ru", gender: "female" }],
  ["ru-female-professional", { language: "ru", gender: "female", category: "professional" }],
  ["ru-female-young",        { language: "ru", gender: "female", age: "young" }],
  ["ru-female-conversational", { language: "ru", gender: "female", use_cases: "conversational" }],
  ["ru-female-hq",           { language: "ru", gender: "female", category: "high_quality" }],
];

const out = [];
for (const [label, params] of queries) {
  const r = await query(label, params);
  console.log(label, "->", r.error ?? `${r.count} голосов`);
  out.push(r);
}

// Компактная сводка по уникальным голосам
const seen = new Map();
for (const r of out) {
  if (!r.voices) continue;
  for (const v of r.voices) {
    if (!seen.has(v.voice_id)) {
      seen.set(v.voice_id, {
        voice_id: v.voice_id,
        name: v.name,
        category: v.category,
        gender: v.gender,
        age: v.age,
        accent: v.accent,
        language: v.language,
        locale: v.locale,
        use_case: v.use_case,
        descriptive: v.descriptive,
        description: v.description,
        preview_url: v.preview_url,
        cloned_by_count: v.cloned_by_count,
        usage_1y: v.usage_character_count_1y,
        usage_7d: v.usage_character_count_7d,
        free_users_allowed: v.free_users_allowed,
        notice_period: v.notice_period,
        labels: v.labels,
        matched: [r.label],
      });
    } else {
      seen.get(v.voice_id).matched.push(r.label);
    }
  }
}
const summary = [...seen.values()].sort((a, b) => (b.cloned_by_count ?? 0) - (a.cloned_by_count ?? 0));
await writeFile("tmp-voice-search-results.json", JSON.stringify({ queries: out.map(r => ({ label: r.label, count: r.count, error: r.error })), voices: summary }, null, 2));
console.log(`итого уникальных: ${summary.length}; записано в tmp-voice-search-results.json`);
