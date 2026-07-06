// Энергетический VAD: отличаем речь АБОНЕНТА В ТРУБКУ от фонового шума/чужого разговора
// по громкости кадра относительно адаптивного шумового пола. STT транскрибирует любую
// речь в линии (телевизор, коллеги рядом) — по одному тексту абонента от фона не отличить,
// а вот по энергии обычно можно: голос в микрофон стабильно громче комнаты.
//
// Использование: const vad = new EnergyVad(); vad.frame(pcm16leBuffer) → { db, speech }.
// Классификация «речь» = кадр громче пола на marginDb И громче абсолютного минимума minDb.
// Пол адаптивный: на тихих кадрах дрейфует к их уровню (вверх и вниз), на громких ползёт
// вверх еле-еле — постоянная фоновая болтовня постепенно поднимает пол (и перестаёт
// считаться речью), а обычная реплика абонента (3-5с) пол заметно не сдвигает.
// Пороги — первое приближение, тюнить по логам живых звонков (см. CLAUDE.md, VAD_* knobs).

// Громкость кадра PCM16LE в dBFS (0 = полная шкала, тишина ≈ -100).
export function frameDb(pcm) {
  const n = pcm.length >> 1;
  if (!n) return -100;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  if (rms < 1) return -100;
  return 20 * Math.log10(rms / 32768);
}

export class EnergyVad {
  constructor({
    marginDb = 10,       // насколько кадр должен быть громче пола, чтобы считаться речью
    minDb = -50,         // абсолютный минимум речи: тише этого — не речь, каким бы ни был пол
    floorInitDb = -65,   // стартовый пол — типичный комфорт-шум телефонной линии
    floorMaxDb = -45,    // потолок пола: адаптация не может «заглушить» настоящую речь
    driftRate = 0.05,    // скорость дрейфа пола к уровню ТИХОГО кадра (доля разницы за кадр)
    riseOnSpeechDb = 0.01, // подъём пола на «речевом» кадре (0.5 дБ/с при 50 кадр/с):
                           // непрерывная получасовая болтовня фона медленно съедается полом,
                           // а обычная реплика абонента пол заметно не сдвигает
  } = {}) {
    this.marginDb = marginDb;
    this.minDb = minDb;
    this.floorMaxDb = floorMaxDb;
    this.driftRate = driftRate;
    this.riseOnSpeechDb = riseOnSpeechDb;
    this.floor = floorInitDb;
  }

  frame(pcm) {
    const db = frameDb(pcm);
    const speech = db >= this.minDb && db >= this.floor + this.marginDb;
    if (speech) {
      this.floor = Math.min(this.floor + this.riseOnSpeechDb, this.floorMaxDb);
    } else {
      // Тихий кадр — пол дрейфует к его уровню (вверх и вниз): следит за комфорт-шумом
      // линии между репликами. Не мгновенно: одиночный нулевой DTX-кадр пол не роняет.
      this.floor += (db - this.floor) * this.driftRate;
    }
    return { db, speech };
  }
}
