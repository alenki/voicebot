// node --test bargein.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { isSubstantive, shouldInterrupt, isEchoOf } from "./bargein.mjs";

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

// Эхо собственной речи Евы: на громкой связи её голос возвращается с микрофона абонента,
// STT его распознаёт, и без гейта Ева «перебивала бы сама себя» (живой симптом: на любом
// нестабильном/громком звонке речь обрывается без причины). Эхо = партиал, почти целиком
// собранный из слов, которые Ева произносит в текущем ходе.
test("isEchoOf: партиал из слов Евы — эхо", () => {
  const self = "Здравствуйте! Это типография Альфа Принт, меня зовут Ева. Чем могу помочь?";
  assert.strictEqual(isEchoOf("чем могу помочь", self), true);
  assert.strictEqual(isEchoOf("это типография альфа принт", self), true);
});

test("isEchoOf: реальная речь абонента — не эхо", () => {
  const self = "Здравствуйте! Это типография Альфа Принт, меня зовут Ева. Чем могу помочь?";
  assert.strictEqual(isEchoOf("мне нужны визитки", self), false);
  assert.strictEqual(isEchoOf("здравствуйте мне нужны сто визиток", self), false);
});

test("isEchoOf: одно слово эхом не считается (короткие ответы абонента не глушим)", () => {
  // «визитки» в ответ на «вам визитки или баннеры?» — это ответ, а не эхо.
  assert.strictEqual(isEchoOf("визитки", "вам визитки или баннеры"), false);
});

test("isEchoOf: пустой selfText — не эхо", () => {
  assert.strictEqual(isEchoOf("чем могу помочь", ""), false);
  assert.strictEqual(isEchoOf("чем могу помочь", null), false);
});

test("shouldInterrupt: эхо текущей речи Евы не перебивает", () => {
  const self = "Визитки стоят от тысячи рублей за сто штук";
  assert.strictEqual(
    shouldInterrupt("SPEAKING", "стоят от тысячи рублей", 1000, 500, "", self),
    false,
  );
});

test("shouldInterrupt: настоящая речь поверх речи Евы перебивает", () => {
  const self = "Визитки стоят от тысячи рублей за сто штук";
  assert.strictEqual(
    shouldInterrupt("SPEAKING", "подождите мне нужен баннер", 1000, 500, "", self),
    true,
  );
});
