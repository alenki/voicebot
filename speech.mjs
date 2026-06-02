const API_KEY = process.env.YANDEX_API_KEY;
const FOLDER_ID = process.env.YANDEX_FOLDER_ID;

// Синтез речи: текст -> аудио (Buffer, формат oggopus)
export async function synthesize(text, voice = "alena") {
  const body = new URLSearchParams({
    text, lang: "ru-RU", voice, emotion: "good", speed: "1.0",
    format: "oggopus", folderId: FOLDER_ID,
  });
  const res = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}` },
    body,
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Синтез в сыром PCM (LINEAR16) для стриминга обратно в Voximplant без перекодирования.
// Yandex TTS v1 поддерживает format=lpcm с sampleRateHertz 8000/16000/48000.
export async function synthesizePcm(text, sampleRateHertz = 8000, voice = "alena") {
  const body = new URLSearchParams({
    text, lang: "ru-RU", voice, emotion: "good", speed: "1.0",
    format: "lpcm", sampleRateHertz: String(sampleRateHertz), folderId: FOLDER_ID,
  });
  const res = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}` },
    body,
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
      completionOptions: { stream: true, temperature: 0.3, maxTokens: 160 },
      messages,
    }),
    signal,
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

// Мозг: история сообщений -> ответ модели (текст)
export async function ask(messages, model = "yandexgpt-lite") {
  const res = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${API_KEY}`,
      "Content-Type": "application/json",
      "x-folder-id": FOLDER_ID,
    },
    body: JSON.stringify({
      modelUri: `gpt://${FOLDER_ID}/${model}/latest`,
      completionOptions: { stream: false, temperature: 0.3, maxTokens: 160 },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.result.alternatives[0].message.text;
}