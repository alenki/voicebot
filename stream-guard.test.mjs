// node --test stream-guard.test.mjs
// Хардненинг стримингового сервера: гейт WS по общему секрету, health-эндпойнт и
// грейсфул-дренаж активных сессий. Чистые/изолируемые функции — тестируем без сети.
import { test } from "node:test";
import assert from "node:assert";
import { isAuthorized, healthHandler, drainSessions } from "./stream-guard.mjs";

test("isAuthorized: секрет не задан → пускаем всех (гейт выключен)", () => {
  assert.equal(isAuthorized("/media", ""), true);
  assert.equal(isAuthorized("/media", undefined), true);
});

test("isAuthorized: секрет задан → нужен совпадающий ?token", () => {
  assert.equal(isAuthorized("/media?token=s3cret", "s3cret"), true);
  assert.equal(isAuthorized("/media?token=wrong", "s3cret"), false);
  assert.equal(isAuthorized("/media", "s3cret"), false);
});

test("isAuthorized: кривой/пустой URL при заданном секрете → отказ", () => {
  assert.equal(isAuthorized(undefined, "s3cret"), false);
});

function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: "",
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    end(b = "") { this.body += b; },
  };
}

test("healthHandler: GET /health → 200, тело ok, вернул true", () => {
  const res = fakeRes();
  const handled = healthHandler({ method: "GET", url: "/health" }, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /ok/);
});

test("healthHandler: /health с query → обрабатывается", () => {
  const res = fakeRes();
  assert.equal(healthHandler({ method: "GET", url: "/health?probe=1" }, res), true);
  assert.equal(res.statusCode, 200);
});

test("healthHandler: прочие пути → false, ответ не трогаем", () => {
  const res = fakeRes();
  assert.equal(healthHandler({ method: "GET", url: "/media" }, res), false);
  assert.equal(res.statusCode, 0);
});

test("drainSessions: вызывает finalizeLead на каждой сессии и глотает ошибки", async () => {
  const calls = [];
  const sessions = new Set([
    { finalizeLead: async () => { calls.push("a"); } },
    { finalizeLead: async () => { throw new Error("boom"); } },
    { finalizeLead: async () => { calls.push("c"); } },
  ]);
  const n = await drainSessions(sessions);
  assert.equal(n, 3);
  assert.deepEqual(calls.sort(), ["a", "c"]);
});
