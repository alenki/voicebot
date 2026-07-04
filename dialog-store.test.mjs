// node --test dialog-store.test.mjs
// Живой путь (server.mjs) обязан доставлять заявку менеджеру при завершении звонка —
// раньше /end просто стирал историю, и лид терялся молча. Здесь фиксируем контракт
// хранилища: заявка шлётся ровно один раз, TTL выметает потерянные звонки, дренаж
// до-оформляет активные при остановке.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDialogStore } from "./dialog-store.mjs";

const silentLog = { log() {}, error() {} };

function makeStore(overrides = {}) {
  const cap = { extracts: 0, delivered: [] };
  const store = createDialogStore({
    systemText: "SYSTEM",
    extractOrder: async (history) => {
      cap.extracts++;
      return { hasOrder: true, fields: { item: history.at(-1)?.text || "" } };
    },
    deliverLead: async (fields, meta) => { cap.delivered.push({ fields, meta }); return { ok: true }; },
    log: silentLog,
    ...overrides,
  });
  return { store, cap };
}

test("history: создаёт диалог с system-промптом и переиспользует его", () => {
  const { store } = makeStore();
  const h1 = store.history("call-1");
  assert.deepEqual(h1, [{ role: "system", text: "SYSTEM" }]);
  h1.push({ role: "user", text: "нужны визитки" });
  assert.equal(store.history("call-1").length, 2, "тот же звонок — та же история");
  assert.equal(store.size, 1);
});

test("finalize: извлекает заявку и шлёт в Telegram один раз (двойной finalize безопасен)", async () => {
  const { store, cap } = makeStore();
  store.history("call-1").push({ role: "user", text: "баннер два на метр" });
  await store.finalize("call-1");
  await store.finalize("call-1"); // /end и TTL могут сойтись на одном звонке
  assert.equal(cap.extracts, 1, "extractOrder ровно один раз");
  assert.equal(cap.delivered.length, 1, "заявка отправлена ровно один раз");
  assert.equal(cap.delivered[0].meta.callId, "call-1");
  assert.equal(store.size, 0, "история удалена");
});

test("finalize: hasOrder=false и телефона нет — в Telegram не шлём", async () => {
  const { store, cap } = makeStore({
    extractOrder: async () => ({ hasOrder: false, fields: {} }),
  });
  store.history("call-1");
  await store.finalize("call-1");
  assert.equal(cap.delivered.length, 0);
});

test("finalize: hasOrder=false, но телефон оставлен — это лид, шлём", async () => {
  const { store, cap } = makeStore({
    extractOrder: async () => ({ hasOrder: false, fields: { phone: "89287123456" } }),
  });
  store.history("call-1");
  await store.finalize("call-1");
  assert.equal(cap.delivered.length, 1, "клиент оставил контакт для расчёта — лид не пропадает");
});

test("finalize: сбой extractOrder не бросает наружу", async () => {
  const { store } = makeStore({
    extractOrder: async () => { throw new Error("LLM 500"); },
  });
  store.history("call-1");
  await assert.doesNotReject(() => store.finalize("call-1"));
});

test("sweep: выметает только простоявшие дольше TTL и доставляет их заявки", async () => {
  let t = 1000;
  const { store, cap } = makeStore({ ttlMs: 100, now: () => t });
  store.history("stale");
  t = 1050;
  store.history("fresh"); // моложе TTL на момент выметания
  t = 1150;               // stale простоял 150 > 100, fresh — 100 (не строго больше)
  await store.sweep();
  assert.deepEqual(cap.delivered.map((d) => d.meta.callId), ["stale"]);
  assert.equal(store.size, 1, "свежий звонок остаётся");
});

test("drain: до-оформляет все активные звонки (грейсфул-шатдаун)", async () => {
  const { store, cap } = makeStore();
  store.history("a");
  store.history("b");
  await store.drain();
  assert.deepEqual(cap.delivered.map((d) => d.meta.callId).sort(), ["a", "b"]);
  assert.equal(store.size, 0);
});
