# Barge-in Implementation (Ева, M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller interrupt Ева — anytime she has the floor (greeting, generating, or speaking) a substantive utterance stops her within a beat and she does not resume; backchannels ("угу") do not interrupt.

**Architecture:** Extract the reply's audio tail into a `Speaker` unit that voices sentences under a per-turn cancellation token; barge-in flips the token and stops the player so no queued or in-flight sentence can reach the player (no "resume" bug), and aborts the turn's LLM request. A `shouldInterrupt` policy (in `bargein.mjs`) decides when a partial counts as an interruption. Wired into the existing `stream-server.mjs` session; the turn-based `server.mjs` is untouched.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test`, existing `ws` / `@grpc/grpc-js` streaming stack, Yandex SpeechKit + YandexGPT.

**Spec:** `docs/superpowers/specs/2026-06-02-bargein-implementation-design.md`.

---

## File Structure

- **Create `speaker.mjs`** — `Speaker(player, synth, { onFirstFrame })`: voices sentences one at a time under a turn token. One responsibility: cancellable audio output. No knowledge of WS/STT/LLM (so it is unit-testable).
- **Create `speaker.test.mjs`** — deterministic offline proof of the stop-and-stay-silent behavior.
- **Modify `bargein.mjs`** — add `shouldInterrupt(state, partial, sinceFloorMs, graceMs)` policy; keep `isSubstantive` as-is.
- **Modify `bargein.test.mjs`** — add `shouldInterrupt` cases.
- **Modify `speech.mjs`** — `askStream` accepts `{ model, signal }` and forwards `signal` to `fetch`.
- **Modify `speech.test.mjs`** (new file `speech.test.mjs`) — assert an already-aborted signal makes `askStream` reject. *(Created in Task 3.)*
- **Modify `stream-server.mjs`** — route the speaking path through `Speaker`, add `interrupt()`, barge-in detection in `onPartial`, grace/echo guards, LLM abort.
- **Modify `CLAUDE.md`** — note `speaker.mjs` and that barge-in is wired into the streaming server.

---

## Task 1: The `Speaker` cancellable audio unit

**Files:**
- Create: `speaker.mjs`
- Test: `speaker.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `speaker.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test speaker.test.mjs`
Expected: FAIL — `Cannot find module './speaker.mjs'`.

- [ ] **Step 3: Implement `speaker.mjs`**

```js
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
    this._gen = 0;                  // токен текущего хода
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
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test speaker.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add speaker.mjs speaker.test.mjs
git commit -m "feat: Speaker — cancellable sentence-by-sentence audio (no resume on barge-in)"
```

---

## Task 2: The `shouldInterrupt` barge-in policy

**Files:**
- Modify: `bargein.mjs`
- Test: `bargein.test.mjs`

- [ ] **Step 1: Add the failing tests**

Append to `bargein.test.mjs`, and update its import line:

Change the import at the top from:
```js
import { isSubstantive } from "./bargein.mjs";
```
to:
```js
import { isSubstantive, shouldInterrupt } from "./bargein.mjs";
```

Append these tests:
```js
test("shouldInterrupt: fires on substantive speech while Ева has the floor", () => {
  assert.strictEqual(shouldInterrupt("SPEAKING", "нет я хотел баннер", 1000, 500), true);
  assert.strictEqual(shouldInterrupt("THINKING", "подождите сколько стоит", 1000, 500), true);
});

test("shouldInterrupt: never fires while listening", () => {
  assert.strictEqual(shouldInterrupt("LISTENING", "нет я хотел баннер", 1000, 500), false);
});

test("shouldInterrupt: suppressed inside the grace window", () => {
  assert.strictEqual(shouldInterrupt("SPEAKING", "нет я хотел баннер", 200, 500), false);
});

test("shouldInterrupt: backchannels never interrupt", () => {
  assert.strictEqual(shouldInterrupt("SPEAKING", "угу", 1000, 500), false);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test bargein.test.mjs`
Expected: FAIL — `shouldInterrupt is not a function` (or import error).

