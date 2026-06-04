// Хардненинг стримингового сервера для живой беты: авторизация WS-подключения, health-проба
// и грейсфул-дренаж сессий при остановке. Изолированные функции — юнит-тестируются без сети.

// Авторизация WS-подключения по общему секрету. Секрет НЕ задан → гейт выключен (пускаем
// всех; stream-server предупреждает об этом на старте). Задан → требуем ?token=<secret> в URL.
// Кривой/пустой URL при заданном секрете → отказ (а не падение).
export function isAuthorized(reqUrl, secret) {
  if (!secret) return true;
  let token = null;
  try {
    token = new URL(reqUrl, "http://x").searchParams.get("token");
  } catch {
    return false;
  }
  return token === secret;
}

// Ответ на health-пробу. Возвращает true, если запрос обработан (GET /health|/healthz) —
// тогда вызывающий ничего больше не пишет. Иначе false (пусть обработает основной роутер).
// Нужен, чтобы перед вставкой ngrok-URL в сценарий Voximplant убедиться, что бэкенд жив.
export function healthHandler(req, res) {
  const path = (req.url || "").split("?")[0];
  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return true;
  }
  return false;
}

// Грейсфул-шатдаун: дать каждой активной сессии до-оформить заявку (finalizeLead) перед
// выходом, чтобы при перезапуске/SIGTERM не потерять лид незакрытого звонка. Сбой одной
// сессии не мешает остальным. Возвращает число сессий, по которым прошлись.
export async function drainSessions(sessions) {
  const list = [...sessions];
  await Promise.allSettled(list.map((s) => s.finalizeLead?.()));
  return list.length;
}
