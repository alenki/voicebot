// node --test bargein.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { isSubstantive } from "./bargein.mjs";

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
