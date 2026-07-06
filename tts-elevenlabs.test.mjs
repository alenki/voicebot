// Оффлайн-тесты ElevenLabs-провайдера: подменяем fetch швом, сеть не нужна.
import test from "node:test";
import assert from "node:assert/strict";

// Конфиг читается на импорте модуля — задаём env ДО динамического импорта.
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.ELEVENLABS_VOICE_ID = "test-voice";
const { synthesizePcmEleven, setElevenFetch, assertElevenConfigured } =
  await import("./tts-elevenlabs.mjs");

const okResponse = (buf) => ({
  ok: true,
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
});

test("synthesizePcmEleven: правильный URL, заголовки и тело запроса", async () => {
  let captured;
  setElevenFetch(async (url, opts) => { captured = { url, opts }; return okResponse(Buffer.from([1, 2])); });
  try {
    await synthesizePcmEleven("привет", 8000);
  } finally { setElevenFetch(null); }
  assert.equal(captured.url, "https://api.elevenlabs.io/v1/text-to-speech/test-voice/stream?optimize_streaming_latency=3&output_format=pcm_8000");
  assert.equal(captured.opts.headers["xi-api-key"], "test-key");
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.text, "привет");
  assert.equal(body.model_id, "eleven_flash_v2_5"); // дефолт
  assert.equal(body.language_code, "ru"); // flash поддерживает и требует явный ru
  // Характер голоса по умолчанию: медленнее и живее (живой фидбэк 2026-07-06).
  assert.deepEqual(body.voice_settings, { speed: 0.9, stability: 0.3, similarity_boost: 0.75, style: 0.4 });
  assert.ok(captured.opts.signal instanceof AbortSignal, "должен быть таймаут-сигнал");
});

test("synthesizePcmEleven: возвращает Buffer с PCM как есть", async () => {
  const pcm = Buffer.from([0, 1, 2, 3, 4, 5]);
  setElevenFetch(async () => okResponse(pcm));
  try {
    const out = await synthesizePcmEleven("тест", 8000);
    assert.ok(Buffer.isBuffer(out));
    assert.deepEqual(out, pcm);
  } finally { setElevenFetch(null); }
});

test("synthesizePcmEleven: частота дискретизации попадает в output_format", async () => {
  let url;
  setElevenFetch(async (u) => { url = u; return okResponse(Buffer.from([1])); });
  try { await synthesizePcmEleven("тест", 16000); } finally { setElevenFetch(null); }
  assert.match(url, /output_format=pcm_16000$/);
});

test("synthesizePcmEleven: не-ok ответ бросает ошибку со статусом и телом", async () => {
  setElevenFetch(async () => ({ ok: false, status: 402, text: async () => "paid_plan_required" }));
  try {
    await assert.rejects(
      () => synthesizePcmEleven("тест"),
      (e) => e.message.includes("402") && e.message.includes("paid_plan_required"),
    );
  } finally { setElevenFetch(null); }
});

test("assertElevenConfigured: с ключом и голосом не бросает", () => {
  assert.doesNotThrow(() => assertElevenConfigured());
});

// Потоковый режим: PCM уходит вызывающему чанками по мере скачивания тела ответа
// (первый чанк flash ~280мс — на него и завязано «Ева заговорила раньше»).
test("synthesizePcmEleven: onChunk получает чанки по мере прихода, возврат — полный буфер", async () => {
  const c1 = Buffer.from([1, 2]), c2 = Buffer.from([3, 4, 5]);
  setElevenFetch(async () => ({
    ok: true,
    body: (async function* () { yield c1; yield c2; })(),
  }));
  try {
    const chunks = [];
    const out = await synthesizePcmEleven("тест", 8000, { onChunk: (b) => chunks.push(Buffer.from(b)) });
    assert.deepEqual(chunks, [c1, c2]);
    assert.deepEqual(out, Buffer.concat([c1, c2]));
  } finally { setElevenFetch(null); }
});

test("synthesizePcmEleven: onChunk без body у ответа — фолбэк на целый буфер", async () => {
  const pcm = Buffer.from([9, 8, 7]);
  setElevenFetch(async () => okResponse(pcm));
  try {
    const chunks = [];
    const out = await synthesizePcmEleven("тест", 8000, { onChunk: (b) => chunks.push(b) });
    assert.deepEqual(out, pcm);
    assert.equal(chunks.length, 0, "без стрим-тела чанков нет — играется целиком");
  } finally { setElevenFetch(null); }
});
