// Доставка захваченной заявки менеджеру в Telegram. После звонка order-extract отдаёт поля
// заявки, formatLead собирает читаемое сообщение, deliverLead шлёт его в чат владельца.
// deliverLead НИКОГДА не бросает — сбой Telegram не должен ломать завершение звонка.
// Недоставленная заявка НЕ исчезает: она дописывается в локальный leads.ndjson —
// единственный шанс не потерять лид при лежащем Telegram или незаполненных настройках.
import { appendFileSync } from "node:fs";

const LABELS = [
  ["item", "Что"],
  ["qty", "Тираж"],
  ["format", "Формат"],
  ["material", "Материал"],
  ["deadline", "Срок"],
  ["name", "Имя"],
  ["phone", "Телефон"],
];

// Таймаут на вызов Telegram: без него зависший fetch держал SIGTERM-дренаж бесконечно
// (перезапуск сервера «замирал», второй Ctrl+C терял заявки остальных сессий).
const TG_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS) || 10_000;

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

// Локальный страховочный журнал заявок (NDJSON). Инжектируется в тестах.
function persistLead(fields, meta, reason) {
  const file = process.env.LEADS_FILE ?? "leads.ndjson";
  if (!file) return; // LEADS_FILE="" — журнал отключён явно
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), reason, meta, fields }) + "\n");
}

// Шлём заявку в Telegram. Токен и чат — из env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).
// Нет настроек → пропускаем (skipped), но заявку пишем в журнал. Сетевой сбой → один
// повтор, затем { ok:false, error } без throw — и тоже в журнал.
export async function deliverLead(fields, meta = {}, { persist = persistLead, attempts = 2, retryDelayMs = 1500 } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("⚠ TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — заявка не отправлена в Telegram");
    try { persist(fields, meta, "skipped"); } catch {}
    return { ok: false, skipped: true };
  }
  let lastError = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: formatLead(fields, meta) }),
        signal: AbortSignal.timeout(TG_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true };
      lastError = `Telegram ${res.status}: ${await res.text()}`;
      if (res.status >= 400 && res.status < 500) break; // неверный токен/чат — повтор не поможет
    } catch (e) {
      lastError = String(e?.message || e);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  try { persist(fields, meta, "failed"); } catch {}
  return { ok: false, error: lastError };
}
