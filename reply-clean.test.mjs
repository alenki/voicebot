import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feminize,
  stripWrappingQuotes,
  stripRolePlay,
  enforcePhoneGate,
  hasPhone,
  cleanReply,
} from "./reply-clean.mjs";

test("feminize: чинит мужской род о себе", () => {
  assert.equal(feminize("Понял вас, записал заявку."), "Поняла вас, записала заявку.");
  assert.equal(feminize("Я рад помочь"), "Я рада помочь");
  assert.equal(feminize("готов записать"), "готова записать");
});

test("feminize: не калечит другие слова", () => {
  assert.equal(feminize("Всё готово, я рады за вас"), "Всё готово, я рады за вас"); // готово/рады не трогаем
  assert.equal(feminize("ради вас сделаю"), "ради вас сделаю"); // 'ради' не 'рад'
  assert.equal(feminize("Понятно, спасибо"), "Понятно, спасибо"); // 'понятно' не 'понял'
});

test("stripWrappingQuotes: снимает обёртку-ёлочки, бережёт внутренние", () => {
  assert.equal(stripWrappingQuotes("«Визитки — это к нам. А для какой сферы?»"), "Визитки — это к нам. А для какой сферы?");
  assert.equal(stripWrappingQuotes("Мы из «Альфа Принт», что напечатать?"), "Мы из «Альфа Принт», что напечатать?");
  // две открывающие — не наша обёртка, не трогаем
  assert.equal(stripWrappingQuotes("«Это «Альфа Принт» лучшее»"), "«Это «Альфа Принт» лучшее»");
});

test("stripRolePlay: режет доигранный диалог в одну строку", () => {
  const hallucinated = "Тираж какой думаете? Пользователь: Штук триста Ассистент: Отлично.";
  assert.equal(stripRolePlay(hallucinated), "Тираж какой думаете?");
});

test("hasPhone: цифрами и словами", () => {
  assert.equal(hasPhone([{ role: "user", text: "89287123456" }]), true);
  assert.equal(hasPhone([{ role: "user", text: "восемь девять два восемь семь один" }]), true);
  assert.equal(hasPhone([{ role: "user", text: "нужны визитки, штук триста" }]), false);
});

test("enforcePhoneGate: обещание звонка без номера → просьба номера", () => {
  const hist = [{ role: "user", text: "нужны визитки" }];
  const reply = "Передаю заявку, менеджер перезвонит с расчётом. Спасибо.";
  assert.match(enforcePhoneGate(hist, reply), /продиктуйте номер/i);
});

test("enforcePhoneGate: реплика сама просит номер → не трогаем", () => {
  const hist = [{ role: "user", text: "нужны визитки" }];
  const reply = "Оставьте номер, менеджер сам наберёт с расчётом.";
  assert.equal(enforcePhoneGate(hist, reply), reply);
});

test("enforcePhoneGate: номер уже есть в истории → не трогаем", () => {
  const hist = [{ role: "user", text: "мой номер 89287123456" }];
  const reply = "Отлично, менеджер перезвонит с расчётом.";
  assert.equal(enforcePhoneGate(hist, reply), reply);
});

test("enforcePhoneGate: ассумптивный шаг без обещания звонка → не трогаем", () => {
  const hist = [{ role: "user", text: "срочно к пятнице" }];
  const reply = "Передам менеджеру, что нужно к пятнице. Давайте запишу заявку?";
  assert.equal(enforcePhoneGate(hist, reply), reply);
});

test("cleanReply: композиция чинит род и обёртку", () => {
  assert.equal(cleanReply("«Записал вашу заявку.»"), "Записала вашу заявку.");
});
