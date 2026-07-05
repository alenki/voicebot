// Бенчмарк «мозга» Евы: TTFT (время до первого токена) и полное время ответа
// для кандидатов из каталога Yandex AI Studio. Тот же нативный endpoint, что и
// askStream() в speech.mjs — цифры прямо переносимы на прод.
// Запуск: node --env-file=.env bench-llm.mjs
import { SYSTEM } from "./prompt.mjs";

const KEY = process.env.YANDEX_API_KEY;
const FOLDER = process.env.YANDEX_FOLDER_ID;
if (!KEY || !FOLDER) { console.error("нет YANDEX_API_KEY/YANDEX_FOLDER_ID"); process.exit(1); }

const MODELS = [
  "yandexgpt",           // текущий прод (pro)
  "yandexgpt-5.1",
  "aliceai-llm",
  "aliceai-llm-flash",
  "deepseek-v4-flash",
  "qwen3.6-35b-a3b",
];

const TURNS = [
  [{ role: "system", text: SYSTEM }, { role: "user", text: "Здравствуйте, мне нужны визитки, сколько будет стоить?" }],
  [{ role: "system", text: SYSTEM },
   { role: "user", text: "Мне нужны листовки" },
   { role: "assistant", text: "Отлично, листовки делаем! Какой формат и тираж вам нужен?" },
   { role: "user", text: "А5, тысяча штук. Мне просто цену узнать." }],
];

async function streamOnce(model, messages) {
  const t0 = performance.now();
  let ttft = null, text = "";
  const res = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: { Authorization: `Api-Key ${KEY}`, "Content-Type": "application/json", "x-folder-id": FOLDER },
    body: JSON.stringify({
      modelUri: `gpt://${FOLDER}/${model}/latest`,
      completionOptions: { stream: true, temperature: 0.4, maxTokens: 120 },
      messages,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      const t = j.result?.alternatives?.[0]?.message?.text ?? "";
      if (t && ttft === null) ttft = performance.now() - t0;
      text = t; // накопленный текст, не дельты
    }
  }
  return { ttft, total: performance.now() - t0, text };
}

for (const model of MODELS) {
  console.log(`\n=== ${model} ===`);
  for (let i = 0; i < TURNS.length; i++) {
    try {
      const r = await streamOnce(model, TURNS[i]);
      console.log(`  turn${i + 1}: TTFT ${Math.round(r.ttft)}ms, total ${Math.round(r.total)}ms`);
      console.log(`    «${r.text.replace(/\s+/g, " ").slice(0, 160)}»`);
    } catch (e) {
      console.log(`  turn${i + 1}: ОШИБКА — ${e.message.slice(0, 160)}`);
    }
  }
}
