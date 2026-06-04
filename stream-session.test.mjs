// node --test stream-session.test.mjs
// Регрессия на «баг завершения звонка»: когда абонент кладёт трубку (ws "close"), сессия
// должна (1) оборвать текущий ход LLM и (2) не запускать новые ходы по запоздавшим событиям
// STT. Иначе Ева «думает и говорит» в уже закрытый сокет, впустую тратя вызовы Yandex
// (см. лог живого звонка: реплика синтезировалась через ~2с ПОСЛЕ отключения).
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { runSession } from "./stream-server.mjs";

class FakeWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(data); }
}

const startFrame = () =>
  JSON.stringify({ event: "start", start: { mediaFormat: { sampleRate: 8000 } } });

function makeDeps() {
  const cap = { askCalls: 0, signal: null, onFinal: null, onPartial: null };
  const deps = {
    askStream: (_messages, _onChunk, { signal } = {}) => {
      cap.askCalls++;
      cap.signal = signal;
      return new Promise(() => {}); // ход «в полёте» — намеренно никогда не завершается
    },
    synthesizePcm: async () => Buffer.alloc(320), // 1 кадр 20мс @ 8кГц
    openStt: ({ onFinal, onPartial }) => {
      cap.onFinal = onFinal;
      cap.onPartial = onPartial;
      return { write() {}, close() {} };
    },
    extractOrder: async () => ({ hasOrder: false, fields: {} }),
    deliverLead: async () => ({ ok: true }),
  };
  return { deps, cap };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("close обрывает текущий ход LLM (signal.aborted)", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  runSession(ws, deps);
  ws.emit("message", startFrame());

  // Дожидаемся LISTENING: пока играет приветствие, onFinal игнорируется (state !== LISTENING);
  // как только сессия слушает — финал запускает ход, и askStream вызывается.
  for (let i = 0; i < 100 && cap.askCalls === 0; i++) {
    cap.onFinal?.("хочу визитки тысячу штук");
    if (cap.askCalls) break;
    await sleep(20);
  }
  assert.equal(cap.askCalls, 1, "ход должен стартовать (askStream вызван)");
  assert.equal(cap.signal.aborted, false, "пока звонок жив — ход не оборван");

  ws.emit("close");
  assert.equal(cap.signal.aborted, true, "после close ход LLM должен быть оборван");
});

test("close блокирует новый ход по запоздавшему STT-финалу", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  runSession(ws, deps);
  ws.emit("message", startFrame());

  await sleep(400);                 // приветствие доиграло → LISTENING, ход не начат
  ws.emit("close");
  cap.onFinal?.("перезвоните мне"); // запоздавший STT-финал уже после трубки
  await sleep(30);
  assert.equal(cap.askCalls, 0, "после close новый ход не должен стартовать");
});
