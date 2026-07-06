// Одноразовая проверка: WS-подключение к /media через публичный URL ngrok.
import WebSocket from "ws";

const url = process.argv[2] || "ws://localhost:3100/media";
const ws = new WebSocket(url, { headers: { "ngrok-skip-browser-warning": "1" } });
const timer = setTimeout(() => {
  console.error("WS TIMEOUT");
  process.exit(1);
}, 10000);
ws.on("open", () => {
  console.log("WS OPEN:", url);
  clearTimeout(timer);
  ws.close();
  process.exit(0);
});
ws.on("error", (e) => {
  console.error("WS ERROR:", e.message);
  process.exit(1);
});
