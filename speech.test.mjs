// node --test speech.test.mjs
// Проверяем только отмену: заранее прерванный signal должен отклонить askStream
// (без обращения к сети — fetch проверяет signal.aborted до запроса).
import { test } from "node:test";
import assert from "node:assert";
import { askStream } from "./speech.mjs";

test("askStream rejects when the signal is already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => askStream([{ role: "system", text: "x" }], () => {}, { signal: ac.signal }),
    (e) => e.name === "AbortError" || /abort/i.test(String(e && e.message)),
  );
});
