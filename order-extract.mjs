// Извлечение заявки из диалога звонка. Один пост-обработочный вызов YandexGPT по всей
// истории: модель просят вернуть СТРОГО JSON с полями заявки. Парсер устойчив к тому, что
// модель оборачивает JSON в ```-ограждение или текст — иначе заявка терялась бы.
import { ask } from "./speech.mjs";

const FIELD_KEYS = ["item", "qty", "format", "material", "deadline", "name", "phone"];

function emptyFields() {
  return Object.fromEntries(FIELD_KEYS.map((k) => [k, ""]));
}

// Телефон в расшифровке часто продиктован словами («восемь девять два восемь…») — менеджеру
// нужен номер цифрами. Переводим ЕДИНИЧНЫЕ слова-цифры; если в тексте есть составные
// числительные («девятьсот девяносто», «сто двадцать три») — надёжно перевести нельзя,
// отдаём сырой текст: человек расшифрует, а «чистый», но НЕВЕРНЫЙ номер (потерянные
// разряды) выглядел бы достоверным и уводил менеджера на чужой телефон.
const WORD_DIGITS = {
  "ноль": "0", "один": "1", "два": "2", "три": "3", "четыре": "4",
  "пять": "5", "шесть": "6", "семь": "7", "восемь": "8", "девять": "9",
};
const COMPOSITE_NUM_RE =
  /(?<![а-яё])(десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто|двести|триста|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот|тысяч[а-яё]*)(?![а-яё])/iu;

export function normalizePhone(raw) {
  const original = String(raw ?? "").trim();
  const s = original.toLowerCase();
  if (COMPOSITE_NUM_RE.test(s)) return original;
  const replaced = s.replace(/(?<![а-яё])(ноль|один|два|три|четыре|пять|шесть|семь|восемь|девять)(?![а-яё])/g, (w) => WORD_DIGITS[w]);
  const plus = /^\+/.test(original) ? "+" : "";
  const digits = replaced.replace(/\D/g, "");
  return digits.length >= 7 ? plus + digits : original;
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

  // Строго true/"true": Boolean("false") === true, и строковый "false" от модели
  // превращался бы в пустую заявку-спам менеджеру.
  result.hasOrder = parsed.hasOrder === true || parsed.hasOrder === "true";
  for (const k of FIELD_KEYS) {
    const v = parsed[k];
    result.fields[k] = v === null || v === undefined ? "" : String(v).trim();
  }
  result.fields.phone = normalizePhone(result.fields.phone);
  return result;
}

const EXTRACT_SYSTEM =
`Ты извлекаешь заявку клиента из расшифровки телефонного разговора с типографией.
Верни ТОЛЬКО JSON-объект, без пояснений и без markdown, со строго такими полями:
{"hasOrder": <true|false>, "item": "", "qty": "", "format": "", "material": "", "deadline": "", "name": "", "phone": ""}
Где: item — что изготовить; qty — тираж/количество; format — формат или размер; material — материал;
deadline — желаемый срок; name — имя клиента; phone — контактный телефон.
Заполняй только то, что прямо прозвучало в разговоре; неупомянутое оставляй пустой строкой. Ничего не выдумывай.
hasOrder = true, только если клиент действительно оформлял заказ/заявку или оставил контакты для расчёта
(а не просто спрашивал справку, часы работы или цену и ушёл).
Телефон записывай ТОЛЬКО цифрами: продиктованное словами («восемь девять два восемь…») переведи в цифры.`;

// История = [{role, text}, ...]. Прогоняем реплики клиента и Евы через извлекающий промпт.
// Полный yandexgpt и temperature 0 — стабильнее держит JSON. Это ЕДИНСТВЕННЫЙ вызов, между
// звонком и Telegram-заявкой, поэтому один сетевой сбой ретраится — иначе лид терялся молча.
export async function extractOrder(history, { attempts = 2, retryDelayMs = 2000 } = {}) {
  const dialog = (history || [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "Клиент" : "Ева"}: ${m.text}`)
    .join("\n");
  if (!dialog.trim()) return parseOrderJson("");

  const messages = [
    { role: "system", text: EXTRACT_SYSTEM },
    { role: "user", text: `Расшифровка разговора:\n${dialog}\n\nВерни JSON заявки.` },
  ];
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const raw = await ask(messages, { model: "yandexgpt", maxTokens: 400, temperature: 0 });
      return parseOrderJson(raw);
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw lastErr;
}
