import { fetch as httpFetch, Agent } from "undici";
import { synthesizePcmEleven, assertElevenConfigured } from "./tts-elevenlabs.mjs";

const API_KEY = process.env.YANDEX_API_KEY;
const FOLDER_ID = process.env.YANDEX_FOLDER_ID;

// Провайдер TTS для стримингового пути (synthesizePcm). yandex — дефолт (marina);
// elevenlabs — голос Victoria по ELEVENLABS_VOICE_ID (нужен платный тариф 11labs, см.
// tts-elevenlabs.mjs). STT и synthesize() (oggopus для test.mjs) всегда остаются Yandex.
// Валидируем на импорте: опечатка в значении не должна молча откатывать на Yandex.
const TTS_PROVIDER = (process.env.TTS_PROVIDER || "yandex").toLowerCase();
if (!["yandex", "elevenlabs"].includes(TTS_PROVIDER)) {
  throw new Error(`Неизвестный TTS_PROVIDER="${TTS_PROVIDER}" — допустимо yandex | elevenlabs`);
}
if (TTS_PROVIDER === "elevenlabs") assertElevenConfigured();

// Keep-alive к Yandex: дефолтный undici-агент закрывает простаивающее соединение через
// ~4с — меньше паузы между ходами диалога, поэтому почти каждый ход заново платил
// TCP+TLS-рукопожатие (~60-250мс) к llm/tts. Держим соединения 60с. Импортируем fetch
// из npm-undici (а не глобальный): агент и fetch из одной сборки, без version-skew.
const keepAlive = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });
let dispatcher = keepAlive;
// Тестовый/проксирующий шов: подменить диспетчер (MockAgent в тестах), null — вернуть боевой.
export function setHttpDispatcher(d) { dispatcher = d ?? keepAlive; }

// Таймауты на сетевые вызовы Yandex: без них зависший fetch держит звонок вечно (Ева
// умолкает посреди фразы, barge-in и speaker.drain() блокируются). Комбинируем таймаут с
// сигналом вызывающего — barge-in отменяет askStream через свой signal, он должен работать.
export function withTimeout(ms, signal) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Бюджеты времени на вызовы (мс). Реплики короткие (maxTokens 120 + BREVITY), так что
// потоковый ответ укладывается в секунды; таймаут ловит зависание, а не штатную речь.
// Можно переопределить через .env, дефолты безопасны для 8кГц-телефона.
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS) || 8000;
const STT_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS) || 10000;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 15000;
const LLM_STREAM_TIMEOUT_MS = Number(process.env.LLM_STREAM_TIMEOUT_MS) || 20000;

// Числовой env-параметр с дефолтом (НЕ `Number(env) || dflt` — оно ломало явный "0").
const envNum = (name, dflt) => {
  const raw = process.env[name];
  const v = Number(raw);
  return raw != null && raw !== "" && Number.isFinite(v) ? v : dflt;
};

// Потолок генерации диалоговой реплики. Штатный ответ Евы — 1-2 фразы (~20-60 токенов);
// 300 было нужно только «понесло»-ответам, которые reply-clean потом всё равно режет, а
// turn-based путь ждал их генерацию целиком (~3-6с лишних). 120 покрывает самое длинное
// зачитывание заявки с запасом; extractOrder задаёт свой maxTokens явно (400).
const MAX_TOKENS = envNum("LLM_MAX_TOKENS", 120);

