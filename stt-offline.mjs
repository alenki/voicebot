// M1: офлайн-проверка потокового STT без телефонии.
// Нужен сырой PCM (моно, 16-бит LE) на частоте из M0.
// Запуск: node --env-file=.env stt-offline.mjs sample.pcm 8000
import { readFileSync } from "fs";
import { openStt } from "./stt-stream.mjs";

const file = process.argv[2] || "sample.pcm";
const sampleRate = Number(process.argv[3] || 8000);
const pcm = readFileSync(file);

console.log(`Отправляю ${pcm.length} байт PCM @ ${sampleRate} Гц…`);

const stt = openStt({
  sampleRate,
  onPartial: (t) => console.log("…частично:", t),
  onFinal: (t) => console.log("ИТОГ:", t),
  onError: (e) => console.error("STT ошибка:", e.message || e),
});

// Шлём кусками по 20 мс, имитируя реальный темп речи (важно для потокового распознавания).
const frameBytes = sampleRate * 0.02 * 2; // 20мс * 16бит моно
let off = 0;
const timer = setInterval(() => {
  if (off >= pcm.length) {
    clearInterval(timer);
    setTimeout(() => stt.close(), 2000); // дать время на финальный результат
    return;
  }
  stt.write(pcm.subarray(off, off + frameBytes));
  off += frameBytes;
}, 20);
