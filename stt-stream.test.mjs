// node --test stt-stream.test.mjs
// Регрессия на «глухую Еву»: раньше ошибка gRPC-потока STT только логировалась — поток
// умирал, и до конца звонка Ева не слышала абонента (живой симптом: любой нестабильный
// звонок «ломал» её). Теперь openStt сам переподключается: новая сессия с теми же
// session_options, а кадры в момент разрыва осознанно теряются (буферизовать их в
// реальном времени бессмысленно). Транспорт подменяется фабрикой connect (тестовый шов).
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { openStt } from "./stt-stream.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Фейковый gRPC-дуплекс: пишет в массив, события — через EventEmitter.
function makeFakeConnect() {
  const streams = [];
  const connect = () => {
    const s = new EventEmitter();
    s.written = [];
    s.ended = false;
    s.write = (msg) => { s.written.push(msg); };
    s.end = () => { s.ended = true; };
    streams.push(s);
    return s;
  };
  return { connect, streams };
}

test("ошибка gRPC: открывается новый поток с session_options, кадры идут в него", async () => {
  const { connect, streams } = makeFakeConnect();
  const errors = [];
  const stt = openStt({ connect, reconnectDelayMs: 10, onError: (e) => errors.push(e) });
  assert.equal(streams.length, 1, "первый поток открыт сразу");
  assert.ok(streams[0].written[0].session_options, "сессия начинается с session_options");

  stt.write(Buffer.from("aa"));
  assert.equal(streams[0].written.length, 2, "кадр ушёл в первый поток");

  streams[0].emit("error", new Error("UNAVAILABLE"));
  assert.equal(errors.length, 1, "ошибка доложена наверх (для лога)");
  stt.write(Buffer.from("bb")); // кадр в разрыве — не бросает, молча теряется
  assert.equal(streams[0].written.length, 2, "в мёртвый поток не пишем");

  await sleep(50);
  assert.equal(streams.length, 2, "после ошибки открыт новый поток");
  assert.ok(streams[1].written[0].session_options, "новая сессия снова начинается с session_options");

  stt.write(Buffer.from("cc"));
  assert.equal(streams[1].written.length, 2, "кадры после реконнекта идут в новый поток");
  stt.close();
});

test("тихий end потока (сервер закрыл сессию) тоже переподключает", async () => {
  const { connect, streams } = makeFakeConnect();
  const stt = openStt({ connect, reconnectDelayMs: 10 });
  streams[0].emit("end");
  await sleep(50);
  assert.equal(streams.length, 2, "после end открыт новый поток");
  stt.close();
});

test("партиалы и финалы из переподключённого потока доходят до колбэков", async () => {
  const { connect, streams } = makeFakeConnect();
  const partials = [], finals = [];
  const stt = openStt({
    connect, reconnectDelayMs: 10,
    onPartial: (t) => partials.push(t),
    onFinal: (t) => finals.push(t),
    onError: () => {},
  });
  streams[0].emit("error", new Error("boom"));
  await sleep(50);
  streams[1].emit("data", { partial: { alternatives: [{ text: "хочу визитки" }] } });
  streams[1].emit("data", { final: { alternatives: [{ text: "хочу визитки сто штук" }] } });
  assert.deepStrictEqual(partials, ["хочу визитки"]);
  assert.deepStrictEqual(finals, ["хочу визитки сто штук"]);
  stt.close();
});

test("close() останавливает переподключение и закрывает поток", async () => {
  const { connect, streams } = makeFakeConnect();
  const stt = openStt({ connect, reconnectDelayMs: 10, onError: () => {} });
  streams[0].emit("error", new Error("boom"));
  stt.close();
  await sleep(50);
  assert.equal(streams.length, 1, "после close() новые потоки не открываются");
});

test("запоздавшее событие старого потока не убивает новый", async () => {
  const { connect, streams } = makeFakeConnect();
  const stt = openStt({ connect, reconnectDelayMs: 10, onError: () => {} });
  streams[0].emit("error", new Error("boom"));
  await sleep(50);
  assert.equal(streams.length, 2);
  streams[0].emit("end"); // хвост старого потока после реконнекта
  await sleep(50);
  assert.equal(streams.length, 2, "событие мёртвого потока игнорируется");
  stt.write(Buffer.from("dd"));
  assert.equal(streams[1].written.length, 2, "живой поток продолжает работать");
  stt.close();
});