// Мозг диалога. По умолчанию aliceai-llm-flash — самый быстрый TTFT из каталога
// (~510-570мс тёплый; замер 2026-07-05 bench-llm-openai.mjs и повторно через нашу же
// askStream — 553мс) при качестве семейства Алисы: eva-eval 2026-07-05 прошёл чисто
// (телефонный гейт с ранним захватом номера, освобождение после двух отказов, зачитка
// номера по цифрам, дефлекция «вы робот?», без утечек цены/срока). Доступен ТОЛЬКО через
// OpenAI-совместимый API (ветка askStreamOpenai/askOpenai ниже). Откаты по нарастающей:
// LLM_MODEL=aliceai-llm (флагман, ~610-770мс TTFT, нативный API) → LLM_MODEL=yandexgpt
// (прежний прод). Историю про lite см. ниже: lite ломал персону (имя по буквам, двойные
// вопросы, прощание без телефона), половина reply-clean.mjs — заплатки на его слабости;
// не возвращаться на lite.
const DIALOG_MODEL = process.env.LLM_MODEL || "aliceai-llm-flash";
// Температура диалога. 0.3 напрямую воевала с требованием промпта «каждый раз варьируй
// формулировки»: от звонка к звонку первый ответ на «мне нужны визитки» выходил почти
// дословно одинаковым — владелец, тестирующий бота повторными звонками, слышал «скрипт».
// 0.4 — умеренная вариативность без потери управляемости; extractOrder задаёт свой 0 явно.
const TEMPERATURE = envNum("LLM_TEMPERATURE", 0.4);

// Голос и просодия Евы. marina — премиум-голос новее alena, дефолтный голос самого
// Яндекса с апреля 2024 (v1 и v3). Единственный из новой линейки (dasha/julia/lera/
// masha — v3-only, v1 отдаёт «Unsupported voice»), который работает через наш v1 REST.
// Роли marina: neutral (по умолчанию) | whisper | friendly. Проверено вживую на v1
// (voice-compare.mjs, 2026-07-05): все три роли синтезируются, аудио разное. good у
// marina НЕТ — отдаст ошибку. Откат: VOICE="alena" + EMOTION="good".
const VOICE = "marina";
const EMOTION = "friendly"; // допустимо только neutral|whisper|friendly для marina
// Темп: диапазон 0.1–3.0, 1.0 = средняя человеческая речь. Чуть ниже единицы (0.95)
// звучит спокойнее и теплее на узкополосном 8кГц-телефоне, не скатываясь в «вялость»
// (≤0.85 уже звучит снисходительно для уверенного «закрывающего»). Это настройка НА СЛУХ:
// подтверждать реальным звонком; безопасный откат — "1.0". Числа/цены лучше замедлять
// локально отдельной репликой, а не глобально.
const SPEED = "0.95";
// ВАЖНО: т.к. обе функции шлют поле `text` (а не `ssml`), доступна текстовая TTS-разметка
// v1 БЕЗ изменений API: пауза `sil<[мс]>` (макс 7000), ударение `+` перед гласной для
// омографов (за́мок/замо́к), контекст-пауза `<[medium]>`, акцент `**слово**`. Паузы в самом
// начале/конце фразы игнорируются, и «только разметка» не синтезируется. SSML <break> здесь
// НЕ работает — он только в режиме `ssml` (тогда текстовая разметка отключается).

// Синтез речи: текст -> аудио (Buffer, формат oggopus)
export async function synthesize(text, voice = VOICE) {
  const body = new URLSearchParams({
    text, lang: "ru-RU", voice, emotion: EMOTION, speed: SPEED,
    format: "oggopus", folderId: FOLDER_ID,
  });
  const res = await httpFetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}` },
    body,
    signal: withTimeout(TTS_TIMEOUT_MS),
    dispatcher,
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Синтез в сыром PCM (LINEAR16) для стриминга обратно в Voximplant без перекодирования.
// Yandex TTS v1 поддерживает format=lpcm с sampleRateHertz 8000/16000/48000.
// При TTS_PROVIDER=elevenlabs уходит в 11labs (Victoria) — формат на выходе тот же
// (сырой s16le той же частоты), остальной конвейер не замечает разницы.
// onChunk: потоковый режим — PCM отдаётся чанками по мере скачивания тела ответа
// (у ElevenLabs генерация тоже потоковая — первый чанк ~280мс; v1 Yandex отдаёт тело
// одним куском, но и там чанки уходят раньше конца скачивания). Возврат — полный буфер.
export async function synthesizePcm(text, sampleRateHertz = 8000, { onChunk = null, voice = VOICE } = {}) {
  if (TTS_PROVIDER === "elevenlabs") return synthesizePcmEleven(text, sampleRateHertz, { onChunk });
  const body = new URLSearchParams({
    text, lang: "ru-RU", voice, emotion: EMOTION, speed: SPEED,
    format: "lpcm", sampleRateHertz: String(sampleRateHertz), folderId: FOLDER_ID,
  });
  const res = await httpFetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}` },
    body,
    signal: withTimeout(TTS_TIMEOUT_MS),
    dispatcher,
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  if (!onChunk || !res.body) return Buffer.from(await res.arrayBuffer());
  const parts = [];
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    parts.push(buf);
    onChunk(buf);
  }
  return Buffer.concat(parts);
}

