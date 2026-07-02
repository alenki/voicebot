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

// Нормализация для пословного сравнения: регистр, ё→е, пунктуация — STT транскрибирует
// эхо без знаков и в нижнем регистре, а текст Евы приходит «как написан».
const normWords = (s) => (s || "")
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/[^\p{L}\p{N}\s-]/gu, " ")
  .split(/\s+/)
  .filter(Boolean);

// Эхо собственной речи Евы: на громкой связи её голос возвращается через микрофон абонента,
// и STT честно его распознаёт. Партиал, почти целиком (≥80% слов) собранный из слов текущей
// реплики Евы (selfText), считаем эхом — он не должен ни перебивать её, ни становиться
// «ходом абонента». Партиалы из одного слова эхом НЕ считаем: короткий ответ абонента
// её же словом («визитки» на вопрос «вам визитки или баннеры?») — обычное дело.
export function isEchoOf(partial, selfText) {
  if (!selfText) return false;
  const words = normWords(partial);
  if (words.length < 2) return false;
  const self = new Set(normWords(selfText));
  const hits = words.filter((w) => self.has(w)).length;
  return hits / words.length >= 0.8;
}

// Состояния, в которых «слово» у Евы (приветствие тоже идёт в состоянии SPEAKING) —
// только в них абонент может перебить. В LISTENING перебивать нечего.
const INTERRUPTIBLE = new Set(["SPEAKING", "THINKING"]);

// Политика барж-ина: перебиваем, только если (1) слово у Евы, (2) прошло окно «прогрева»
// (защита от хвоста собственной реплики абонента сразу после её финализации), (3) речь
// содержательна (а не короткое поддакивание), (4) это не эхо-«хвост» уже завершённого
// хода — партиал, дословно равный последней финализированной реплике (lastFinalText), и
// (5) это не эхо речи самой Евы (selfText — то, что она произносит в текущем ходе).
// Оба эхо-гейта применяются только когда соответствующий аргумент передан; пустая строка
// в начале звонка реальную речь не глушит. ⚠️ Точное равенство по lastFinalText — «первое
// приближение» (см. spec, «detection-tuning edges»): дословный повтор фразы абонентом тоже
// совпадёт и не перебьёт. Снять это ограничение нельзя «вслепую» — нужно окно по времени,
// выверенное на логах живых звонков.
export function shouldInterrupt(state, partial, sinceFloorMs = Infinity, graceMs = 0, lastFinalText = null, selfText = null) {
  const isEcho = (lastFinalText != null && partial === lastFinalText) || isEchoOf(partial, selfText);
  return INTERRUPTIBLE.has(state) && sinceFloorMs >= graceMs && !isEcho && isSubstantive(partial);
}
