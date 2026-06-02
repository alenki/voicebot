// Эвристика «настоящего» перебивания: игнорируем короткие поддакивания (бэкчэннелы),
// перебиваем только на содержательной речи. Пороги — первое разумное приближение,
// уточняются после прослушивания реальных звонков (см. spec, «Backchannel thresholds»).
const BACKCHANNELS = new Set(["угу", "ага", "да", "дада", "да-да", "мгм", "ммм", "ну", "окей", "ок", "хорошо"]);

export function isSubstantive(partial) {
  const text = (partial || "").trim().toLowerCase();
  if (!text) return false;
  const words = text.split(/\s+/);
  // Одно короткое слово-поддакивание — не перебивание.
  if (words.length === 1 && BACKCHANNELS.has(words[0].replace(/[.,!?…]/g, ""))) return false;
  // Иначе содержательно, если набралось хотя бы 2 слова или достаточно символов.
  return words.length >= 2 || text.replace(/[^\p{L}]/gu, "").length >= 5;
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
