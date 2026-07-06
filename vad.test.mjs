// node --test vad.test.mjs
// Энергетический VAD: речь абонента в трубку vs фоновый шум. Кадры — синтетический PCM16LE
// заданной амплитуды: 20log10(a/32768) даёт предсказуемый уровень в dBFS.
import { test } from "node:test";
import assert from "node:assert";
import { EnergyVad, frameDb } from "./vad.mjs";

// Кадр 20мс @ 8кГц (160 сэмплов) постоянной амплитуды — RMS ровно равен амплитуде.
function frame(amplitude) {
  const buf = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) buf.writeInt16LE(amplitude, i * 2);
  return buf;
}

test("frameDb: тишина → -100, полная шкала → ~0 дБ", () => {
  assert.equal(frameDb(Buffer.alloc(320)), -100);
  assert.equal(frameDb(Buffer.alloc(0)), -100);
  const full = frameDb(frame(32767));
  assert.ok(Math.abs(full) < 0.1, `полная шкала ≈ 0 дБFS, получили ${full}`);
  const mid = frameDb(frame(3277)); // 32768/10 → -20 дБ
  assert.ok(Math.abs(mid + 20) < 0.1, `амплитуда 1/10 шкалы ≈ -20 дБFS, получили ${mid}`);
});

test("тишина и комфорт-шум — не речь, громкий голос — речь", () => {
  const vad = new EnergyVad();
  assert.equal(vad.frame(Buffer.alloc(320)).speech, false, "нулевой кадр — не речь");
  assert.equal(vad.frame(frame(40)).speech, false, "комфорт-шум (≈-58 дБ) — не речь");
  assert.equal(vad.frame(frame(8000)).speech, true, "голос в трубку (≈-12 дБ) — речь");
});

test("абсолютный минимум minDb: очень тихий звук — не речь даже над низким полом", () => {
  const vad = new EnergyVad(); // после долгой тишины пол опустится к -100
  for (let i = 0; i < 200; i++) vad.frame(Buffer.alloc(320));
  // ≈-56 дБ: сильно выше пола (-100), но тише minDb (-50) — фоновый шелест, не речь.
  assert.equal(vad.frame(frame(50)).speech, false);
});

test("пол дрейфует к уровню комфорт-шума линии, речь остаётся речью", () => {
  const vad = new EnergyVad();
  for (let i = 0; i < 300; i++) vad.frame(frame(100)); // шум ≈-50 дБ несколько секунд
  assert.ok(vad.floor > -55 && vad.floor < -45, `пол должен подтянуться к шуму, floor=${vad.floor}`);
  assert.equal(vad.frame(frame(8000)).speech, true, "голос по-прежнему громче пола+margin");
});

test("потолок пола: адаптация не может заглушить настоящую речь", () => {
  const vad = new EnergyVad();
  // Долгая громкая «речь» (полчаса болтовни фона): пол ползёт вверх, но упирается в floorMaxDb.
  for (let i = 0; i < 100_000; i++) vad.frame(frame(8000));
  assert.ok(vad.floor <= -45, `пол не выше floorMaxDb, floor=${vad.floor}`);
  assert.equal(vad.frame(frame(8000)).speech, true, "голос в трубку слышен всегда");
});

test("одиночный нулевой DTX-кадр не роняет пол мгновенно", () => {
  const vad = new EnergyVad();
  for (let i = 0; i < 300; i++) vad.frame(frame(100)); // пол у -50
  const before = vad.floor;
  vad.frame(Buffer.alloc(320)); // один кадр цифровой тишины
  assert.ok(vad.floor > before - 5, `пол падает плавно, а не к -100: ${before} → ${vad.floor}`);
});
