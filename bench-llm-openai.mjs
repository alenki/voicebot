// Часть 2 бенчмарка: модели, доступные только через OpenAI-совместимый API
// Yandex AI Studio (https://llm.api.cloud.yandex.net/v1/chat/completions, SSE).
// Запуск: node --env-file=.env bench-llm-openai.mjs
import { SYSTEM } from "./prompt.mjs";

const KEY = process.env.YANDEX_API_KEY;
const FOLDER = process.env.YANDEX_FOLDER_ID;

const MODELS = [
  "aliceai-llm",        // для сравнения endpoint-ов
  "aliceai-llm-flash",
  "deepseek-v4-flash",
  "qwen3.6-35b-a3b",
];

const TURNS = [
  [{ role: "system", content: SYSTEM }, { role: "user", content: "Здравствуйте, мне нужны визитки, сколько будет стоить?" }],
  [{ role: "system", content: SYSTEM },
   { role: "user", content: "Мне нужны листовки" },
   { role: "assistant", content: "Отлично, листовки делаем! Какой формат и тираж вам нужен?" },
   { role: "user", content: "А5, тысяча штук. Мне просто цену узнать." }],
];

async function streamOnce(model, messages) {
  const t0 = performance.now();
  let ttft = null, text = "";
  const res = await fetch("https://llm.api.cloud.yandex.net/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Api-Key ${KEY}`, "Content-Type": "application/json", "x-folder-id": FOLDER },
    body: JSON.stringify({
      model: `gpt://${FOLDER}/${model}/latest`,
      stream: true,
      temperature: 0.4,
      max_tokens: 200,
      messages,
    }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      const j = JSON.parse(payload);
      const delta = j.choices?.[0]?.delta?.content ?? "";
      if (delta && ttft === null) ttft = performance.now() - t0;
      text += delta;
    }
  }
  return { ttft, total: performance.now() - t0, text };
}

for (const model of MODELS) {
  console.log(`\n=== ${model} (openai api) ===`);
  for (let i = 0; i < TURNS.length; i++) {
    try {
      const r = await streamOnce(model, TURNS[i]);
      console.log(`  turn${i + 1}: TTFT ${r.ttft === null ? "—" : Math.round(r.ttft) + "ms"}, total ${Math.round(r.total)}ms`);
      console.log(`    «${r.text.replace(/\s+/g, " ").slice(0, 160)}»`);
    } catch (e) {
      console.log(`  turn${i + 1}: ОШИБКА — ${e.message.slice(0, 160)}`);
    }
  }
}