- [ ] **Step 3: Implement `shouldInterrupt` in `bargein.mjs`**

Append to `bargein.mjs` (after `isSubstantive`):
```js
// Состояния, в которых «слово» у Евы (приветствие тоже идёт в состоянии SPEAKING) —
// только в них абонент может перебить. В LISTENING перебивать нечего.
const INTERRUPTIBLE = new Set(["SPEAKING", "THINKING"]);

// Политика барж-ина: перебиваем, только если (1) слово у Евы, (2) прошло окно «прогрева»
// (защита от хвоста собственной реплики абонента сразу после её финализации) и
// (3) речь содержательна (а не короткое поддакивание).
export function shouldInterrupt(state, partial, sinceFloorMs = Infinity, graceMs = 0) {
  return INTERRUPTIBLE.has(state) && sinceFloorMs >= graceMs && isSubstantive(partial);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test bargein.test.mjs`
Expected: PASS (all `isSubstantive` + 4 new `shouldInterrupt` tests).

- [ ] **Step 5: Commit**

```bash
git add bargein.mjs bargein.test.mjs
git commit -m "feat: shouldInterrupt barge-in policy (floor + grace + substantive)"
```

---

## Task 3: `askStream` accepts an abort signal

**Files:**
- Modify: `speech.mjs:52` (the `askStream` signature + `fetch` call)
- Test: `speech.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `speech.test.mjs`:
```js
// node --test speech.test.mjs
// Проверяем только отмену: заранее прерванный signal должен отклонить askStream
// (без обращения к сети — fetch проверяет signal.aborted до запроса).
import { test } from "node:test";
import assert from "node:assert";
import { askStream } from "./speech.mjs";

test("askStream rejects when the signal is already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => askStream([{ role: "system", text: "x" }], () => {}, { signal: ac.signal }),
    (e) => e.name === "AbortError" || /abort/i.test(String(e && e.message)),
  );
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test speech.test.mjs`
Expected: FAIL — `askStream` ignores the options object, so `fetch` is called without a signal and the call attempts the network (or throws a different error), not an AbortError.

- [ ] **Step 3: Change the `askStream` signature in `speech.mjs`**

Replace the function header (currently `export async function askStream(messages, onChunk, model = "yandexgpt-lite") {`) with:
```js
export async function askStream(messages, onChunk, { model = "yandexgpt-lite", signal } = {}) {
```

And add `signal` to the `fetch` options. Change the `fetch` call so its options object includes `signal` alongside `method`/`headers`/`body`:
```js
  const res = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${API_KEY}`,
      "Content-Type": "application/json",
      "x-folder-id": FOLDER_ID,
    },
    body: JSON.stringify({
      modelUri: `gpt://${FOLDER_ID}/${model}/latest`,
      completionOptions: { stream: true, temperature: 0.3, maxTokens: 160 },
      messages,
    }),
    signal,
  });
```

(Leave the streaming read loop unchanged — when the signal aborts mid-read, `reader.read()` rejects and the error propagates out of `askStream`.)

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test speech.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add speech.mjs speech.test.mjs
git commit -m "feat: askStream accepts an abort signal (cancel LLM on barge-in)"
```

---

## Task 4: Wire barge-in into `stream-server.mjs`

**Files:**
- Modify: `stream-server.mjs`

This task has no new unit test — it is WebSocket/STT/LLM orchestration. Correctness of the cancellation is proven by Tasks 1–3; this task is verified by `node --check`, by the offline replay still producing a coherent reply, and ultimately by a live call (M3 criteria, user-verified).

- [ ] **Step 1: Add the two new imports**

In the import block at the top of `stream-server.mjs`, add:
```js
import { Speaker } from "./speaker.mjs";
import { shouldInterrupt } from "./bargein.mjs";
```
And change the `askStream` import line so it still imports `askStream` and `synthesizePcm` (unchanged):
```js
import { askStream, synthesizePcm } from "./speech.mjs";
```

- [ ] **Step 2: Add the new per-call session variables**

