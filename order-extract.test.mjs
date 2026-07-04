import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrderJson, normalizePhone } from "./order-extract.mjs";

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

test('строковый "false" — это false (Boolean("false") давал спам-заявки)', () => {
  assert.equal(parseOrderJson('{"hasOrder":"false"}').hasOrder, false);
  assert.equal(parseOrderJson('{"hasOrder":"true","item":"визитки"}').hasOrder, true);
});

test("normalizePhone: слова-цифры → цифры, мусор отбрасывается", () => {
  assert.equal(normalizePhone("восемь девять два восемь семь один два три четыре пять шесть"), "89287123456");
  assert.equal(normalizePhone("8 (928) 712-34-56"), "89287123456");
  assert.equal(normalizePhone("+7 928 712 34 56"), "+79287123456");
  // меньше семи цифр — оставляем как есть (лучше сырой текст, чем обрывок)
  assert.equal(normalizePhone("два три"), "два три");
  assert.equal(normalizePhone(""), "");
});

test("normalizePhone: составные числительные не переводим — сырой текст, а не битый номер", () => {
  // «девятьсот девяносто…» единичной заменой не переводится: получился бы «чистый»,
  // но НЕВЕРНЫЙ номер (потерянные разряды) — менеджер звонил бы не туда.
  const raw = "восемь девятьсот девяносто два сто двадцать три сорок пять шестьдесят семь";
  assert.equal(normalizePhone(raw), raw);
});

test("parseOrderJson нормализует телефон из слов", () => {
  const r = parseOrderJson('{"hasOrder":true,"phone":"восемь девять два восемь семь один два три четыре пять шесть"}');
  assert.equal(r.fields.phone, "89287123456");
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
