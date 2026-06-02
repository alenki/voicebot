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