Inside `wss.on("connection", (ws) => { ... })`, next to the other `let` declarations (near `let player = null; let stt = null;`), add:
```js
  let speaker = null;        // озвучка ответа под токеном хода (для barge-in)
  let currentTurn = null;    // AbortController текущего хода LLM (если идёт THINKING)
  let floorAt = 0;           // когда «слово» перешло к Еве — отсчёт окна прогрева barge-in
  let turnStartedAt = 0;     // старт текущего хода — для лога «время до 1го кадра»
  let lastFinalText = "";    // последняя финализированная реплика абонента (эхо-защита)
  const GRACE_MS = 500;      // окно прогрева: первые 500мс речи Евы не перебиваем (хвост абонента)
```

- [ ] **Step 3: Replace the `speak()` function**

Replace the existing `speak(text, onFirstFrame)` function (the one with the `⏱` comment that loops over `splitSentences` and calls `player.enqueue`) with this token-aware version that uses the `Speaker` and owns its own return-to-listening:

```js
  // Озвучить готовый текст (приветствие / извинение) — не из LLM. Через speaker, чтобы
  // barge-in мог прервать его так же, как обычный ответ. Сам возвращает сессию в LISTENING,
  // если речь не была перебита (если перебита — interrupt() уже выставил LISTENING).
  async function speak(text) {
    turnStartedAt = Date.now();
    floorAt = Date.now();
    currentTurn = null;               // не из LLM — отменять нечего
    state = "SPEAKING";
    const token = speaker.begin();
    for (const sentence of splitSentences(text)) speaker.say(token, sentence);
    await speaker.drain();
    if (token !== speaker.gen) return; // нас перебили — состояние уже LISTENING
    beginListening();
  }
```

- [ ] **Step 4: Replace `handleTurn()` to use the `Speaker` + abort signal**

Replace the entire existing `handleTurn(text, src)` function with this version (it keeps the streaming-LLM, sentence-draining, greeting-strip, and logging behavior, but voices through `speaker.say(token, …)` and cancels cleanly on barge-in):

```js
  async function handleTurn(text, src) {
    const t0 = Date.now();
    turnStartedAt = t0;
    floorAt = t0;                       // «слово» перешло к Еве (THINKING) — отсюда грейс barge-in
    const eouGap = lastVoiceAt ? t0 - lastVoiceAt : 0;
    const audioRecvSec = (inCount * 0.02).toFixed(1);
    const wallSec = inFirstAt ? ((t0 - inFirstAt) / 1000).toFixed(1) : "0";
    console.log(`[${callId}] ${ts()} клиент [${src}]: ${text}  ⏱пауза≈${eouGap}ms | аудио принято ${audioRecvSec}s за ${wallSec}s`);
    history.push({ role: "user", text });
    state = "THINKING";

    const ac = new AbortController();
    currentTurn = ac;
    const token = speaker.begin();

    let consumed = 0;          // индекс в raw, уже превращённый в речь
    let raw = "";              // последний накопленный текст модели
    let isFirst = true;
    const spoken = [];         // озвученные (очищенные) предложения — для истории/лога

    const enqueueSpeak = (sentence) => {
      let cleaned = stripMarkup(sentence).trim();
      if (isFirst) {
        cleaned = stripLeadingGreeting(cleaned).trim();
        if (!cleaned) return;            // предложение было только приветствием — выбрасываем
        isFirst = false;
      }
      if (!cleaned) return;
      state = "SPEAKING";
      spoken.push(cleaned);
      speaker.say(token, cleaned);
    };

    const drainComplete = () => {
      const matches = raw.slice(consumed).match(/[^.!?…]*[.!?…]+/gu); // только завершённые предложения
      if (!matches) return;
      for (const m of matches) { consumed += m.length; enqueueSpeak(m.trim()); }
    };

    try {
      raw = await askStream(history, (cum) => { raw = cum; drainComplete(); }, { signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) {           // barge-in во время THINKING — тихо выходим
        if (spoken.length) history.push({ role: "assistant", text: spoken.join(" ") });
        return;                          // LISTENING уже выставлен interrupt()
      }
      console.error(`[${callId}] LLM ошибка:`, e.message);
      await speak("Извините, техническая ошибка, повторите пожалуйста.");
      return;                            // speak() сам вернул сессию в LISTENING
    }
    drainComplete();                     // добиваем завершённые предложения
    const tail = raw.slice(consumed).trim();
    if (tail) enqueueSpeak(tail);        // последний «хвост» без терминатора
    await speaker.drain();               // ждём, пока всё синтезировано и поставлено в очередь

    if (ac.signal.aborted) {             // barge-in во время SPEAKING
      if (spoken.length) history.push({ role: "assistant", text: spoken.join(" ") });
      return;                            // LISTENING уже выставлен interrupt()
    }

    const reply = spoken.join(" ");
    history.push({ role: "assistant", text: reply });
    console.log(`[${callId}] Ева (${reply.length}c): ${reply}`);
    beginListening();
  }
```

