// node --test sentences.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { splitSentences, chunkForTts } from "./sentences.mjs";

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

// yandexgpt иногда отвечает списком без точек («* Визитки\n* Баннеры»). Без разбиения
// по \n такой ответ не делится на предложения и стриминговый путь молчит до конца
// генерации. Перенос строки = граница предложения.
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

// Точка после сокращения — не конец предложения: адрес из ФАКТОВ раньше разлетался
// на огрызки («Адрес: г.» / «Нальчик, ул.» / «Тарчокова, 29.») с паузами TTS внутри.
test("не режет после сокращений «г.» / «ул.» — адрес остаётся одним предложением", () => {
  assert.deepStrictEqual(
    splitSentences("Мы в г. Нальчик, ул. Тарчокова, 29. Заезжайте!"),
    ["Мы в г. Нальчик, ул. Тарчокова, 29.", "Заезжайте!"],
  );
});

test("сокращение «т. д.» не рвёт предложение", () => {
  assert.deepStrictEqual(
    splitSentences("Печатаем визитки, буклеты и т. д. Что вам нужно?"),
    ["Печатаем визитки, буклеты и т. д.", "Что вам нужно?"],
  );
});

// SpeechKit v1 синтезирует ≤ ~250 символов: слишком длинное предложение падало в TTS
// целиком и молча пропадало из речи Евы.
test("chunkForTts: короткий текст — один кусок, длинный режется по запятой/пробелу", () => {
  assert.deepStrictEqual(chunkForTts("Короткая фраза."), ["Короткая фраза."]);

  const long = ("Мы печатаем визитки, буклеты, листовки, сертификаты, открытки, бирки, " +
    "этикетки, баннеры, плакаты, наклейки и меню, ").repeat(3) + "приходите к нам.";
  const chunks = chunkForTts(long, 240);
  assert.ok(chunks.length > 1, "длинный текст должен разрезаться");
  for (const c of chunks) assert.ok(c.length <= 240, `кусок длиннее лимита: ${c.length}`);
  // Ничего не потеряно: склейка кусков совпадает с исходником с точностью до пробелов
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
});
