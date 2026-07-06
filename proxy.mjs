// Локальный роутер для одного ngrok-туннеля (на бесплатном плане только один
// публичный домен): /media (WebSocket стриминга) → :3001, всё остальное
// (/reply, /end, /health) → :3000. ngrok направляется на :3100.
import http from "node:http";
import net from "node:net";

const BACKEND_PORT = Number(process.env.PROXY_BACKEND_PORT || 3000);
const STREAM_PORT = Number(process.env.PROXY_STREAM_PORT || 3001);
const PORT = Number(process.env.PROXY_PORT || 3100);

const targetFor = (url) => (url.startsWith("/media") ? STREAM_PORT : BACKEND_PORT);

const server = http.createServer((req, res) => {
  const upstream = http.request(
    { host: "127.0.0.1", port: targetFor(req.url), path: req.url, method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

// WebSocket upgrade: пробрасываем рукопожатие и дальше гоняем байты в обе стороны.
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(targetFor(req.url), "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(raw + "\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, () => {
  console.log(`Прокси-роутер слушает :${PORT} — /media → :${STREAM_PORT}, остальное → :${BACKEND_PORT}`);
});
