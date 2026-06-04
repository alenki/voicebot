// node --test env.test.mjs
// Проверка обязательных переменных окружения на старте: пропущенный ключ должен падать
// понятной ошибкой, а не «fetch failed» в середине звонка. Чистые функции — env аргументом.
import { test } from "node:test";
import assert from "node:assert";
import { missingKeys, assertEnv } from "./env.mjs";

test("missingKeys возвращает [] когда все ключи заданы", () => {
  assert.deepEqual(missingKeys({ A: "1", B: "2" }, ["A", "B"]), []);
});

test("missingKeys перечисляет отсутствующие и пустые ключи", () => {
  assert.deepEqual(missingKeys({ A: "1", B: "   " }, ["A", "B", "C"]), ["B", "C"]);
});

test("assertEnv бросает с именами отсутствующих ключей и меткой", () => {
  assert.throws(
    () => assertEnv({ A: "1" }, ["A", "B", "C"], "Yandex"),
    (e) => /B/.test(e.message) && /C/.test(e.message) && /Yandex/.test(e.message) && !/(^|\W)A(\W|$)/.test(e.message),
  );
});

test("assertEnv не бросает, когда все ключи заданы", () => {
  assert.doesNotThrow(() => assertEnv({ A: "1", B: "2" }, ["A", "B"], "Yandex"));
});
