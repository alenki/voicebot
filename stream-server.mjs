// Стриминговый сервер (M0-проба). Логирует всё, что присылает Voximplant по WebSocket,
// чтобы выяснить точный формат медиапотока. Запуск: node --env-file=.env stream-server.mjs
import { WebSocketServer } from "ws";

const PORT = 3001;
const wss = new WebSocketServer({ port: PORT, path: "/media" });

wss.on("connection", (ws) => {
  console.log("[ws] звонок подключился");
  let frames = 0;
  let bytes = 0;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      frames++;
      bytes += data.length;
      if (frames <= 3 || frames % 50 === 0) {
        console.log(`[ws] бинарный фрейм #${frames}: ${data.length} байт (всего ${bytes})`);
      }
    } else {
      // Текстовые фреймы — обычно метаданные (sample rate, кодек). Печатаем целиком.
      console.log("[ws] текстовый фрейм:", data.toString());
    }
  });

  ws.on("close", () => console.log(`[ws] звонок отключился — бинарных фреймов: ${frames}, байт: ${bytes}`));
  ws.on("error", (e) => console.log("[ws] ошибка:", e.message));
});

console.log(`Стриминговый сервер (проба) слушает ws://localhost:${PORT}/media`);
