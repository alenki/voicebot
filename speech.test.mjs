// node --test speech.test.mjs
// Отмена: заранее прерванный signal должен отклонить askStream (без сети).
// Запросы к Yandex: через MockAgent (шов setHttpDispatcher) проверяем форму тела
// запроса (stream, maxTokens, авторизация) и разбор потокового NDJSON-ответа.
import { test } from "node:test";
import assert from "node:assert";
import { MockAgent } from "undici";
import { ask, askStream, pickReplyText, withTimeout, setHttpDispatcher } from "./speech.mjs";

const LLM_ORIGIN = "https://llm.api.cloud.yandex.net";
const LLM_PATH = "/foundationModels/v1/completion";

// MockAgent на время теста; body-матчер захватывает тело запроса как строку.
function mockLlm(replyBody) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const cap = { body: null, headers: null };
  agent
    .get(LLM_ORIGIN)
    .intercept({
      path: LLM_PATH,
      method: "POST",
      body: (b) => { cap.body = JSON.parse(b); return true; },
      headers: (h) => { cap.headers = h; return true; },
    })
    .reply(200, replyBody);
  setHttpDispatcher(agent);
  return { agent, cap };
}

// Нативный API (yandexgpt/aliceai-llm): форма тела, авторизация, разбор NDJSON-потока.
test("ask(aliceai-llm): stream:false, maxTokens 120, Api-Key — и разбор ответа", async () => {
  const { cap } = mockLlm({ result: { alternatives: [{ message: { text: "Привет" } }] } });
  try {
    const reply = await ask([{ role: "user", text: "x" }], { model: "aliceai-llm" });
    assert.equal(reply, "Привет");
    assert.equal(cap.body.completionOptions.stream, false);
    assert.equal(cap.body.completionOptions.maxTokens, 120);
    assert.match(cap.headers.authorization, /^Api-Key /);
    assert.match(cap.body.modelUri, /\/aliceai-llm\/latest$/);
    assert.equal(cap.body.completionOptions.temperature, 0.4);
  } finally {
    setHttpDispatcher(null); // вернуть боевой keep-alive агент
  }
});

test("askStream(aliceai-llm): stream:true, maxTokens 120 — onChunk получает накопленный текст", async () => {
  const ndjson =
    JSON.stringify({ result: { alternatives: [{ message: { text: "Привет." } }] } }) + "\n" +
    JSON.stringify({ result: { alternatives: [{ message: { text: "Привет. Как дела?" } }] } }) + "\n";
  const { cap } = mockLlm(ndjson);
  try {
    const chunks = [];
    const full = await askStream([{ role: "user", text: "x" }], (t) => chunks.push(t), { model: "aliceai-llm" });
    assert.equal(full, "Привет. Как дела?");
    assert.deepStrictEqual(chunks, ["Привет.", "Привет. Как дела?"]);
    assert.equal(cap.body.completionOptions.stream, true);
    assert.equal(cap.body.completionOptions.maxTokens, 120);
    assert.match(cap.body.modelUri, /\/aliceai-llm\/latest$/);
    assert.equal(cap.body.completionOptions.temperature, 0.4);
  } finally {
    setHttpDispatcher(null);
  }
});

// Бэкенд LLM изредка сбрасывает соединение (ECONNRESET, ~5% у aliceai — замер 2026-07-05);
// ask/askStream обязаны молча повторить один раз, а не ронять ход диалога в 500.
test("ask: один повтор после транзиентной сетевой ошибки", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(LLM_ORIGIN);
  pool.intercept({ path: LLM_PATH, method: "POST" }).replyWithError(new Error("read ECONNRESET"));
  pool.intercept({ path: LLM_PATH, method: "POST" })
    .reply(200, { result: { alternatives: [{ message: { text: "Ответ со второй попытки" } }] } });
  setHttpDispatcher(agent);
  try {
    assert.equal(await ask([{ role: "user", text: "x" }], { model: "aliceai-llm" }), "Ответ со второй попытки");
  } finally {
    setHttpDispatcher(null);
  }
});

test("ask: HTTP-ошибка НЕ повторяется (одна попытка, наружу LLM 500)", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.get(LLM_ORIGIN).intercept({ path: LLM_PATH, method: "POST" }).reply(500, "boom");
  setHttpDispatcher(agent);
  try {
    await assert.rejects(() => ask([{ role: "user", text: "x" }], { model: "aliceai-llm" }), /LLM 500/);
  } finally {
    setHttpDispatcher(null);
  }
});

test("askStream: один повтор после транзиентной сетевой ошибки до начала потока", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(LLM_ORIGIN);
  pool.intercept({ path: LLM_PATH, method: "POST" }).replyWithError(new Error("read ECONNRESET"));
  pool.intercept({ path: LLM_PATH, method: "POST" })
    .reply(200, JSON.stringify({ result: { alternatives: [{ message: { text: "Привет." } }] } }) + "\n");
  setHttpDispatcher(agent);
  try {
    const chunks = [];
    assert.equal(
      await askStream([{ role: "user", text: "x" }], (t) => chunks.push(t), { model: "aliceai-llm" }),
      "Привет.",
    );
    assert.deepStrictEqual(chunks, ["Привет."]);
  } finally {
    setHttpDispatcher(null);
  }
});

// ── OpenAI-совместимая ветка (aliceai-llm-flash доступен ТОЛЬКО через неё) ──────────────
const OPENAI_ORIGIN = "https://ai.api.cloud.yandex.net";
const OPENAI_PATH = "/v1/chat/completions";

