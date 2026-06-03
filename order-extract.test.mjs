import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrderJson } from "./order-extract.mjs";

const KEYS = ["item", "qty", "format", "material", "deadline", "name", "phone"];

test("парсит чистый JSON-объект заявки", () => {
  const raw =
    '{"hasOrder":true,"item":"визитки","qty":"1000","format":"90x50","material":"","deadline":"к пятнице","name":"Аслан","phone":"+79281112233"}';
  const r = parseOrderJson(raw);
  assert.equal(r.hasOrder, true);
  assert.equal(r.fields.item, "визитки");
  assert.equal(r.fields.qty, "1000");
  assert.equal(r.fields.name, "Аслан");
  assert.equal(r.fields.phone, "+79281112233");
});

test("снимает ```json-ограждение", () => {
  const raw = "```json\n{\"hasOrder\":true,\"item\":\"баннер\"}\n```";
  const r = parseOrderJson(raw);
  assert.equal(r.hasOrder, true);
  assert.equal(r.fields.item, "баннер");
});

test("достаёт объект из окружающего текста", () => {
  const raw = 'Вот заявка: {"hasOrder":true,"item":"листовки"} — готово.';
  const r = parseOrderJson(raw);
  assert.equal(r.hasOrder, true);
  assert.equal(r.fields.item, "листовки");
});

test("hasOrder:false пробрасывается", () => {
  const r = parseOrderJson('{"hasOrder":false}');
  assert.equal(r.hasOrder, false);
});

test("мусор без JSON не роняет, hasOrder=false и поля пусты", () => {
  const r = parseOrderJson("извините, не смог разобрать");
  assert.equal(r.hasOrder, false);
  for (const k of KEYS) assert.equal(r.fields[k], "");
});

test("отсутствующие поля нормализуются в пустые строки", () => {
  const r = parseOrderJson('{"hasOrder":true,"item":"меню"}');
  for (const k of KEYS) assert.equal(typeof r.fields[k], "string");
  assert.equal(r.fields.material, "");
});

test("числовые значения приводятся к строке", () => {
  const r = parseOrderJson('{"hasOrder":true,"qty":1000}');
  assert.equal(r.fields.qty, "1000");
});

test("null-значения становятся пустой строкой", () => {
  const r = parseOrderJson('{"hasOrder":true,"material":null}');
  assert.equal(r.fields.material, "");
});

test("пустой/невалидный вход не роняет", () => {
  assert.equal(parseOrderJson("").hasOrder, false);
  assert.equal(parseOrderJson(undefined).hasOrder, false);
});
