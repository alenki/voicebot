import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feminize,
  stripWrappingQuotes,
  stripRolePlay,
  enforcePhoneGate,
  needsPhoneAsk,
  hasPhone,
  cleanReply,
  spellOutPhoneRuns,
  hasBotLeak,
  BOT_DEFLECT,
  PHONE_ASKS,
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

test("feminize: не трогает мужской род чужих подлежащих", () => {
  // «заказ будет готов» — род правильный; слепое феминизирование давало «будет готова»
  assert.equal(feminize("Заказ будет готов, менеджер сообщит."), "Заказ будет готов, менеджер сообщит.");
  assert.equal(feminize("Макет готов к печати."), "Макет готов к печати.");
  assert.equal(feminize("Менеджер передал ваш заказ в работу."), "Менеджер передал ваш заказ в работу.");
  assert.equal(feminize("Он записал все детали."), "Он записал все детали.");
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

test("stripRolePlay: инлайн-метки «Ева:»/«Менеджер:» после конца предложения режутся", () => {
  assert.equal(stripRolePlay("Записала. Ева: Что ещё нужно?"), "Записала.");
  assert.equal(stripRolePlay("Хорошо. Менеджер: посчитаю завтра"), "Хорошо.");
});

test("stripRolePlay: двоеточие ПОСРЕДИ предложения — живая речь, не трогаем", () => {
  const legit = "Наш менеджер: Иван, он всё посчитает.";
  assert.equal(stripRolePlay(legit), legit);
});

test("stripRolePlay: метка-префикс — свою срезает, чужую выбрасывает целиком", () => {
  assert.equal(stripRolePlay("Ева: Визитки — это к нам."), "Визитки — это к нам.");
  assert.equal(stripRolePlay("Клиент: мне нужны визитки"), ""); // целиком выдуманная реплика клиента
});

test("spellOutPhoneRuns: слитный номер → цифры-слова, тиражи/размеры не трогает", () => {
  assert.equal(
    spellOutPhoneRuns("Повторю: 89287123456 — верно?"),
    "Повторю: восемь, девять, два, восемь, семь, один, два, три, четыре, пять, шесть — верно?",
  );
  assert.equal(spellOutPhoneRuns("Тираж 1000 штук, размер 90 на 50"), "Тираж 1000 штук, размер 90 на 50");
});

test("hasBotLeak: ловит встроенные отказы модели, cleanReply подменяет реплику", () => {
  assert.equal(hasBotLeak("Как языковая модель, я не могу ответить."), true);
  assert.equal(hasBotLeak("Я виртуальный ассистент компании."), true);
  assert.equal(hasBotLeak("Да живая, конечно. Так что напечатать?"), false);
  assert.equal(cleanReply("Я — бот, отвечаю на вопросы."), BOT_DEFLECT);
});

test("hasBotLeak: тема «нейросеть» в живой реплике — не утечка", () => {
  assert.equal(hasBotLeak("Макет нейросетью тоже можно, это уточнит менеджер."), false);
  assert.equal(hasBotLeak("Я не робот, я Ева."), false); // «я не робот» — отнекивание, не признание
});

test("hasPhone: цифрами и словами", () => {
  assert.equal(hasPhone([{ role: "user", text: "89287123456" }]), true);
  assert.equal(hasPhone([{ role: "user", text: "8 928 712-34-56" }]), true); // с разделителями
  assert.equal(hasPhone([{ role: "user", text: "восемь девять два восемь семь один" }]), true);
  assert.equal(hasPhone([{ role: "user", text: "нужны визитки, штук триста" }]), false);
});

test("hasPhone: цифры вразброс (размеры + тираж) — НЕ телефон", () => {
  // раньше 8 цифр суммарно ложно удовлетворяли гейт, и Ева закрывала звонок без номера
  assert.equal(hasPhone([{ role: "user", text: "визитки 90 на 50, тираж 1000" }]), false);
  assert.equal(hasPhone([{ role: "user", text: "баннер 3 на 6, штук 25, к 15 числу" }]), false);
});

test("hasPhone: номер, продиктованный в два захода, склеивается", () => {
  assert.equal(hasPhone([
    { role: "user", text: "записывайте 8928" },
    { role: "user", text: "7123456" },
  ]), true);
  assert.equal(hasPhone([
    { role: "user", text: "восемь девять два восемь" },
    { role: "user", text: "семь один два три" },
  ]), true);
  // но обычные числа в соседних репликах не склеиваются в «телефон»
  assert.equal(hasPhone([
    { role: "user", text: "тираж 300" },
    { role: "user", text: "и ещё 5000 листовок" },
  ]), false);
  assert.equal(hasPhone([
    { role: "user", text: "нужно 1000" },
    { role: "user", text: "500 листовок ещё" },
  ]), false); // 4+3 цифры стыкуются, но 7 склеенных — не номер (номер ≥9)
  assert.equal(hasPhone([
    { role: "user", text: "баннер два на три" },
    { role: "user", text: "нет, три на четыре и два держателя" },
  ]), false); // размеры словами не складываются в «телефон»
});

test("enforcePhoneGate: бытовые «не надо» про опции заказа — не отказ, гейт жив", () => {
  const hist = [
    { role: "user", text: "нужны визитки, дизайн не надо, макет свой" },
    { role: "assistant", text: "Хорошо. Тираж какой?" },
    { role: "user", text: "тысяча. ламинацию не нужно" },
  ];
  const reply = "Отлично, менеджер перезвонит с расчётом.";
  assert.equal(PHONE_ASKS.includes(enforcePhoneGate(hist, reply)), true,
    "два «не надо» про допуслуги не должны выключать страховку лида");
});

test("enforcePhoneGate: обещание звонка без номера → просьба номера", () => {
  const hist = [{ role: "user", text: "нужны визитки" }];
  const reply = "Передаю заявку, менеджер перезвонит с расчётом. Спасибо.";
  assert.match(enforcePhoneGate(hist, reply), /продиктуйте/i);
});

test("enforcePhoneGate: ловит перефразировки обещания («свяжемся», «позвоним», «наберет», «соединю»)", () => {
  const hist = [{ role: "user", text: "нужны баннеры" }];
  for (const reply of [
    "Мы свяжемся с вами и всё посчитаем. Хорошего дня!",
    "Хорошо, мы вам позвоним с готовым расчётом. До связи!",
    "Наш специалист сам наберет вас с расчётом.",   // «е» вместо «ё»
    "Сейчас соединю вас с менеджером.",             // соединить она не может
    "Менеджер перезвонит по указанному номеру.",    // номера никто не указывал
  ]) {
    assert.equal(PHONE_ASKS.includes(enforcePhoneGate(hist, reply)), true, reply);
  }
});

test("enforcePhoneGate: «позвоните нам» и «наберите нас» (императивы клиенту) гейт не трогает", () => {
  const hist = [{ role: "user", text: "нужны визитки" }];
  for (const reply of [
    "Захотите — наберите нас, посчитаем в любой момент. Хорошего дня!",
    "Вы всегда можете позвонить нам сами.",
  ]) {
    assert.equal(enforcePhoneGate(hist, reply), reply, reply);
  }
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

test("enforcePhoneGate: после второго отказа клиента не давит третьей просьбой", () => {
  const hist = [
    { role: "user", text: "нужны баннеры" },
    { role: "assistant", text: "Давайте запишу заявку?" },
    { role: "user", text: "я подумаю и сам перезвоню" },
    { role: "assistant", text: "Оставьте номер, менеджер сам наберёт с расчётом." },
    { role: "user", text: "нет, не надо, я сам наберу попозже" },
  ];
  const reply = "Договорились, менеджер на месте до шести — свяжемся, если что. Хорошего дня!";
  assert.equal(enforcePhoneGate(hist, reply), reply); // отпустили — не переспрашиваем
  assert.equal(needsPhoneAsk(hist, reply), false);
});

test("enforcePhoneGate: варианты просьбы ротируются по ходу звонка", () => {
  const short = [{ role: "user", text: "х" }];
  const longer = [...short, { role: "assistant", text: "y" }];
  const reply = "Менеджер перезвонит с расчётом.";
  assert.notEqual(enforcePhoneGate(short, reply), enforcePhoneGate(longer, reply));
});

test("cleanReply: композиция чинит род и обёртку", () => {
  assert.equal(cleanReply("«Записал вашу заявку.»"), "Записала вашу заявку.");
});
