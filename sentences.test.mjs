// node --test sentences.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { splitSentences } from "./sentences.mjs";

test("splits on sentence punctuation", () => {
  assert.deepStrictEqual(
    splitSentences("Делаем баннеры. Цену рассчитает менеджер. Оформить заявку?"),
    ["Делаем баннеры.", "Цену рассчитает менеджер.", "Оформить заявку?"],
  );
});

test("returns whole text when no terminal punctuation", () => {
  assert.deepStrictEqual(splitSentences("Делаем баннеры"), ["Делаем баннеры"]);
});

test("ignores empty trailing fragments", () => {
  assert.deepStrictEqual(splitSentences("Да.  "), ["Да."]);
});
