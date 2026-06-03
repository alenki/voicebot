// Эвристика «настоящего» перебивания: игнорируем короткие поддакивания (бэкчэннелы),
// перебиваем только на содержательной речи. Пороги — первое разумное приближение,
// уточняются после прослушивания реальных звонков (см. spec, «Backchannel thresholds»).
const BACKCHANNELS = new Set(["угу", "ага", "да", "дада", "мгм", "ммм", "ну", "окей", "ок", "хорошо"]);

// Токен-поддакивание: убираем пунктуацию и разбиваем по дефисам ("да-да-да" → да·да·да),
// и если КАЖДАЯ часть — базовое поддакивание, весь токен считаем поддакиванием.
function isBackchannelToken(word) {
  const parts = word.replace(/[.,!?…]/g, "").split("-").filter(Boolean);
  return parts.length > 0 && parts.every((p) => BACKCHANNELS.has(p));
}

export function isSubstantive(partial) {
  const text = (partial || "").trim().toLowerCase();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  // Отбрасываем поддакивания: если из них состоит ВСЯ реплика ("да да", "ну да", "да-да-да",
  // "ага угу") — это не перебивание, даже когда слов несколько.
  const content = words.filter((w) => !isBackchannelToken(w));
  if (content.length === 0) return false;
  // Иначе содержательно: ≥2 содержательных слова или одно достаточно длинное.
  return content.length >= 2 || content.join("").replace(/[^\p{L}]/gu, "").length >= 5;
}

// Состояния, в которых «слово» у Евы (приветствие тоже идёт в состоянии SPEAKING) —
// только в них абонент может перебить. В LISTENING перебивать нечего.
const INTERRUPTIBLE = new Set(["SPEAKING", "THINKING"]);

// Политика барж-ина: перебиваем, только если (1) слово у Евы, (2) прошло окно «прогрева»
// (защита от хвоста собственной реплики абонента сразу после её финализации) и
// (3) речь содержательна (а не короткое поддакивание).
export function shouldInterrupt(state, partial, sinceFloorMs = Infinity, graceMs = 0) {
  return INTERRUPTIBLE.has(state) && sinceFloorMs >= graceMs && isSubstantive(partial);
}