// Распознавание: аудио (Buffer) -> текст
export async function recognize(audio) {
  const url = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize"
    + `?topic=general&lang=ru-RU&format=oggopus&folderId=${FOLDER_ID}`;
  const res = await httpFetch(url, {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}` },
    body: audio,
    signal: withTimeout(STT_TIMEOUT_MS),
    dispatcher,
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.result;
}

// Транзиентная сетевая ошибка (ECONNRESET, обрыв TLS до ответа) — не HTTP-ошибка и не
// отмена. Бэкенд aliceai сбрасывает ~5% соединений (замерено 2026-07-05, воспроизводится
// и на свежих соединениях без keep-alive), у yandexgpt тоже случалось. Без повтора это
// мёртвый ход диалога: 500 наружу и дежурная фраза-заглушка вместо ответа.
const isTransientNetError = (e) =>
  e?.name !== "AbortError" &&
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket|other side closed/i
    .test(String(e?.cause?.message || e?.message || e));

// Один мгновенный повтор запроса при транзиентной сетевой ошибке. Безопасно только пока
// ответ не начали потреблять (completion идемпотентен, наружу ничего не ушло); таймауты и
// отмена звонящего приходят AbortError-ом и НЕ повторяются.
async function retryOnce(attempt) {
  try {
    return await attempt();
  } catch (e) {
    if (!isTransientNetError(e)) throw e;
    return attempt();
  }
}

// ── OpenAI-совместимый API Yandex AI Studio ────────────────────────────────────────────
// aliceai-llm-flash (самый быстрый TTFT из каталога: ~510-570мс на бенче 2026-07-05,
// bench-llm-openai.mjs) доступен ТОЛЬКО через https://llm.api.cloud.yandex.net/v1 (SSE),
// нативный foundationModels/v1/completion его не знает. Модели этого списка автоматически
// уходят в OpenAI-ветку; LLM_API=openai гонит туда ЛЮБУЮ модель (aliceai-llm и yandexgpt
// живут на обоих endpoint-ах).
const OPENAI_ONLY_MODELS = new Set(["aliceai-llm-flash", "deepseek-v4-flash", "qwen3.6-35b-a3b"]);
const useOpenaiApi = (model) => OPENAI_ONLY_MODELS.has(model) || process.env.LLM_API === "openai";
// Наш внутренний формат сообщений — яндексовский {role, text}; OpenAI ждёт {role, content}.
const toOpenaiMessages = (messages) => messages.map((m) => ({ role: m.role, content: m.text }));

// Разбор SSE-потока chat/completions: дельты копятся в полный текст, onChunk получает
// НАКОПЛЕННЫЙ текст (тот же контракт, что у нативного askStream).
async function readSseStream(res, onChunk) {
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  const takeLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
      if (delta) { full += delta; onChunk(full); }
    } catch { /* неполный JSON между чанками — пропускаем */ }
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      takeLine(line);
    }
  }
  // Хвост без завершающего \n (обрыв потока на последнем событии) — не теряем дельту.
  buf += decoder.decode();
  if (buf.trim()) takeLine(buf.trim());
  return full;
}

// Документированный базовый URL OpenAI-совместимого API (2026) — ai.api.cloud.yandex.net;
// легаси llm.api.cloud.yandex.net/v1 ещё жив, но в доках остался только для нативного API.
// Модель БЕЗ /latest: для alice-моделей версионные URI в доках не значатся.
// max_completion_tokens: max_tokens в схеме помечен deprecated.
const OPENAI_URL = "https://ai.api.cloud.yandex.net/v1/chat/completions";
const openaiBody = (messages, { model, maxTokens, temperature, stream }) => JSON.stringify({
  model: `gpt://${FOLDER_ID}/${model}`,
  stream, temperature, max_completion_tokens: maxTokens,
  messages: toOpenaiMessages(messages),
});

