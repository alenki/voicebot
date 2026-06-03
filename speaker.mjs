// Озвучивает предложения по одному под токеном хода. Барж-ин вызывает abort():
// плеер останавливается И инвалидируется токен — поэтому ни одно уже запущенное или
// очередное предложение не превращается в звук. Ева замолкает и НЕ возобновляет речь.
//
// Зависит только от player ({ enqueue, stop }) и async synth(text) -> PCM Buffer.
// Никакого знания о WebSocket / STT / LLM — поэтому юнит тестируется фейками.
export class Speaker {
  constructor(player, synth, { onFirstFrame = null } = {}) {
    this.player = player;
    this.synth = synth;
    this.onFirstFrame = onFirstFrame;
    this._gen = 0;                   // токен текущего хода
    this._chain = Promise.resolve(); // последовательная цепочка синтеза/проигрывания
    this._spokeThisTurn = false;
  }

  // Начать новый озвучиваемый ход; вернуть его токен.
  begin() {
    this._spokeThisTurn = false;
    return ++this._gen;
  }

  // Поставить предложение в очередь синтеза+проигрывания, но только пока ход актуален.
  // Токен проверяется и ДО синтеза, и ПОСЛЕ (синтез асинхронный: барж-ин может прийти
  // во время него, и уже синтезированный звук играть нельзя).
  say(token, text) {
    this._chain = this._chain.then(async () => {
      if (token !== this._gen) return;            // ход отменён до синтеза
      let pcm;
      try { pcm = await this.synth(text); }
      catch { return; }                            // синтез упал — пропускаем предложение
      if (token !== this._gen) return;            // ход отменён во время синтеза — НЕ играем
      if (!this._spokeThisTurn) { this._spokeThisTurn = true; this.onFirstFrame?.(); }
      this.player.enqueue(pcm);
    });
    return this._chain;
  }

  // Дождаться, пока всё поставленное в текущем ходе синтезировано/проиграно.
  drain() { return this._chain; }

  // Барж-ин: мгновенно оборвать речь и запретить возобновление.
  abort() { this._gen++; this.player.stop(); }

  get gen() { return this._gen; }

  // Прозвучало ли в этом ходе хоть одно предложение (true после первого поставленного в
  // очередь кадра). Если синтез упал на всех предложениях — останется false: вызывающий код
  // может на это среагировать (извиниться вместо «мёртвой тишины»). Сбрасывается в begin().
  get spokeThisTurn() { return this._spokeThisTurn; }
}
