// node --test bargein.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { isSubstantive, shouldInterrupt } from "./bargein.mjs";

test("backchannels do not count as interruption", () => {
  for (const w of ["угу", "ага", "да", "да-да", "мгм", "Ага."]) {
    assert.strictEqual(isSubstantive(w), false, `ожидалось false для "${w}"`);
  }
});

test("substantive speech counts as interruption", () => {
  assert.strictEqual(isSubstantive("подождите а сколько стоит"), true);
  assert.strictEqual(isSubstantive("нет я хотел баннер"), true);
});

test("empty or whitespace is not substantive", () => {
  assert.strictEqual(isSubstantive("  "), false);
});

test("stacked backchannels do not interrupt (whole utterance is backchannel)", () => {
  for (const w of ["да да", "ну да", "ага угу", "да-да-да", "угу угу", "ага ага", "ну ну"]) {
    assert.strictEqual(isSubstantive(w), false, `ожидалось false для "${w}"`);
  }
});

test("backchannel followed by real content still interrupts", () => {
  assert.strictEqual(isSubstantive("да баннер нужен"), true);
  assert.strictEqual(isSubstantive("нет подождите"), true);
});

test("shouldInterrupt: fires on substantive speech while Ева has the floor", () => {
  assert.strictEqual(shouldInterrupt("SPEAKING", "нет я хотел баннер", 1000, 500), true);
  assert.strictEqual(shouldInterrupt("THINKING", "подождите сколько стоит", 1000, 500), true);
});

test("shouldInterrupt: never fires while listening", () => {
  assert.strictEqual(shouldInterrupt("LISTENING", "нет я хотел баннер", 1000, 500), false);
});

test("shouldInterrupt: suppressed inside the grace window", () => {
  assert.strictEqual(shouldInterrupt("SPEAKING", "нет я хотел баннер", 200, 500), false);
});

test("shouldInterrupt: backchannels never interrupt", () => {
  assert.strictEqual(shouldInterrupt("SPEAKING", "угу", 1000, 500), false);
});

// Эхо-гейт сведён в саму политику (5-й аргумент): партиал, дословно равный последней
// финализированной реплике абонента, — это «хвост» уже завершённого хода в STT, не новое
// перебивание. Раньше эта проверка жила в call-site stream-server.mjs; теперь — здесь,
// чтобы вся логика barge-in была в одной тестируемой функции.
test("shouldInterrupt: echo of the just-finalized utterance does not interrupt", () => {
  assert.strictEqual(
    shouldInterrupt("SPEAKING", "нет я хотел баннер", 1000, 500, "нет я хотел баннер"),
    false,
  );
  assert.strictEqual(
    shouldInterrupt("THINKING", "сколько стоит баннер", 1000, 500, "сколько стоит баннер"),
    false,
  );
});

test("shouldInterrupt: substantive speech different from the last final still interrupts", () => {
  assert.strictEqual(
    shouldInterrupt("SPEAKING", "подождите сколько стоит", 1000, 500, "нет я хотел баннер"),
    true,
  );
});

test("shouldInterrupt: omitting lastFinalText leaves the echo guard inert (back-compat)", () => {
  // 4-аргументная форма — поведение не меняется (эхо-гейт применяется только когда передан).
  assert.strictEqual(shouldInterrupt("SPEAKING", "нет я хотел баннер", 1000, 500), true);
});

test("shouldInterrupt: empty lastFinalText does not suppress a substantive partial", () => {
  // На старте звонка lastFinalText === "" — он не должен глушить реальную речь.
  assert.strictEqual(shouldInterrupt("SPEAKING", "нет я хотел баннер", 1000, 500, ""), true);
});