function mockOpenai(replyBody) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const cap = { body: null, headers: null };
  agent
    .get(OPENAI_ORIGIN)
    .intercept({
      path: OPENAI_PATH,
      method: "POST",
      body: (b) => { cap.body = JSON.parse(b); return true; },
      headers: (h) => { cap.headers = h; return true; },
    })
    .reply(200, replyBody);
  setHttpDispatcher(agent);
  return { agent, cap };
}

const sse = (deltas) =>
  deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join("") +
  "data: [DONE]\n\n";

// Мозг диалога по умолчанию — aliceai-llm-flash (самый быстрый TTFT, eva-eval чистый,
// замер 2026-07-05); он живёт ТОЛЬКО на OpenAI-совместимом endpoint.
test("дефолтная модель: aliceai-llm-flash через OpenAI endpoint", async () => {
  const { cap } = mockOpenai({ choices: [{ message: { content: "Ок" } }] });
  try {
    assert.equal(await ask([{ role: "user", text: "x" }]), "Ок");
    assert.match(cap.body.model, /^gpt:\/\/.+\/aliceai-llm-flash$/);
  } finally {
    setHttpDispatcher(null);
  }
});

test("askStream(aliceai-llm-flash): OpenAI endpoint, SSE-дельты копятся, onChunk — накопленный текст", async () => {
  const { cap } = mockOpenai(sse(["Привет.", " Как дела?"]));
  try {
    const chunks = [];
    const full = await askStream([{ role: "user", text: "x" }], (t) => chunks.push(t), { model: "aliceai-llm-flash" });
    assert.equal(full, "Привет. Как дела?");
    assert.deepStrictEqual(chunks, ["Привет.", "Привет. Как дела?"]);
    assert.equal(cap.body.stream, true);
    // Модель БЕЗ /latest (для alice-моделей версионные URI в доках не значатся),
    // max_completion_tokens (max_tokens в схеме deprecated), сообщения в формате content.
    assert.match(cap.body.model, /\/aliceai-llm-flash$/);
    assert.equal(cap.body.max_completion_tokens, 120);
    assert.equal(cap.body.messages[0].content, "x");
    assert.match(cap.headers.authorization, /^Api-Key /);
  } finally {
    setHttpDispatcher(null);
  }
});

test("ask(aliceai-llm-flash): не-потоковый ответ через OpenAI endpoint", async () => {
  const { cap } = mockOpenai({ choices: [{ message: { content: "Ответ" } }] });
  try {
    assert.equal(await ask([{ role: "user", text: "x" }], { model: "aliceai-llm-flash" }), "Ответ");
    assert.equal(cap.body.stream, false);
    assert.match(cap.body.model, /\/aliceai-llm-flash$/);
  } finally {
    setHttpDispatcher(null);
  }
});

test("askStream(aliceai-llm-flash): незавершённая последняя SSE-строка не теряется", async () => {
  const body =
    'data: {"choices":[{"delta":{"content":"Привет."}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" Хвост."}}]}'; // обрыв без \n
  const { } = mockOpenai(body);
  try {
    const full = await askStream([{ role: "user", text: "x" }], () => {}, { model: "aliceai-llm-flash" });
    assert.equal(full, "Привет. Хвост.");
  } finally {
    setHttpDispatcher(null);
  }
});

test("askStream(aliceai-llm-flash): один повтор после транзиентной сетевой ошибки", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(OPENAI_ORIGIN);
  pool.intercept({ path: OPENAI_PATH, method: "POST" }).replyWithError(new Error("read ECONNRESET"));
  pool.intercept({ path: OPENAI_PATH, method: "POST" }).reply(200, sse(["Привет."]));
  setHttpDispatcher(agent);
  try {
    assert.equal(
      await askStream([{ role: "user", text: "x" }], () => {}, { model: "aliceai-llm-flash" }),
      "Привет.",
    );
  } finally {
    setHttpDispatcher(null);
  }
});

test("withTimeout: сигнал прерывается по истечении таймаута", async () => {
  const sig = withTimeout(20);
  assert.equal(sig.aborted, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sig.aborted, true);
});

test("withTimeout: уже прерванный сигнал вызывающего → комбинированный прерван сразу", () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(withTimeout(10000, ac.signal).aborted, true);
});

test("withTimeout: прерывание вызывающего прерывает комбинированный сигнал", () => {
  const ac = new AbortController();
  const sig = withTimeout(10000, ac.signal);
  assert.equal(sig.aborted, false);
  ac.abort();
  assert.equal(sig.aborted, true);
});

test("askStream rejects when the signal is already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => askStream([{ role: "system", text: "x" }], () => {}, { signal: ac.signal }),
    (e) => e.name === "AbortError" || /abort/i.test(String(e && e.message)),
  );
});

test("pickReplyText достаёт текст из нормального ответа", () => {
  const data = { result: { alternatives: [{ message: { text: "Здравствуйте" } }] } };
  assert.equal(pickReplyText(data), "Здравствуйте");
});

test("pickReplyText возвращает '' при отсутствии alternatives", () => {
  assert.equal(pickReplyText({ result: {} }), "");
  assert.equal(pickReplyText({ result: { alternatives: [] } }), "");
});

test("pickReplyText возвращает '' на теле ошибки/мусоре, не бросает", () => {
  assert.equal(pickReplyText({ error: { message: "content filter" } }), "");
  assert.equal(pickReplyText(null), "");
  assert.equal(pickReplyText(undefined), "");
});