- [ ] **Step 5: Add the `interrupt()` function**

Add this function next to `handleTurn` (e.g. just above it):
```js
  // Барж-ин: абонент заговорил, пока слово у Евы. Гасим речь и LLM, возвращаемся слушать,
  // и заводим перебившую реплику как следующий ход (тот же STT-поток уже её распознаёт).
  function interrupt(partial) {
    console.log(`[${callId}] ${ts()} BARGE-IN на: "${partial}" — Ева замолкает`);
    try { currentTurn?.abort(); } catch {}  // прерываем LLM-стрим, если идёт THINKING
    speaker.abort();                         // стоп-плеер + инвалидация токена — без возобновления
    beginListening();                        // LISTENING + сброс хода (turnHandled/pendingPartial)
    pendingPartial = partial;                // перебившая реплика — затравка следующего хода
    armEndpoint();
  }
```

- [ ] **Step 6: Set `lastFinalText` in `finalizeTurn()`**

In `finalizeTurn(text, src)`, add the `lastFinalText = text;` line right after `turnHandled = true;`:
```js
  function finalizeTurn(text, src) {
    if (turnHandled || state !== "LISTENING" || !text) return;
    turnHandled = true;
    lastFinalText = text;            // эхо-защита barge-in: не перебиваемся на хвосте этой же реплики
    clearTimeout(endpointTimer);
    endpointTimer = null;
    handleTurn(text, src);
  }
```

- [ ] **Step 7: Rewrite `startSession()` — create the `Speaker`, new `onPartial`, no `.then` on greeting**

Replace the existing `startSession()` function with:
```js
  function startSession() {
    sendStart(); // объявляем формат исходящего аудио до первого media-кадра
    player = new PacedPlayer(sendFrame, {
      sampleRate, frameMs: 20,
      onIdle: () => console.log(`[${callId}] ${ts()} плеер: очередь пуста (аудио доиграло)`),
    });
    // Синтез для speaker: сохраняем существующий повтор synthPcm и лог пропуска предложения.
    const synthForSpeaker = async (text) => {
      try { return await synthPcm(text); }
      catch (e) { console.error(`[${callId}] TTS пропуск:`, e.message); throw e; }
    };
    speaker = new Speaker(player, synthForSpeaker, {
      onFirstFrame: () => console.log(`[${callId}] ${ts()} ⏱ до 1го кадра ${Date.now() - turnStartedAt}ms`),
    });
    stt = openStt({
      sampleRate,
      onPartial: (t) => {
        lastVoiceAt = Date.now();
        // Пока слово у Евы (приветствие/размышление/речь) — проверяем партиал на barge-in.
        if (state === "SPEAKING" || state === "THINKING") {
          if (t !== lastFinalText && shouldInterrupt(state, t, Date.now() - floorAt, GRACE_MS)) {
            interrupt(t);
          }
          return;
        }
        // LISTENING: обычный эндпойнтинг.
        console.log(`[${callId}] ${ts()} …${t}`);
        if (t && t !== pendingPartial) {
          pendingPartial = t;
          armEndpoint();
        }
      },
      onFinal: (t) => finalizeTurn(t, "stt-eou"),
      onError: (e) => console.error(`[${callId}] STT ошибка:`, e.message || e),
    });
    // Диагностика транспорта: частота входящих кадров (норма = 50/с при 20мс).
    hb = setInterval(() => {
      const fps = inCount - lastInCount;
      lastInCount = inCount;
      console.log(`[${callId}] ${ts()} вход: ${fps} кадров/с (норма 50; всего ${inCount})`);
    }, 1000);
    // Приветствие сразу после старта сессии (speak() сам вернёт сессию в LISTENING).
    speak(GREETING);
  }
```

