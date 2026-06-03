// node --test playback.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { PacedPlayer } from "./playback.mjs";

test("emits fixed-size frames in order, then drains", async () => {
  const sent = [];
  const p = new PacedPlayer((f) => sent.push(f.length), { sampleRate: 8000, frameMs: 20 });
  p.enqueue(Buffer.alloc(320 * 3)); // ровно 3 фрейма по 320 байт (20мс@8к)
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(sent, [320, 320, 320]);
});

test("stop() halts emission and clears the queue", async () => {
  const sent = [];
  const p = new PacedPlayer((f) => sent.push(f.length), { sampleRate: 8000, frameMs: 20 });
  p.enqueue(Buffer.alloc(320 * 100));
  await new Promise((r) => setTimeout(r, 50)); // отдать пару фреймов
  p.stop();
  const count = sent.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(sent.length, count); // после stop ничего нового
});

// РЕГРЕССИЯ (причина «лагающего голоса»): плеер ОБЯЗАН отдавать аудио в реальном времени —
// 100 кадров по 20мс = 2.0с звука должны уйти примерно за 2.0с. Наивный setInterval(20)
// «один кадр за тик» отдавал ~37 кадров/с (тик ≈26мс на Windows), т.е. 2с звука растягивались
// на ~2.7с — дальний буфер Voximplant голодал, голос рвался («как плохой интернет»). Пейсер
// должен держать темп по дедлайнам, а не по частоте тиков.
test("delivers audio at ~real-time even when the event loop is busy", async () => {
  const sent = [];
  const p = new PacedPlayer((f) => sent.push(f.length), { sampleRate: 8000, frameMs: 20 });
  const FRAMES = 100; // 2.0 с звука
  const t0 = Date.now();

  // Нагружаем event loop, как на живом звонке (STT/TTS/WS: JSON+base64 50/с): блок 8мс каждые 30мс.
  const blocker = setInterval(() => { const end = Date.now() + 8; while (Date.now() < end) {} }, 30);

  p.enqueue(Buffer.alloc(320 * FRAMES));
  await new Promise((resolve) => { p.onIdle = resolve; });
  clearInterval(blocker);

  const took = Date.now() - t0;
  assert.strictEqual(sent.length, FRAMES, "должны уйти все кадры");
  // Реальное время = 2000мс. Допуск +20% на джиттер таймера; наивный пейсер давал ~2700мс (FAIL).
  assert.ok(took <= 2400, `2с звука должны уйти за ~2с, а ушли за ${took}мс (пейсер отстаёт → рвань)`);
  // И не «вывалить всё сразу» — иначе дальний буфер не оборвать на barge-in. Не быстрее ~1.7с.
  assert.ok(took >= 1700, `аудио ушло слишком быстро (${took}мс) — нет пейсинга, barge-in не оборвёт`);
});
