// Доставка захваченной заявки менеджеру в Telegram. После звонка order-extract отдаёт поля
// заявки, formatLead собирает читаемое сообщение, deliverLead шлёт его в чат владельца.
// deliverLead НИКОГДА не бросает — сбой Telegram не должен ломать завершение звонка.

const LABELS = [
  ["item", "Что"],
  ["qty", "Тираж"],
  ["format", "Формат"],
  ["material", "Материал"],
  ["deadline", "Срок"],
  ["name", "Имя"],
  ["phone", "Телефон"],
];

// Чистая функция: поля заявки -> текст сообщения. Пустые поля показываем прочерком.
export function formatLead(fields = {}, meta = {}) {
  const lines = ["🖨 Новая заявка — Альфа Принт", ""];
  for (const [key, label] of LABELS) {
    const v = (fields[key] ?? "").toString().trim();
    lines.push(`${label}: ${v || "—"}`);
  }
  if (meta.callId || meta.time) {
    lines.push("——");
    if (meta.time) lines.push(`Время: ${meta.time}`);
    if (meta.callId) lines.push(`Звонок: ${meta.callId}`);
  }
  return lines.join("\n");
}

// Шлём заявку в Telegram. Токен и чат — из env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).
// Нет настроек → тихо пропускаем (skipped). Сетевой сбой → { ok:false, error } без throw.
export async function deliverLead(fields, meta = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("⚠ TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — заявка не отправлена в Telegram");
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: formatLead(fields, meta) }),
    });
    if (!res.ok) return { ok: false, error: `Telegram ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
