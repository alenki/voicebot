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
