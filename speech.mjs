const API_KEY = process.env.YANDEX_API_KEY;
const FOLDER_ID = process.env.YANDEX_FOLDER_ID;

// Таймауты на сетевые вызовы Yandex: без них зависший fetch держит звонок вечно (Ева
// умолкает посреди фразы, barge-in и speaker.drain() блокируются). Комбинируем таймаут с
// сигналом вызывающего — barge-in отменяет askStream через свой signal, он должен работать.
export function withTimeout(ms, signal) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Бюджеты времени на вызовы (мс). Реплики короткие (maxTokens 300 + BREVITY), так что
// потоковый ответ укладывается в секунды; таймаут ловит зависание, а не штатную речь.
// Можно переопределить через .env, дефолты безопасны для 8кГц-телефона.
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS) || 8000;
const STT_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS) || 10000;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 15000;
const LLM_STREAM_TIMEOUT_MS = Number(process.env.LLM_STREAM_TIMEOUT_MS) || 20000;

// Голос и просодия Евы. Подтверждено по докам SpeechKit v1/v3 (yandex-cloud/docs):
// alena — нейронный голос, у него РОВНО две роли: neutral (по умолчанию) и good
// («доброжелательная»). evil у alena нет — отдаст ошибку. good = тёплый тон под продажи.
const VOICE = "alena";
const EMOTION = "good"; // допустимо только neutral|good для alena
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
  const res = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}` },
    body,
    signal: withTimeout(TTS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Синтез в сыром PCM (LINEAR16) для стриминга обратно в Voximplant без перекодирования.
// Yandex TTS v1 поддерживает format=lpcm с sampleRateHertz 8000/16000/48000.
export async function synthesizePcm(text, sampleRateHertz = 8000, voice = VOICE) {
  const body = new URLSearchParams({
    text, lang: "ru-RU", voice, emotion: EMOTION, speed: SPEED,
    format: "lpcm", sampleRateHertz: String(sampleRateHertz), folderId: FOLDER_ID,
  });
  const res = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}` },
    body,
    signal: withTimeout(TTS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Распознавание: аудио (Buffer) -> текст
export async function recognize(audio) {
  const url = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize"
    + `?topic=general&lang=ru-RU&format=oggopus&folderId=${FOLDER_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}` },
    body: audio,
    signal: withTimeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.result;
}

// Потоковый мозг: вызывает onChunk(cumulativeText) по мере генерации (YandexGPT отдаёт
// НАКОПЛЕННЫЙ текст в каждом фрейме, не дельты). Возвращает полный текст. Это позволяет
// синтезировать первое предложение, пока модель ещё дописывает остальное (меньше задержки).
export async function askStream(messages, onChunk, { model = "yandexgpt-lite", signal } = {}) {
  const res = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${API_KEY}`,
      "Content-Type": "application/json",
      "x-folder-id": FOLDER_ID,
    },
    body: JSON.stringify({
      modelUri: `gpt://${FOLDER_ID}/${model}/latest`,
      completionOptions: { stream: true, temperature: 0.3, maxTokens: 300 },
      messages,
    }),
    signal: withTimeout(LLM_STREAM_TIMEOUT_MS, signal),
  });
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
// Опции: model (по умолчанию yandexgpt-lite), maxTokens (300 — чтобы длинное подтверждение
// заявки не обрывалось), temperature.
export async function ask(messages, { model = "yandexgpt-lite", maxTokens = 300, temperature = 0.3 } = {}) {
  const res = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
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
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  return pickReplyText(await res.json());
}