// Извлечение заявки из диалога звонка. Один пост-обработочный вызов YandexGPT по всей
// истории: модель просят вернуть СТРОГО JSON с полями заявки. Парсер устойчив к тому, что
// lite-модель оборачивает JSON в ```-ограждение или текст — иначе заявка терялась бы.
import { ask } from "./speech.mjs";

const FIELD_KEYS = ["item", "qty", "format", "material", "deadline", "name", "phone"];

function emptyFields() {
  return Object.fromEntries(FIELD_KEYS.map((k) => [k, ""]));
}

// Чистая функция: из сырого ответа модели достаём JSON-объект и нормализуем поля.
// Никогда не бросает — на мусоре возвращает { hasOrder:false, пустые поля }.
export function parseOrderJson(raw) {
  const text = typeof raw === "string" ? raw : "";
  const result = { hasOrder: false, fields: emptyFields(), raw: text };

  // Срезаем ```json … ``` ограждение, затем берём подстроку от первой { до последней }.
  const noFence = text.replace(/```(?:json)?/gi, "");
  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return result;

  let parsed;
  try {
    parsed = JSON.parse(noFence.slice(start, end + 1));
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== "object") return result;

  result.hasOrder = Boolean(parsed.hasOrder);
  for (const k of FIELD_KEYS) {
    const v = parsed[k];
    result.fields[k] = v === null || v === undefined ? "" : String(v).trim();
  }
  return result;
}

const EXTRACT_SYSTEM =
`Ты извлекаешь заявку клиента из расшифровки телефонного разговора с типографией.
Верни ТОЛЬКО JSON-объект, без пояснений и без markdown, со строго такими полями:
{"hasOrder": <true|false>, "item": "", "qty": "", "format": "", "material": "", "deadline": "", "name": "", "phone": ""}
Где: item — что изготовить; qty — тираж/количество; format — формат или размер; material — материал;
deadline — желаемый срок; name — имя клиента; phone — контактный телефон.
Заполняй только то, что прямо прозвучало в разговоре; неупомянутое оставляй пустой строкой.
hasOrder = true, только если клиент действительно оформлял заказ/заявку (а не просто спрашивал справку,
часы работы или цену). Телефон записывай цифрами как произнёс клиент.`;

// История = [{role, text}, ...] из stream-server. Прогоняем реплики клиента и Евы через
// извлекающий промпт. Полный yandexgpt (не -lite) и temperature 0 — стабильнее держит JSON.
export async function extractOrder(history) {
  const dialog = (history || [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "Клиент" : "Ева"}: ${m.text}`)
    .join("\n");
  if (!dialog.trim()) return parseOrderJson("");

  const messages = [
    { role: "system", text: EXTRACT_SYSTEM },
    { role: "user", text: `Расшифровка разговора:\n${dialog}\n\nВерни JSON заявки.` },
  ];
  const raw = await ask(messages, { model: "yandexgpt", maxTokens: 400, temperature: 0 });
  return parseOrderJson(raw);
}
