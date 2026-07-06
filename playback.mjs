// Отдаёт PCM-аудио обратно в Voximplant в темпе реального времени (frameMs мс на кадр).
//
// ПОЧЕМУ НЕ «один кадр за тик setInterval»: setInterval(fn, 20) НЕ срабатывает 50 раз в
// секунду — на Windows/Node тик реально ≈25-26мс (накладные таймера + гранулярность 15.6мс),
// а под нагрузкой (STT/TTS/WS) ещё реже. «Один кадр за тик» отдавал ~37 кадров/с вместо 50:
// 2с звука растягивались на ~2.7с, дальний буфер Voximplant голодал и голос рвался — абонент
// слышал «как будто плохой интернет». Поэтому темп держим по ДЕДЛАЙНАМ, а не по частоте тиков.
//
// Как работает: у каждого кадра есть плановое время отправки (nextDue, растёт на frameMs).
// На каждом пробуждении таймера отдаём ВСЕ кадры, чьё время уже наступило (догоняем после
// любой задержки event loop), но не дальше горизонта now+lookaheadMs — небольшой запас, чтобы
// дальний буфер не голодал на сетевом джиттере (ngrok/WS). Запас ограничен lookaheadMs, так что
// barge-in (stop() чистит очередь) обрывает речь почти мгновенно: в полёте максимум ~lookaheadMs
// звука — много меньше окна прогрева GRACE_MS=500мс.
export class PacedPlayer {
  constructor(sendFrame, { sampleRate = 8000, frameMs = 20, lookaheadMs = 120, onIdle = null } = {}) {
    this.sendFrame = sendFrame;
    this.frameBytes = Math.round(sampleRate * (frameMs / 1000)) * 2; // 16-бит моно
    this.frameMs = frameMs;
    this.lookaheadMs = lookaheadMs;
    this.onIdle = onIdle; // вызывается, когда очередь опустела (диагностика пейсинга)
    this.queue = Buffer.alloc(0);
    this.timer = null;
    this.nextDue = 0; // стенные часы (мс), когда должен уйти следующий кадр
  }
  enqueue(pcm) {
    this.queue = Buffer.concat([this.queue, pcm]);
    if (!this.timer) this._start();
  }
  _start() {
    this.nextDue = Date.now(); // первый кадр — сразу
    // Тикаем чаще кадра: даже грубый таймер успевает догнать дедлайны. Сколько кадров уйдёт,
    // решает арифметика nextDue, а не частота тиков, поэтому точность тика некритична.
    this.timer = setInterval(() => this._pump(), Math.max(4, Math.floor(this.frameMs / 2)));
    this._pump(); // не ждём первый тик — отдаём стартовый запас немедленно
  }
  _pump() {
    if (this.queue.length === 0) { this._idle(); return; }
    const horizon = Date.now() + this.lookaheadMs;
    // Отдаём все «дозревшие» кадры (догоняем после стопора event loop) до горизонта.
    while (this.queue.length > 0 && this.nextDue <= horizon) {
      if (this.queue.length < this.frameBytes) {
        // Хвост короче кадра: конец предложения ИЛИ недобор потокового синтеза (чанки TTS
        // теперь текут в очередь по мере генерации). Берём только ЧЁТНУЮ часть — нечётный
        // срез PCM16 сместил бы все последующие сэмплы (остаток фразы играл бы шумом), —
        // и добиваем тишиной до полного кадра: исходящий кадр всегда 20мс, timestamp
        // остаётся целым в сэмплах. Нечётный остаток (полсэмпла на границе HTTP-чанка)
        // дождётся следующего чанка; полный поток предложения всегда чётный.
        const take = this.queue.length & ~1;
        if (take === 0) break; // одинокий нечётный байт — ждём вторую половину сэмпла
        const padded = Buffer.alloc(this.frameBytes);
        this.queue.subarray(0, take).copy(padded);
        this.queue = this.queue.subarray(take);
        this.sendFrame(padded);
        this.nextDue += this.frameMs;
        continue;
      }
      const frame = this.queue.subarray(0, this.frameBytes);
      this.queue = this.queue.subarray(frame.length);
      this.sendFrame(frame);
      this.nextDue += this.frameMs;
    }
    if (this.queue.length === 0) this._idle();
  }
  _idle() { clearInterval(this.timer); this.timer = null; this.nextDue = 0; this.onIdle?.(); }
  stop() { this.queue = Buffer.alloc(0); this._idle(); }
  get speaking() { return this.timer !== null; }
}
