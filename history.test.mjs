// node --test history.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { windowForLlm } from "./history.mjs";

const sys = { role: "system", text: "SYSTEM" };
const turn = (i) => [
  { role: "user", text: `вопрос ${i}` },
  { role: "assistant", text: `ответ ${i}` },
];

test("короткая история возвращается целиком", () => {
  const history = [sys, ...turn(1), ...turn(2)];
  assert.deepStrictEqual(windowForLlm(history), history);
});

test("длинная история обрезается до system + последних max сообщений", () => {
  const history = [sys];
  for (let i = 1; i <= 20; i++) history.push(...turn(i)); // 40 сообщений + system
  const w = windowForLlm(history, 16);
  assert.strictEqual(w.length, 17); // system + 16
  assert.strictEqual(w[0], sys);
  assert.strictEqual(w.at(-1).text, "ответ 20"); // хвост сохранён
});

test("окно начинается с реплики клиента (ведущий assistant отбрасывается)", () => {
  const history = [sys];
  for (let i = 1; i <= 20; i++) history.push(...turn(i));
  const w = windowForLlm(history, 15); // нечётный срез начался бы с assistant
  assert.strictEqual(w[1].role, "user");
});

test("исходная история не мутируется", () => {
  const history = [sys];
  for (let i = 1; i <= 20; i++) history.push(...turn(i));
  const len = history.length;
  windowForLlm(history, 4);
  assert.strictEqual(history.length, len);
});
