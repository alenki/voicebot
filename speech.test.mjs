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

test("ask: stream:false, maxTokens 120 по умолчанию, Api-Key — и разбор ответа", async () => {
  const { cap } = mockLlm({ result: { alternatives: [{ message: { text: "Привет" } }] } });
  try {
    const reply = await ask([{ role: "user", text: "x" }]);
    assert.equal(reply, "Привет");
    assert.equal(cap.body.completionOptions.stream, false);
    assert.equal(cap.body.completionOptions.maxTokens, 120);
    assert.match(cap.headers.authorization, /^Api-Key /);
  } finally {
    setHttpDispatcher(null); // вернуть боевой keep-alive агент
  }
});

test("askStream: stream:true, maxTokens 120 — onChunk получает накопленный текст", async () => {
  const ndjson =
    JSON.stringify({ result: { alternatives: [{ message: { text: "Привет." } }] } }) + "\n" +
    JSON.stringify({ result: { alternatives: [{ message: { text: "Привет. Как дела?" } }] } }) + "\n";
  const { cap } = mockLlm(ndjson);
  try {
    const chunks = [];
    const full = await askStream([{ role: "user", text: "x" }], (t) => chunks.push(t));
    assert.equal(full, "Привет. Как дела?");
    assert.deepStrictEqual(chunks, ["Привет.", "Привет. Как дела?"]);
    assert.equal(cap.body.completionOptions.stream, true);
    assert.equal(cap.body.completionOptions.maxTokens, 120);
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
