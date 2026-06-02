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
