import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLead, deliverLead } from "./lead.mjs";

const FULL = {
  item: "визитки",
  qty: "1000",
  format: "90x50",
  material: "мелованная бумага",
  deadline: "к пятнице",
  name: "Аслан",
  phone: "+79281112233",
};

test("formatLead включает все значения заявки", () => {
  const msg = formatLead(FULL, { callId: "stream-123" });
  assert.match(msg, /Альфа Принт/);
  assert.match(msg, /визитки/);
  assert.match(msg, /1000/);
  assert.match(msg, /90x50/);
  assert.match(msg, /Аслан/);
  assert.match(msg, /\+79281112233/);
  assert.match(msg, /stream-123/);
});

test("formatLead показывает пустые поля как —", () => {
  const msg = formatLead({ ...FULL, material: "", deadline: "" }, { callId: "x" });
  // материал и срок пусты → прочерк; имя/телефон остаются
  assert.match(msg, /Материал: —/);
  assert.match(msg, /Срок: —/);
  assert.match(msg, /Аслан/);
});

test("deliverLead без env-переменных не шлёт, не бросает — и пишет заявку в журнал", async () => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedChat = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  const persisted = [];
  try {
    const r = await deliverLead(FULL, { callId: "x" }, { persist: (f, m, reason) => persisted.push(reason) });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    // недоставленный лид не исчезает: он уходит в локальный журнал
    assert.deepEqual(persisted, ["skipped"]);
  } finally {
    if (savedToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedChat !== undefined) process.env.TELEGRAM_CHAT_ID = savedChat;
  }
});