async function askStreamOpenai(messages, onChunk, { model, maxTokens, temperature, signal }) {
  const res = await retryOnce(() => httpFetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}`, "Content-Type": "application/json" },
    body: openaiBody(messages, { model, maxTokens, temperature, stream: true }),
    signal: withTimeout(LLM_STREAM_TIMEOUT_MS, signal),
    dispatcher,
  }));
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  return readSseStream(res, onChunk);
}

async function askOpenai(messages, { model, maxTokens, temperature }) {
  return retryOnce(async () => {
    const res = await httpFetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Api-Key ${API_KEY}`, "Content-Type": "application/json" },
      body: openaiBody(messages, { model, maxTokens, temperature, stream: false }),
      signal: withTimeout(LLM_TIMEOUT_MS),
      dispatcher,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const t = (await res.json())?.choices?.[0]?.message?.content;
    return typeof t === "string" ? t : "";
  });
}

// Потоковый мозг: вызывает onChunk(cumulativeText) по мере генерации (YandexGPT отдаёт
// НАКОПЛЕННЫЙ текст в каждом фрейме, не дельты). Возвращает полный текст. Это позволяет
// синтезировать первое предложение, пока модель ещё дописывает остальное (меньше задержки).
export async function askStream(messages, onChunk, { model = DIALOG_MODEL, maxTokens = MAX_TOKENS, temperature = TEMPERATURE, signal } = {}) {
  if (useOpenaiApi(model)) return askStreamOpenai(messages, onChunk, { model, maxTokens, temperature, signal });
  // Повтор — только вокруг установления запроса; обрыв ПОСЛЕ первых чанков не повторяем
  // (иначе Ева начнёт фразу заново поверх уже озвученного). Свежий таймаут на каждую попытку.
  const res = await retryOnce(() => httpFetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${API_KEY}`,
      "Content-Type": "application/json",
      "x-folder-id": FOLDER_ID,
    },
    body: JSON.stringify({
      modelUri: `gpt://${FOLDER_ID}/${model}/latest`,
      completionOptions: { stream: true, temperature, maxTokens },
      messages,
    }),
    signal: withTimeout(LLM_STREAM_TIMEOUT_MS, signal),
    dispatcher,
  }));
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const text = JSON.parse(line).result?.alternatives?.[0]?.message?.text;
        if (typeof text === "string") { full = text; onChunk(full); }
      } catch { /* неполный JSON между чанками — пропускаем */ }
    }
  }
  return full;
}

// Достаём текст ответа модели из тела ответа YandexGPT, не падая на нештатных формах
// (content-filter, тело ошибки, пустые alternatives). Чистая функция — юнит-тестируется.
export function pickReplyText(data) {
  const t = data?.result?.alternatives?.[0]?.message?.text;
  return typeof t === "string" ? t : "";
}

// Мозг: история сообщений -> ответ модели (текст).
// Опции: model (по умолчанию DIALOG_MODEL — aliceai-llm), maxTokens, temperature.
export async function ask(messages, { model = DIALOG_MODEL, maxTokens = MAX_TOKENS, temperature = TEMPERATURE } = {}) {
  if (useOpenaiApi(model)) return askOpenai(messages, { model, maxTokens, temperature });
  // Не-потоковый запрос идемпотентен целиком: повтор покрывает и обрыв при скачивании тела.
  return retryOnce(async () => {
    const res = await httpFetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${API_KEY}`,
        "Content-Type": "application/json",
        "x-folder-id": FOLDER_ID,
      },
      body: JSON.stringify({
        modelUri: `gpt://${FOLDER_ID}/${model}/latest`,
        completionOptions: { stream: false, temperature, maxTokens },
        messages,
      }),
      signal: withTimeout(LLM_TIMEOUT_MS),
      dispatcher,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    return pickReplyText(await res.json());
  });
}