// node --test speaker.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { Speaker } from "./speaker.mjs";

// Фейк плеера: помнит, что и в каком порядке поставлено в очередь, и сколько раз stop().
function fakePlayer() {
  const enq = [];
  let stops = 0;
  return {
    enqueue: (pcm) => enq.push(pcm),
    stop: () => { stops++; },
    get enqueued() { return enq; },
    get stops() { return stops; },
  };
}

// Управляемый синтез: возвращает промисы, которые тест резолвит вручную (deferred).
function controllableSynth() {
  const pending = [];
  const synth = (text) => new Promise((resolve) => pending.push({ text, resolve }));
  return { synth, pending };
}

const flush = () => new Promise((r) => setImmediate(r));

test("normal turn: sentences are enqueued in order", async () => {
  const player = fakePlayer();
  const sp = new Speaker(player, async (t) => Buffer.from(t)); // мгновенный синтез
  const g = sp.begin();
  sp.say(g, "Раз");
  sp.say(g, "Два");
  sp.say(g, "Три");
  await sp.drain();
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["Раз", "Два", "Три"]);
  assert.strictEqual(player.stops, 0);
});

test("abort mid-turn: player stopped and NOTHING more is enqueued (no resume)", async () => {
  const player = fakePlayer();
  const { synth, pending } = controllableSynth();
  const sp = new Speaker(player, synth);
  const g = sp.begin();
  sp.say(g, "Первое");
  sp.say(g, "Второе");
  sp.say(g, "Третье");

  // Дать цепочке стартовать: первый say уходит в синтез -> появляется pending[0].
  await flush();

  // Синтез сериализован: первое в работе, остальные ждут очереди.
  pending[0].resolve(Buffer.from("Первое"));
  await flush();
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["Первое"]);

  // Барж-ин ровно когда «Второе» ещё синтезируется.
  sp.abort();
  assert.strictEqual(player.stops, 1);

  // Синтез «Второго» возвращается уже ПОСЛЕ перебивания — играть его нельзя.
  pending[1].resolve(Buffer.from("Второе"));
  await flush();

  // «Второе» (синтез вернулся после abort) и «Третье» (стояло в очереди) — отброшены.
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["Первое"]);
  assert.strictEqual(pending.length, 2); // до синтеза «Третьего» дело не дошло
});

// abort() рвёт цепочку синтеза: раньше первое предложение СЛЕДУЮЩЕГО хода вставало в
// очередь позади зависшего TTS отменённого хода (до ~8с таймаута) — после barge-in Ева
// молчала лишние секунды. Теперь новый ход стартует немедленно, старый синтез — в никуда.
test("abort рвёт цепочку: новый ход не ждёт зависший синтез отменённого", async () => {
  const player = fakePlayer();
  const { synth, pending } = controllableSynth();
  const sp = new Speaker(player, synth);
  const g1 = sp.begin();
  sp.say(g1, "Зависшее");           // синтез «в полёте», промис не резолвится
  await flush();
  sp.abort();                        // barge-in

  const g2 = sp.begin();
  sp.say(g2, "Новое");
  await flush();
  // Новый синтез стартовал, НЕ дожидаясь зависшего: pending уже содержит «Новое».
  assert.deepStrictEqual(pending.map((p) => p.text), ["Зависшее", "Новое"]);
  pending[1].resolve(Buffer.from("Новое"));
  await sp.drain();
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["Новое"]);
  // Старый синтез вернулся позже — токен-гейт не пускает его в плеер.
  pending[0].resolve(Buffer.from("Зависшее"));
  await flush();
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["Новое"]);
});

test("fresh turn after abort still works", async () => {
  const player = fakePlayer();
  const sp = new Speaker(player, async (t) => Buffer.from(t));
  const g1 = sp.begin();
  sp.say(g1, "Старое");
  sp.abort();
  await sp.drain();
  const before = player.enqueued.length;

  const g2 = sp.begin();
  sp.say(g2, "Новое");
  await sp.drain();
  assert.deepStrictEqual(player.enqueued.slice(before).map((b) => b.toString()), ["Новое"]);
});

test("spokeThisTurn: true when a sentence was voiced", async () => {
  const player = fakePlayer();
  const sp = new Speaker(player, async (t) => Buffer.from(t));
  const g = sp.begin();
  sp.say(g, "Привет");
  await sp.drain();
  assert.strictEqual(sp.spokeThisTurn, true);
});

test("spokeThisTurn: false when synth fails for every sentence (nothing voiced)", async () => {
  const player = fakePlayer();
  const sp = new Speaker(player, async () => { throw new Error("TTS down"); });
  const g = sp.begin();
  sp.say(g, "Раз");
  sp.say(g, "Два");
  await sp.drain();
  assert.strictEqual(sp.spokeThisTurn, false);
  assert.strictEqual(player.enqueued.length, 0);
});

