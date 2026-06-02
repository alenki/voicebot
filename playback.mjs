// Отдаёт PCM-аудио обратно в Voximplant ровными фреймами по frameMs миллисекунд.
// Пейсинг обязателен: чтобы barge-in мог МГНОВЕННО оборвать речь, нельзя вываливать
// весь буфер в сокет сразу — иначе уже отправленное доиграется. stop() очищает очередь.
export class PacedPlayer {
  constructor(sendFrame, { sampleRate = 8000, frameMs = 20 } = {}) {
    this.sendFrame = sendFrame;
    this.frameBytes = Math.round(sampleRate * (frameMs / 1000)) * 2; // 16-бит моно
    this.frameMs = frameMs;
    this.queue = Buffer.alloc(0);
    this.timer = null;
  }
  enqueue(pcm) {
    this.queue = Buffer.concat([this.queue, pcm]);
    if (!this.timer) this._tick();
  }
  _tick() {
    this.timer = setInterval(() => {
      if (this.queue.length === 0) { this._idle(); return; }
      const frame = this.queue.subarray(0, this.frameBytes);
      this.queue = this.queue.subarray(frame.length);
      this.sendFrame(frame);
    }, this.frameMs);
  }
  _idle() { clearInterval(this.timer); this.timer = null; }
  stop() { this.queue = Buffer.alloc(0); this._idle(); }
  get speaking() { return this.timer !== null; }
}