- [ ] **Step 8: Syntax-check and boot**

Run: `node --check stream-server.mjs`
Expected: exit 0, no output.
Run: `node --env-file=.env stream-server.mjs`
Expected: prints `Стриминговый сервер слушает ws://localhost:3001/media`. Stop it with Ctrl-C.

- [ ] **Step 9: Commit**

```bash
git add stream-server.mjs
git commit -m "feat: M3 smart barge-in wired into streaming session (Speaker + LLM abort)"
```

---

## Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Note `speaker.mjs` + barge-in in the code map**

In `CLAUDE.md`, in the streaming-path description / code map (wherever `stream-server.mjs`, `stt-stream.mjs`, `playback.mjs`, `bargein.mjs` are listed), add a one-line entry:
```
- `speaker.mjs` — voices a reply sentence-by-sentence under a per-call cancellation token;
  `abort()` stops the player AND invalidates queued/in-flight sentences so barge-in can't
  let Ева resume. Used by `stream-server.mjs`.
```
And update the `bargein.mjs` line to mention `shouldInterrupt` (the policy: interruptible state + grace window + `isSubstantive`), and note that barge-in is now wired into `stream-server.mjs` (`onPartial` → `interrupt()`), no longer just a standalone filter.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note speaker.mjs + wired barge-in in the streaming code map"
```

---

## Verification Summary

- **Offline (agent-runnable, shown as output):**
  - `node --test speaker.test.mjs` — stop-and-stay-silent proof (4 tests).
  - `node --test bargein.test.mjs` — `isSubstantive` + `shouldInterrupt`.
  - `node --test speech.test.mjs` — `askStream` honors an aborted signal.
  - `node --test playback.test.mjs` — unchanged player still drains/stops.
  - `node --check stream-server.mjs speech.mjs bargein.mjs speaker.mjs`.
- **Regression:** streaming greet→answer loop still works (boot + optional `vox-replay.mjs`); turn-based `node verify-eva.mjs` unaffected (no `server.mjs` change).
- **Live, user-verified (cannot be claimed working without a real call):** interrupt Ева mid-sentence with a real phrase → she stops within a beat, server logs `BARGE-IN`, she answers the new turn; say "угу" while she talks → she keeps going, no `BARGE-IN`.

## Self-Review

- **Spec coverage:** `Speaker` unit + token (Task 1) ✓; `shouldInterrupt` policy incl. grace (Task 2) ✓; LLM abort via signal (Task 3) ✓; `onPartial` barge-in hook, `interrupt()`, floor/grace/echo guards, history-on-interrupt, greeting interruptible (Task 4) ✓; offline tests (Tasks 1–3) ✓; docs (Task 5) ✓. Echo guard (`lastFinalText`) set in `finalizeTurn` (Task 4 Step 6) and checked in `onPartial` (Step 7) ✓.
- **Placeholder scan:** none — every code step shows complete code.
- **Type consistency:** `Speaker` methods `begin()/say(token,text)/drain()/abort()/gen` are used identically in Tasks 1 and 4; `shouldInterrupt(state, partial, sinceFloorMs, graceMs)` signature matches between Tasks 2 and 4; `askStream(messages, onChunk, { model, signal })` matches between Tasks 3 and 4.

## Out of Scope

Streaming TTS (v3 gRPC). Tuning grace/backchannel/`isSubstantive` thresholds beyond a first guess (done on real calls). Acoustic echo cancellation. Any change to `server.mjs` / `/reply`.
