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
// optimize_streaming_latency: помечен deprecated в OpenAPI-спеке ElevenLabs, но
// принимается. 3 — максимум оптимизаций БЕЗ отключения нормализатора текста (уровень 4
// выключает нормализатор — бот, читающий цены и телефоны, начнёт их коверкать; нельзя).
// На flash-моделях может быть no-op — тогда просто игнорируется. Пустая строка — не слать.
const STREAM_LATENCY = (process.env.ELEVENLABS_STREAM_LATENCY ?? "3").trim();

// Числовой env-параметр с дефолтом (НЕ `Number(env) || dflt` — оно ломало явный "0").
const envNum = (name, dflt) => {
  const raw = process.env[name];
  const v = Number(raw);
  return raw != null && raw !== "" && Number.isFinite(v) ? v : dflt;
};
// Характер голоса. По живому звонку 2026-07-06 Victoria «из коробки» звучала слишком
// агрессивно и быстро — дефолт теперь медленнее и живее (вариант C из voice-sample-*.wav):
// speed 0.9 (диапазон 0.7–1.2), stability 0.3 (ниже = богаче интонации), style 0.4
// (экспрессия). Проверено на flash_v2_5 вживую: все поля принимаются, первый чанк не
// замедляется. ELEVENLABS_VOICE_SETTINGS=0 — не слать вовсе (голос как в пресете
// Voice Library, прежнее звучание).
const USE_VOICE_SETTINGS = envNum("ELEVENLABS_VOICE_SETTINGS", 1);
const VOICE_SETTINGS = {
  speed: envNum("ELEVENLABS_SPEED", 0.9),
  stability: envNum("ELEVENLABS_STABILITY", 0.3),
  similarity_boost: envNum("ELEVENLABS_SIMILARITY", 0.75),
  style: envNum("ELEVENLABS_STYLE", 0.4),
};

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

// onChunk: потоковый режим — PCM уходит вызывающему ЧАНКАМИ по мере генерации (первый
// у flash ~280мс), а не после полного синтеза предложения (~0.6-1.7с). Возвращается
// всё равно ПОЛНЫЙ буфер (для PCM-кэша). Без onChunk — прежнее поведение целым буфером.
export async function synthesizePcmEleven(text, sampleRateHertz = 8000, { onChunk = null } = {}) {
  const body = { text, model_id: MODEL };
  // language_code принимают только flash/turbo v2.5; multilingual_v2 на него отдаёт 400.
  if (/flash|turbo/.test(MODEL)) body.language_code = "ru";
  if (USE_VOICE_SETTINGS) body.voice_settings = VOICE_SETTINGS;
  const latencyParam = STREAM_LATENCY ? `optimize_streaming_latency=${STREAM_LATENCY}&` : "";
  const res = await doFetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?${latencyParam}output_format=pcm_${sampleRateHertz}`,
    {
      method: "POST",
      headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (!onChunk || !res.body) return Buffer.from(await res.arrayBuffer());
  const parts = [];
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    parts.push(buf);
    onChunk(buf);
  }
  return Buffer.concat(parts);
}
