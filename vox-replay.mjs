// Локальная проверка M2 без телефонии: «фейковый Voximplant».
// Подключается к stream-server по WS, шлёт start + захваченные с реального звонка
// media-кадры (JSON+base64), и логирует, что сервер присылает обратно (аудио Евы).
// Запуск: node vox-replay.mjs /tmp/vox-frames.ndjson
import { readFileSync } from "fs";
import WebSocket from "ws";

const file = process.argv[2] || "/tmp/vox-frames.ndjson";
const frames = readFileSync(file, "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((o) => o.event === "media" && o.media?.payload); // только реальные media-кадры

console.log(`Загружено ${frames.length} media-кадров из ${file}`);

const ws = new WebSocket("ws://localhost:3001/media");
let outMedia = 0, outBytes = 0, firstOutSize = null;

ws.on("open", () => {
  // Стартовый кадр в формате Voximplant.
  ws.send(JSON.stringify({ event: "start", start: { mediaFormat: { encoding: "PCM16", sampleRate: 8000 } } }));
  // Шлём захваченные кадры в ~2x темпе (10мс) — тот же объём аудио, быстрее по времени.
  let i = 0;
  const timer = setInterval(() => {
    if (i >= frames.length) {
      clearInterval(timer);
      // дать серверу время на финал STT + ответ, затем закрыть
      setTimeout(() => ws.close(), 8000);
      return;
    }
    ws.send(JSON.stringify(frames[i++]));
  }, 10);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) return;
  try {
    const o = JSON.parse(data.toString());
    if (o.event === "media" && o.media?.payload) {
      outMedia++;
      const b = Buffer.from(o.media.payload, "base64");
      outBytes += b.length;
      if (firstOutSize === null) firstOutSize = b.length;
    }
  } catch {}
});

ws.on("close", () => {
  console.log(`Сервер прислал обратно: ${outMedia} media-кадров, ${outBytes} байт PCM (первый кадр ${firstOutSize} байт)`);
  console.log(`= ${(outBytes / 2 / 8000).toFixed(1)} сек аудио Евы @ 8кГц`);
  process.exit(0);
});
ws.on("error", (e) => { console.error("replay ws ошибка:", e.message); process.exit(1); });
