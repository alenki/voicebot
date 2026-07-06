// Синтетический «звонящий»: полный прогон стримингового сервера без телефонии.
// Синтезирует реплики клиента Yandex TTS (PCM16 8кГц), шлёт их в live stream-server
// кадрами по 20мс в реальном темпе, затем тишину, и меряет «конец речи клиента →
// первый media-кадр ответа Евы» (voice-to-voice без телефонных хопов). Использует
// НАСТОЯЩИЕ Yandex STT/LLM/TTS — это платный e2e-прогон, не юнит-тест.
// Запуск: (1) TTS_PROVIDER=yandex node --env-file=.env stream-server.mjs
//         (2) node --env-file=.env call-sim.mjs
// Замер 2026-07-05 (тёплый сервер): 767-1227мс voice-to-voice со спекуляцией.
import WebSocket from "ws";
import { synthesizePcm } from "./speech.mjs";

const PHRASES = [
  "Здравствуйте, мне нужны визитки",
  "Штук пятьсот, для автосервиса",
];

const callerPcm = [];
for (const p of PHRASES) callerPcm.push(await synthesizePcm(p, 8000));
console.log(`каллер синтезирован: ${callerPcm.map((b) => (b.length / 16000).toFixed(1) + "с").join(", ")}`);

const ws = new WebSocket("ws://localhost:3001/media");
const FRAME = 320; // 20мс @ 8кГц PCM16
let seq = 0, chunk = 0, tsamp = 0;
const mkFrame = (buf) => JSON.stringify({
  event: "media", sequenceNumber: ++seq,
  media: { timestamp: (tsamp += 160) && tsamp, chunk: chunk++, payload: buf.toString("base64") },
});

let phase = "greeting";     // greeting → speak(i) → wait(i)
let phraseIdx = 0;
let speechEndAt = 0;
let firstReplyAt = 0;
let greetingDoneAt = 0;
let lastEvaMediaAt = 0;
const results = [];

ws.on("open", () => {
  ws.send(JSON.stringify({ event: "start", start: { mediaFormat: { encoding: "PCM16", sampleRate: 8000 } } }));
  let offset = 0;
  const silence = Buffer.alloc(FRAME);
  const timer = setInterval(() => {
    const now = Date.now();
    if (phase === "greeting") {
      // ждём, пока приветствие Евы отзвучит (нет её кадров 700мс после хотя бы одного)
      ws.send(mkFrame(silence));
      if (lastEvaMediaAt && now - lastEvaMediaAt > 700) {
        greetingDoneAt = now;
        phase = "speak";
        console.log("приветствие отыграло — говорит клиент…");
      }
      return;
    }
    if (phase === "speak") {
      const pcm = callerPcm[phraseIdx];
      ws.send(mkFrame(pcm.subarray(offset, offset + FRAME)));
      offset += FRAME;
      if (offset >= pcm.length) {
        offset = 0;
        speechEndAt = now;
        firstReplyAt = 0;
        phase = "wait";
        console.log(`фраза ${phraseIdx + 1} произнесена, ждём ответ…`);
      }
      return;
    }
    // wait: тишина; ответ Евы регистрирует firstReplyAt; конец ответа — 700мс без её кадров
    ws.send(mkFrame(silence));
    if (firstReplyAt && now - lastEvaMediaAt > 700) {
      phraseIdx++;
      if (phraseIdx >= callerPcm.length) {
        clearInterval(timer);
        setTimeout(() => ws.close(), 500);
        return;
      }
      phase = "speak";
      console.log("ответ отыграл — следующая фраза клиента…");
    }
    if (!firstReplyAt && now - speechEndAt > 15000) { // защита от вечного ожидания
      clearInterval(timer);
      console.log("ответа не было 15с — закрываю");
      ws.close();
    }
  }, 20);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) return;
  try {
    const o = JSON.parse(data.toString());
    if (o.event === "media" && o.media?.payload) {
      const now = Date.now();
      lastEvaMediaAt = now;
      if (phase === "wait" && !firstReplyAt && speechEndAt) {
        firstReplyAt = now;
        const ms = now - speechEndAt;
        results.push(ms);
        console.log(`⏱ фраза ${phraseIdx + 1}: конец речи клиента → первый кадр Евы = ${ms}мс`);
      }
    }
  } catch {}
});

ws.on("close", () => {
  console.log(`\nИтог voice-to-voice: ${results.map((m) => m + "мс").join(", ") || "нет ответов"}`);
  process.exit(0);
});
ws.on("error", (e) => { console.error("ws ошибка:", e.message); process.exit(1); });