test("spokeThisTurn: reset to false by begin() for the next turn", async () => {
  const player = fakePlayer();
  const sp = new Speaker(player, async (t) => Buffer.from(t));
  const g1 = sp.begin();
  sp.say(g1, "Первое");
  await sp.drain();
  assert.strictEqual(sp.spokeThisTurn, true);
  sp.begin();
  assert.strictEqual(sp.spokeThisTurn, false);
});

// sayPcm — мгновенная озвучка ГОТОВОГО PCM (филлер «Секундочку…» из кэша). Идёт мимо
// цепочки синтеза: филлер маскирует паузу размышления и не должен ждать, пока доварится
// первое настоящее предложение. Токен-гейт сохраняется (barge-in убивает и филлер).
test("sayPcm: enqueues immediately, ahead of an in-flight synth", async () => {
  const player = fakePlayer();
  const { synth, pending } = controllableSynth();
  const sp = new Speaker(player, synth);
  const g = sp.begin();
  sp.say(g, "Настоящее предложение");      // синтез завис «в полёте»
  await flush();
  sp.sayPcm(g, Buffer.from("ФИЛЛЕР"));
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["ФИЛЛЕР"]);
  pending[0].resolve(Buffer.from("Настоящее"));
  await flush();
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["ФИЛЛЕР", "Настоящее"]);
});

test("sayPcm: stale token enqueues nothing (barge-in already invalidated the turn)", () => {
  const player = fakePlayer();
  const sp = new Speaker(player, async (t) => Buffer.from(t));
  const g = sp.begin();
  sp.abort();
  sp.sayPcm(g, Buffer.from("ФИЛЛЕР"));
  assert.strictEqual(player.enqueued.length, 0);
});

test("sayPcm: does NOT count as spokeThisTurn (apology logic still sees a silent turn)", () => {
  const player = fakePlayer();
  const sp = new Speaker(player, async (t) => Buffer.from(t));
  const g = sp.begin();
  sp.sayPcm(g, Buffer.from("ФИЛЛЕР"));
  assert.strictEqual(sp.spokeThisTurn, false);
});

// ── Потоковый синтез: synth отдаёт PCM чанками через emit(chunk) ────────────────────────
// Первый звук уходит в плеер ДО конца синтеза предложения; порядок чанков сохраняется;
// барж-ин посреди стрима гасит оставшиеся чанки токен-гейтом.
test("streaming synth: чанки уходят в плеер по мере прихода, без двойного проигрывания", async () => {
  const player = fakePlayer();
  const sp = new Speaker(player, async (t, emit) => {
    emit(Buffer.from(t + "-1"));
    emit(Buffer.from(t + "-2"));
    return Buffer.from(t + "-full"); // полный буфер (для кэша) НЕ должен играться второй раз
  });
  const g = sp.begin();
  sp.say(g, "Раз");
  await sp.drain();
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["Раз-1", "Раз-2"]);
  assert.strictEqual(sp.spokeThisTurn, true);
});

test("streaming synth: abort посреди стрима — дальнейшие чанки отброшены", async () => {
  const player = fakePlayer();
  let releaseTail;
  const tail = new Promise((r) => { releaseTail = r; });
  const sp = new Speaker(player, async (t, emit) => {
    emit(Buffer.from("до"));
    await tail;               // barge-in происходит здесь
    emit(Buffer.from("после"));
    return null;
  });
  const g = sp.begin();
  const done = sp.say(g, "Фраза");
  await flush();
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["до"]);
  sp.abort();
  releaseTail();
  await done;
  assert.deepStrictEqual(player.enqueued.map((b) => b.toString()), ["до"], "чанк после abort не играет");
});

test("streaming synth: onFirstFrame срабатывает на ПЕРВОМ чанке", async () => {
  const player = fakePlayer();
  let firstAtChunks = -1;
  const sp = new Speaker(player, async (t, emit) => {
    emit(Buffer.from("a"));
    emit(Buffer.from("b"));
    return null;
  }, { onFirstFrame: () => { firstAtChunks = player.enqueued.length; } });
  const g = sp.begin();
  sp.say(g, "Фраза");
  await sp.drain();
  assert.strictEqual(firstAtChunks, 0, "onFirstFrame должен сработать до первого enqueue");
});

test("onFirstFrame fires once per turn, on the first enqueued sentence", async () => {
  const player = fakePlayer();
  let firsts = 0;
  const sp = new Speaker(player, async (t) => Buffer.from(t), { onFirstFrame: () => firsts++ });
  const g = sp.begin();
  sp.say(g, "Раз"); sp.say(g, "Два");
  await sp.drain();
  assert.strictEqual(firsts, 1);
  const g2 = sp.begin();
  sp.say(g2, "Три");
  await sp.drain();
  assert.strictEqual(firsts, 2);
});
