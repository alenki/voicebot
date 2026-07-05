// ElevenLabs TTS для стримингового пути: та же роль, что synthesizePcm у Yandex —
// текст -> сырой PCM s16le (без WAV-заголовка), частота задаётся вызывающим (8000 для
// телефонии). Включается через TTS_PROVIDER=elevenlabs в .env (диспетчер в speech.mjs).
// ТРЕБУЕТ платный тариф ElevenLabs: голоса из Voice Library по API на free отдают 402.
import { fetch as httpFetch, Agent } from "undici";

// trim: пробельное значение в .env («ELEVENLABS_VOICE_ID= ») — это «не задано»,
// иначе пробел уезжает в URL и превращается в 404 посреди звонка вместо ошибки на старте.
const KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "").trim();
// flash — единственная линейка с задержкой под живой звонок (~0.3с до первого чанка);
// multilingual_v2 звучит чуть богаче, но 1.2-1.5с до аудио — для телефона это дыра.
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS) || 8000;

// Свой keep-alive агент (не из speech.mjs — там шов подменяет Yandex-диспетчер в тестах,
// и эти подмены не должны цеплять ElevenLabs).
const keepAlive = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });
const realFetch = (url, opts) => httpFetch(url, { ...opts, dispatcher: keepAlive });
let doFetch = realFetch;
// Тестовый шов: подменить fetch (null — вернуть боевой).
export function setElevenFetch(f) { doFetch = f ?? realFetch; }

// Валидация конфига на старте сервера (fail fast, а не 401 посреди звонка).
export function assertElevenConfigured() {
  if (!KEY) throw new Error("TTS_PROVIDER=elevenlabs, но нет ELEVENLABS_API_KEY в .env");
  if (!VOICE_ID) throw new Error("TTS_PROVIDER=elevenlabs, но нет ELEVENLABS_VOICE_ID в .env (Victoria: D5RRIJYa9pFwxiSpbGbR)");
}

export async function synthesizePcmEleven(text, sampleRateHertz = 8000) {
  const body = { text, model_id: MODEL };
  // language_code принимают только flash/turbo v2.5; multilingual_v2 на него отдаёт 400.
  if (/flash|turbo/.test(MODEL)) body.language_code = "ru";
  const res = await doFetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=pcm_${sampleRateHertz}`,
    {
      method: "POST",
      headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // Копим стрим целиком: speaker.mjs ждёт готовый буфер предложения. Предложения короткие
  // (chunkForTts режет до ~240 симв.), полный синтез у flash ~0.6-1.7с — терпимо; сквозной
  // прогон чанков в PacedPlayer — возможная оптимизация, если задержка станет заметной.
  return Buffer.from(await res.arrayBuffer());
}
