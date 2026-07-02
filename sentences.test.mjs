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

// yandexgpt-lite иногда отвечает списком без точек («* Визитки\n* Баннеры»). Без
// разбиения по \n такой ответ не делится на предложения и стриминговый путь молчит
// до конца генерации. Перенос строки = граница предложения.
test("splits on newlines when there is no terminal punctuation", () => {
  assert.deepStrictEqual(
    splitSentences("Визитки\nБаннеры\nЛистовки"),
    ["Визитки", "Баннеры", "Листовки"],
  );
});

test("newlines and punctuation mix: both act as boundaries", () => {
  assert.deepStrictEqual(
    splitSentences("Делаем визитки.\nЕщё баннеры\nОформить заявку?"),
    ["Делаем визитки.", "Ещё баннеры", "Оформить заявку?"],
  );
});

test("blank lines do not produce empty sentences", () => {
  assert.deepStrictEqual(splitSentences("Визитки\n\n\nБаннеры"), ["Визитки", "Баннеры"]);
});
