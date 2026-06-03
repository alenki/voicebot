// Очистка ответа YandegGPT-lite перед озвучиванием. Общая для turn-based (server.mjs)
// и стримингового (stream-server.mjs) путей — приветствие уже звучит в начале звонка,
// а модель иногда дописывает фальшивые реплики обеих сторон.

// YandexGPT-lite зеркалит приветствие клиента в первом ответе, даже когда промпт
// это запрещает. Сценарий уже здоровается в начале звонка, поэтому срезаем ведущее
// приветствие из ответа — гарантированно, без надежды на модель.
const GREETING_RE =
  /^[\s—–-]*(здравствуй(?:те)?|добр(?:ый|ое|ого)\s+(?:день|утро|вечер|дня|времени\s+суток)|приветствую(?:\s+вас)?|привет)[\s,!.…—–-]*/iu;

export function stripGreeting(text) {
  const stripped = text.replace(GREETING_RE, "");
  if (stripped === text || stripped.length === 0) return text; // приветствия не было — не трогаем
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);  // восстанавливаем заглавную букву
}

// Как stripGreeting, но БЕЗ страховки «вернуть оригинал, если осталось пусто». Нужно для
// потокового пути, где приветствие приходит ОТДЕЛЬНЫМ предложением ("Здравствуйте!"): его
// нужно превратить в "" и выбросить, а не оставить (иначе Ева здоровается в каждом ответе).
export function stripLeadingGreeting(text) {
  const stripped = text.replace(GREETING_RE, "");
  if (!stripped) return "";
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

// YandexGPT-lite иногда «доигрывает» диалог за обе стороны и дописывает фальшивые
// реплики вида «Пользователь: …» / «Ассистент: …». Обрезаем ответ на первой такой метке:
// клиент должен услышать только первую реплику Евы.
// Две формы: (1) метка с новой строки; (2) метка ВНУТРИ строки — модель доигрывает диалог
// в одну строку («… Пользователь: … Ассистент: …»), а stripMarkup к этому моменту уже
// схлопнул переносы в пробелы, поэтому ловим метку и по пробелу тоже.
const ROLEPLAY_RE = /\n+\s*(?:пользовател[ья]|ассистент|клиент|оператор|ева|бот|собеседник|менеджер|user|assistant)\s*:/iu;
const INLINE_ROLEPLAY_RE = /\s(?:пользовател[ья]|ассистент|клиент|оператор|собеседник|user|assistant)\s*:\s/iu;

export function stripRolePlay(text) {
  let cut = -1;
  for (const re of [ROLEPLAY_RE, INLINE_ROLEPLAY_RE]) {
    const m = text.match(re);
    if (m && m.index > 0) cut = cut < 0 ? m.index : Math.min(cut, m.index);
  }
  return cut > 0 ? text.slice(0, cut).trimEnd() : text; // метки нет (или в самом начале) — не трогаем
}

// YandexGPT-lite иногда отвечает markdown-разметкой (маркированные списки «* …», жирный
// «**…**»), хотя промпт это запрещает. TTS прочитал бы звёздочки вслух, поэтому срезаем
// разметку и превращаем список в связную фразу: убираем эмфазу, маркеры в начале строк,
// схлопываем переносы строк в пробелы.
export function stripMarkup(text) {
  return text
    .replace(/\*\*|__|`/g, "")               // жирный/код
    .replace(/^[ \t]*(?:[*\-•]|\d+[.)])[ \t]+/gmu, "") // маркеры/нумерация в начале строк
    .replace(/[*_]/g, "")                    // одиночные звёздочки/подчёркивания эмфазы
    .replace(/\s*\n+\s*/g, " ")              // переносы строк → пробел (телефонная речь без строк)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// YandexGPT-lite иногда копирует примеры реплик из промпта вместе с обрамляющими
// кавычками-ёлочками «…» (примеры даны в «…»), и вся реплика приезжает в кавычках.
// Снимаем ОДНУ обёртку, только если кавычки именно обрамляют весь ответ (внутри нет
// второй открывающей «) — чтобы не тронуть внутреннее «Альфа Принт».
export function stripWrappingQuotes(text) {
  const t = text.trim();
  if (/^«[\s\S]*»$/.test(t) && (t.match(/«/g) || []).length === 1) return t.slice(1, -1).trim();
  if (/^"[\s\S]*"$/.test(t) && (t.match(/"/g) || []).length === 2) return t.slice(1, -1).trim();
  return text;
}

// yandexgpt-lite иногда говорит о себе в мужском роде («понял»), хотя Ева — женщина;
// мужская форма мгновенно выдаёт бота. Чиним частотные маркеры согласия/состояния.
// \b в JS не работает с кириллицей, поэтому границу слова задаём lookaround по буквам.
const MASC_TO_FEM = [
  [/(?<![а-яёa-z])понял(?![а-яёa-z])/giu, "поняла"],
  [/(?<![а-яёa-z])записал(?![а-яёa-z])/giu, "записала"],
  [/(?<![а-яёa-z])услышал(?![а-яёa-z])/giu, "услышала"],
  [/(?<![а-яёa-z])уточнил(?![а-яёa-z])/giu, "уточнила"],
  [/(?<![а-яёa-z])передал(?![а-яёa-z])/giu, "передала"],
  [/(?<![а-яёa-z])сделал(?![а-яёa-z])/giu, "сделала"],
  [/(?<![а-яёa-z])рад(?![а-яёa-z])/giu, "рада"],
  [/(?<![а-яёa-z])готов(?![а-яёa-z])/giu, "готова"],
];

function matchCase(src, rep) {
  return /[А-ЯЁA-Z]/.test(src[0]) ? rep.charAt(0).toUpperCase() + rep.slice(1) : rep;
}

export function feminize(text) {
  let out = text;
  for (const [re, rep] of MASC_TO_FEM) out = out.replace(re, (m) => matchCase(m, rep));
  return out;
}

// Полная очистка ответа: разметка → обрамляющие кавычки → фальшивый ролеплей → приветствие → женский род.
export function cleanReply(text) {
  return feminize(stripGreeting(stripRolePlay(stripWrappingQuotes(stripMarkup(text)))));
}

// Серверный гейт на телефон. Слабая модель иногда «закрывает» заявку, пообещав обратный
// звонок менеджера, ещё НЕ взяв номер — горячий лид теряется. cleanReply историю не видит,
// поэтому гейт живёт здесь и принимает историю диалога (server.mjs хранит её per-callId).
const PROMISES_CALLBACK_RE = /(перезвон|сам наберёт|менеджер[^.?!]{0,40}(позвон|набер|свяж)|свяжется с вами)/iu;
const ASKS_FOR_PHONE_RE = /(номер|телефон|продиктуйте|диктуйте)/iu;
const NUM_WORDS_RE = /(?<![а-яёa-z])(ноль|один|два|три|четыре|пять|шесть|семь|восемь|девять)(?![а-яёa-z])/giu;

// Есть ли телефон где-то в репликах клиента — цифрами (7+) или словами (5+ цифр-слов).
export function hasPhone(history) {
  for (const m of history) {
    if (m.role !== "user") continue;
    if ((m.text.match(/\d/g) || []).length >= 7) return true;
    if ((m.text.match(NUM_WORDS_RE) || []).length >= 5) return true;
  }
  return false;
}

const PHONE_ASK = "Давайте так — продиктуйте номер, и менеджер перезвонит с точным расчётом. На какой записать?";

// Если реплика обещает обратный звонок, номера ещё нет, а сама реплика его НЕ просит —
// подменяем на просьбу номера, чтобы не потерять заявку. Иначе возвращаем как есть.
export function enforcePhoneGate(history, reply) {
  if (!PROMISES_CALLBACK_RE.test(reply)) return reply;
  if (ASKS_FOR_PHONE_RE.test(reply)) return reply;
  if (hasPhone(history)) return reply;
  return PHONE_ASK;
}
