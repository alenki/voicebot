import express from "express";
import { ask } from "./speech.mjs";
import { SYSTEM } from "./prompt.mjs";
import { cleanReply, enforcePhoneGate } from "./reply-clean.mjs";
import { windowForLlm } from "./history.mjs";
import { assertEnv, missingKeys } from "./env.mjs";
import { extractOrder } from "./order-extract.mjs";
import { deliverLead } from "./lead.mjs";
import { createDialogStore } from "./dialog-store.mjs";

// Fail-fast: без ключей Yandex /reply падает безликим «fetch failed» в середине звонка.
assertEnv(process.env, ["YANDEX_API_KEY", "YANDEX_FOLDER_ID"], "Yandex");
if (missingKeys(process.env, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]).length) {
  console.warn("⚠ TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — заявки НЕ уйдут в Telegram (только в leads.ndjson)");
}

// Общий секрет для /reply и /end: ngrok-туннель публичен, без гейта любой может жечь
// квоту YandexGPT и стирать историю звонков (/end). Сценарий Voximplant шлёт секрет в
// заголовке X-Backend-Token. Не задан → пускаем всех, но громко предупреждаем на старте.
const REPLY_SECRET = process.env.REPLY_SECRET || "";

const app = express();
app.use(express.json({ limit: "64kb" }));

// Health-проба: убедиться, что бэкенд жив, перед вставкой ngrok-URL в сценарий Voximplant.
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use((req, res, next) => {
  if (!REPLY_SECRET || req.get("x-backend-token") === REPLY_SECRET) return next();
  res.status(401).json({ error: "unauthorized" });
});

// Хранилище диалогов + доставка заявки менеджеру при завершении звонка (/end, TTL,
// SIGTERM). Раньше живой путь просто СТИРАЛ историю — Telegram-заявка была только в
// стриминговом спайке, и весь смысл звонка (лид) терялся.
const store = createDialogStore({
  extractOrder,
  deliverLead,
  systemText: SYSTEM,
  ttlMs: Number(process.env.DIALOG_TTL_MS) || 30 * 60_000,
});
const sweepTimer = setInterval(() => store.sweep(), 60_000);
sweepTimer.unref();

// Модель вернула пустой ответ (контент-фильтр, пустые alternatives) или очистка съела
// всё — «пустую» реплику нельзя отдавать: TTS промолчит, и абонент слышит мёртвую тишину.
const EMPTY_FALLBACK = "Извините, я вас не совсем поняла. Подскажите, что нужно напечатать?";

// Лог-строки не должны ломаться внедрёнными переносами (callId/text приходят снаружи).
const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 500);

app.post("/reply", async (req, res) => {
  try {
    const { callId, text } = req.body ?? {};
    if (typeof callId !== "string" || !callId || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "нужны callId и text (строки)" });
    }

    const history = store.history(callId);
    history.push({ role: "user", text: text.slice(0, 2000) });

    // history уже содержит текущую реплику клиента (но ещё не ответ Евы) — гейт по ней
    // решает, не пытается ли Ева закрыть заявку без телефона. В модель идёт окно
    // (windowForLlm), гейту и extractOrder нужна ПОЛНАЯ история — её не трогаем.
    let reply = enforcePhoneGate(history, cleanReply(await ask(windowForLlm(history))));
    if (!reply.trim()) reply = EMPTY_FALLBACK;
    history.push({ role: "assistant", text: reply });

    console.log(`[${oneLine(callId)}] клиент: ${oneLine(text)}`);
    console.log(`[${oneLine(callId)}] бот:    ${oneLine(reply)}`);
    res.json({ reply });
  } catch (err) {
    console.error(err);
    // Наружу — только generic: сырой текст ошибки может содержать URL/детали запроса к Yandex.
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/end", (req, res) => {
  const callId = req.body?.callId;
  res.json({ ok: true }); // сценарию ждать нечего — доставка заявки идёт в фоне
  if (typeof callId === "string" && callId) {
    store.finalize(callId).catch((e) => console.error(`[${oneLine(callId)}] finalize:`, e?.message || e));
  }
});

const server = app.listen(3000, () => {
  console.log("Backend слушает http://localhost:3000");
  if (!REPLY_SECRET) {
    console.warn("⚠ REPLY_SECRET не задан — /reply открыт без авторизации. Для беты задайте секрет в .env и заголовок X-Backend-Token в сценарии Voximplant.");
  }
});

// Грейсфул-шатдаун: до-оформить заявки активных звонков (с дедлайном) и выйти —
// иначе перезапуск бэкенда терял лиды всех незакрытых звонков.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${sig}: останавливаюсь, дренирую ${store.size} активных диалогов…`);
  server.close();
  // 45с > худшего бюджета доставки (extractOrder 2×15с + повтор Telegram 2×10с) — иначе
  // дедлайн убивал доставку раньше, чем лид успевал упасть в leads.ndjson.
  await Promise.race([store.drain(), new Promise((r) => setTimeout(r, 45_000))]);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
