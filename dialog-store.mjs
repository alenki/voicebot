// Хранилище диалогов turn-based пути (server.mjs) + доставка заявки при завершении.
// Раньше /end просто удалял историю — ЖИВОЙ путь вообще не отправлял заявку менеджеру
// (Telegram-доставка была только в стриминговом спайке). Теперь завершение звонка
// (/end, TTL-выметание потерянных звонков, SIGTERM-дренаж) извлекает заявку из истории
// и шлёт её в Telegram — та же связка extractOrder → deliverLead, что и в stream-server.
//
// Зависимости инжектируются (extractOrder/deliverLead/now) — юнит-тестируется без сети.
export function createDialogStore({
  extractOrder,
  deliverLead,
  systemText,
  ttlMs = 30 * 60_000,   // звонок без /end (упавший запрос сценария, обрыв ngrok) не живёт вечно
  now = Date.now,
  log = console,
} = {}) {
  const dialogs = new Map(); // callId -> { history, lastAt, finalized }

  // История звонка; создаётся при первом обращении. Каждое обращение продлевает TTL.
  function history(callId) {
    let d = dialogs.get(callId);
    if (!d) {
      d = { history: [{ role: "system", text: systemText }], lastAt: now(), finalized: false };
      dialogs.set(callId, d);
    }
    d.lastAt = now();
    return d.history;
  }

  // Завершение звонка: достаём заявку из истории и шлём менеджеру. Один раз на звонок
  // (finalized-флаг: /end и TTL-выметание могут сойтись на одном callId). Любой сбой —
  // только лог: доставка заявки не должна ломать ответ /end или остановку сервера.
  async function finalize(callId, reason = "end") {
    const d = dialogs.get(callId);
    dialogs.delete(callId);
    if (!d || d.finalized) return;
    d.finalized = true;
    try {
      const { hasOrder, fields } = await extractOrder(d.history);
      // Телефон без «оформленной заявки» — всё равно лид: клиент оставил контакт для
      // расчёта (та же логика, что в stream-server.finalizeLead).
      if (!hasOrder && !(fields?.phone || "").trim()) {
        log.log(`[${callId}] заявка не оформлена и телефона нет (${reason}) — в Telegram не шлём`);
        return;
      }
      const time = new Date(now()).toLocaleString("ru-RU");
      const r = await deliverLead(fields, { callId, time });
      log.log(
        `[${callId}] заявка → Telegram (${reason}): ${r.ok ? "отправлена" : `не отправлена (${r.error || (r.skipped ? "нет настроек" : "?")})`}`,
      );
    } catch (e) {
      log.error(`[${callId}] ошибка доставки заявки:`, e?.message || e);
    }
  }

  // Выметание простоявших звонков: /end мог не дойти (ngrok мигнул, сценарий упал) —
  // без этого история висит в памяти вечно, а заявка молча теряется.
  function sweep() {
    const t = now();
    const stale = [...dialogs].filter(([, d]) => t - d.lastAt > ttlMs).map(([id]) => id);
    return Promise.allSettled(stale.map((id) => finalize(id, "ttl")));
  }

  // Грейсфул-шатдаун: до-оформить заявки всех активных звонков перед выходом.
  function drain() {
    return Promise.allSettled([...dialogs.keys()].map((id) => finalize(id, "shutdown")));
  }

  return { history, finalize, sweep, drain, get size() { return dialogs.size; } };
}
