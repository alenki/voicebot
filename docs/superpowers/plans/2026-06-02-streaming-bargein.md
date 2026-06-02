# Streaming + Barge-in Spike (Ева) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove an end-to-end streaming voice loop for one live call — Voximplant WebSocket media → Yandex v3 gRPC streaming STT → YandexGPT → v1 LPCM sentence-synthesis → audio back over the WebSocket — with smart barge-in (interrupt Ева on substantive speech, ignore backchannels).

**Architecture:** A *parallel* streaming path that never touches the verified turn-based stack. A WebSocket server (`stream-server.mjs`) owns one per-call session running a two-state machine (LISTENING ⇄ SPEAKING). STT streams continuously in both states; that always-listening property is what enables barge-in. TTS reuses the existing v1 `synthesize()` as LPCM, synthesized sentence-by-sentence and paced out in ~20 ms frames so playback can be stopped instantly on barge-in.

**Tech Stack:** Node.js (ESM `.mjs`), `ws` (WebSocket server), `@grpc/grpc-js` + `@grpc/proto-loader` (Yandex SpeechKit v3 streaming STT, vendored `.proto` files), YandexGPT via existing `ask()`, Yandex TTS v1 via extended `speech.mjs`.

**Spike reality:** Two external contracts are unobserved until we run real calls — Voximplant's WS media wire format (M0's purpose) and Yandex's v3 gRPC streaming protocol (proven offline in M1). Code for these is concrete best-effort; steps flagged ⚠️ are where M0/M1 output may require small adjustments. Per repo convention, call-dependent milestones are human-judged via real calls and are NOT claimed working without the user confirming.

---

## File Structure

- **Create `prompt.mjs`** — the shared Ева persona. Holds `FACTS`, `BEHAVIOR`, `SYSTEM` (moved verbatim out of `server.mjs`). Both the turn-based and streaming servers import `SYSTEM` from here. One responsibility: the prompt.
- **Modify `server.mjs`** — delete the inline `FACTS`/`BEHAVIOR`/`SYSTEM` consts; import `SYSTEM` from `prompt.mjs`. Nothing else changes. Keeps the turn-based path working and identical in behavior.
- **Modify `speech.mjs`** — add `synthesizePcm(text, sampleRateHertz, voice="alena")` (TTS v1 `format=lpcm`). Existing `synthesize()`/`recognize()`/`ask()` untouched.
- **Create `sentences.mjs`** — `splitSentences(text)`: split a reply into phone-sized sentence chunks for incremental synthesis. One pure function, unit-testable offline.
- **Create `stt-stream.mjs`** — wrapper over Yandex v3 gRPC streaming STT. `openStt({ sampleRate, onPartial, onFinal, onError })` → `{ write(pcmBuffer), close() }`. Isolates the risky gRPC integration.
- **Create `proto/`** — vendored Yandex `.proto` files for the STT v3 service (downloaded, not authored).
- **Create `playback.mjs`** — `PacedPlayer(sendFrame, { sampleRate, frameMs })`: queues PCM buffers and emits fixed-size frames on a timer; `enqueue(buf)`, `stop()` (clears queue + timer). Makes barge-in able to actually halt audio.
- **Create `stream-server.mjs`** — the WebSocket server + per-call `Session` (the LISTENING/SPEAKING state machine, barge-in filter, orchestration). Starts as the M0 probe, grows into the full loop.
- **Create `stt-offline.mjs`** — M1 harness: feed a recorded PCM file through `stt-stream.mjs`, print partials/finals. Mirrors `test.mjs`.
- **Modify `README.md`** — add the streaming Voximplant scenario (canonical copy) next to the existing one.
- **Modify `CLAUDE.md`** — add the streaming path + its run commands to the code map.
- **Modify `package.json`** — add the three dependencies (via `npm install`, which writes them).

---

## Task 1: Extract the shared prompt into `prompt.mjs`

**Files:**
- Create: `prompt.mjs`
- Modify: `server.mjs:8-40` (the `FACTS`/`BEHAVIOR`/`SYSTEM` consts)

- [ ] **Step 1: Create `prompt.mjs` with the prompt moved verbatim**

Copy the `FACTS`, `BEHAVIOR`, and `SYSTEM` consts out of `server.mjs` exactly as they are (same template-literal contents, left-aligned on purpose) and export `SYSTEM`:

```js
// Общая персона Евы. Используется и turn-based сервером (server.mjs),
// и стриминговым сервером (stream-server.mjs) — чтобы промпт не дублировался.
// Содержимое шаблонных строк намеренно без отступа — иначе пробелы попадут в промпт.
const FACTS =
`Компания: «Альфа Принт» — рекламное агентство и типография в Нальчике (КБР), работает с 2014 года.
Адрес: г. Нальчик, ул. Тарчокова, 29.
Телефон: +7 (967) 425-79-79. Telegram: @alfaprint07. WhatsApp по тому же номеру. ВКонтакте: vk.com/alfaprint_07.
Оплата: картой.
Режим работы: понедельник–пятница, 09:00–13:00 и 14:00–18:00 (перерыв с 13:00 до 14:00). Суббота и воскресенье — выходной.

Услуги:
— Полиграфия: визитки (включая премиум), буклеты, листовки, сертификаты, открытки, бирки, этикетки, баннеры, плакаты, наклейки, меню.
— Интерьерная печать: на холсте, самоклеящейся плёнке, фотобумаге.
— УФ-печать: на оргстекле, акриле, дереве, ткани, одежде.
— Обработка: лазерная резка (награды, топперы, панно, логотипы), гравировка, плоттерная резка.
— Дополнительно: услуги дизайна, фирменная лента, сувенирный шоколад с логотипом.
— Срочная печать.

Цены и сроки не фиксированы — зависят от тиража, размера, материала и загрузки; их рассчитывает менеджер.`;

const BEHAVIOR =
`Ты — Ева, сотрудница типографии и рекламного агентства «Альфа Принт». Ты отвечаешь на входящие звонки клиентов. Держись как обычный сотрудник: общайся естественно и непринуждённо, не называй себя ассистентом, ботом или программой. Если спрашивают, робот ли ты, автоответчик или программа — не подтверждай это, мягко переведи разговор: скажи, что помогаешь с заказами в «Альфа Принт», и спроси, чем можете помочь.

Стиль: только по-русски, на «вы», тепло и профессионально. Говори как в телефонном разговоре — короткими фразами, без списков, без разметки, без эмодзи. По делу, не повторяйся.

Не здоровайся в ответах: приветствие уже прозвучало в начале звонка. Не начинай ответ со «Здравствуйте» или других приветствий — сразу переходи к сути.

Что ты делаешь: рассказываешь об услугах, адресе, режиме работы и контактах (см. ФАКТЫ) и помогаешь оформить заявку на заказ.

Цены и сроки: никогда не называй конкретные цены и сроки и не выдумывай их. Если спрашивают — объясни, что это зависит от тиража, размера и материала, и что менеджер рассчитает точно. Предложи оформить заявку, чтобы менеджер перезвонил с расчётом.

Оформление заявки: когда клиент хочет заказать, спокойно собери детали, спрашивая по одному-два пункта за раз (не все сразу): 1) что нужно изготовить; 2) тираж; 3) формат или размер; 4) материал, если применимо; 5) желаемый срок; 6) имя и номер телефона. Если клиент чего-то не знает — это нормально, иди дальше, менеджер уточнит. В конце кратко повтори заявку своими словами и попроси подтвердить. Скажи, что передашь заявку менеджеру и он перезвонит с ценой и сроком.

Если вопрос не по теме — вежливо верни разговор к услугам «Альфа Принт». Если не расслышала — вежливо переспроси.`;

export const SYSTEM = `ФАКТЫ О КОМПАНИИ:\n${FACTS}\n\n${BEHAVIOR}`;
```

- [ ] **Step 2: Replace the consts in `server.mjs` with an import**

In `server.mjs`, delete the `FACTS`, `BEHAVIOR`, and `SYSTEM` const block (currently lines 8–40, ending at `const SYSTEM = \`ФАКТЫ О КОМПАНИИ:\n${FACTS}\n\n${BEHAVIOR}\`;`). Leave `stripGreeting`, `stripRolePlay`, the `GREETING_RE`/`ROLEPLAY_RE` regexes, the `dialogs` Map, and the routes untouched. Add to the import block at the top:

```js
import { SYSTEM } from "./prompt.mjs";
```

So the top of `server.mjs` reads:

```js
import express from "express";
import { ask } from "./speech.mjs";
import { SYSTEM } from "./prompt.mjs";
```

- [ ] **Step 3: Syntax-check both files**

Run: `node --check prompt.mjs && node --check server.mjs`
Expected: no output, exit code 0.

- [ ] **Step 4: Verify the turn-based path is unchanged (regression check)**

Start the backend, run the existing behavioral script, stop the backend:

Run (terminal 1): `node --env-file=.env server.mjs`
Expected: prints `Backend слушает http://localhost:3000`.
Run (terminal 2): `node verify-eva.mjs`
Expected: same human-judged behavior as before the refactor — no concrete prices, order read-back, deflects "Вы робот?". The extraction is behavior-preserving; if output differs in kind, the prompt was altered — revert and recopy verbatim.

- [ ] **Step 5: Commit**

```bash
git add prompt.mjs server.mjs
git commit -m "refactor: extract shared Ева prompt into prompt.mjs"
```

---

## Task 2: Add the dependencies and vendor the Yandex STT v3 protos

**Files:**
- Modify: `package.json` (written by `npm install`)
- Create: `proto/yandex/cloud/ai/stt/v3/stt.proto`, `proto/yandex/cloud/ai/stt/v3/stt_service.proto`

- [ ] **Step 1: Install the three runtime dependencies**

Run: `npm install ws @grpc/grpc-js @grpc/proto-loader`
Expected: `package.json` `dependencies` now lists `ws`, `@grpc/grpc-js`, `@grpc/proto-loader` alongside `express`; `node_modules` updated.

- [ ] **Step 2: Download the Yandex SpeechKit v3 proto files**

These are third-party API definitions — download them, do not hand-write them. From the public `yandex-cloud/cloudapi` repository:

```bash
mkdir -p proto/yandex/cloud/ai/stt/v3
curl -sSL -o proto/yandex/cloud/ai/stt/v3/stt.proto \
  https://raw.githubusercontent.com/yandex-cloud/cloudapi/master/yandex/cloud/ai/stt/v3/stt.proto
curl -sSL -o proto/yandex/cloud/ai/stt/v3/stt_service.proto \
  https://raw.githubusercontent.com/yandex-cloud/cloudapi/master/yandex/cloud/ai/stt/v3/stt_service.proto
```

Expected: both files exist and are non-empty (`stt_service.proto` defines `service Recognizer { rpc RecognizeStreaming (stream StreamingRequest) returns (stream StreamingResponse); }`).

⚠️ `stt.proto` may `import` a couple of common Yandex protos (e.g. `yandex/cloud/validation.proto`). If `node --check` of the loader in Task 4 reports a missing import, download that file to the same-relative path under `proto/` and retry. Note any extra files fetched.

- [ ] **Step 3: Confirm the proto path Node will load**

Run: `ls proto/yandex/cloud/ai/stt/v3/`
Expected: `stt.proto  stt_service.proto`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json proto/
git commit -m "build: add ws + grpc deps and vendor Yandex STT v3 protos"
```

---

## Task 3: M0 — WebSocket media probe + Voximplant streaming scenario

**Files:**
- Create: `stream-server.mjs` (probe version)
- (Voximplant scenario lives in the cloud; canonical copy added to `README.md` in Task 9)

- [ ] **Step 1: Write the probe WebSocket server**

This logs every frame Voximplant sends so we learn the exact wire format. It does not yet recognize or reply.

```js
// Стриминговый сервер (M0-проба). Логирует всё, что присылает Voximplant по WebSocket,
// чтобы выяснить точный формат медиапотока. Запуск: node --env-file=.env stream-server.mjs
import { WebSocketServer } from "ws";

const PORT = 3001;
const wss = new WebSocketServer({ port: PORT, path: "/media" });

wss.on("connection", (ws) => {
  console.log("[ws] звонок подключился");
  let frames = 0;
  let bytes = 0;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      frames++;
      bytes += data.length;
      if (frames <= 3 || frames % 50 === 0) {
        console.log(`[ws] бинарный фрейм #${frames}: ${data.length} байт (всего ${bytes})`);
      }
    } else {
      // Текстовые фреймы — обычно метаданные (sample rate, кодек). Печатаем целиком.
      console.log("[ws] текстовый фрейм:", data.toString());
    }
  });

  ws.on("close", () => console.log(`[ws] звонок отключился — бинарных фреймов: ${frames}, байт: ${bytes}`));
  ws.on("error", (e) => console.log("[ws] ошибка:", e.message));
});

console.log(`Стриминговый сервер (проба) слушает ws://localhost:${PORT}/media`);
```

- [ ] **Step 2: Syntax-check and boot the probe**

Run: `node --check stream-server.mjs`
Expected: exit 0.
Run: `node --env-file=.env stream-server.mjs`
Expected: prints `Стриминговый сервер (проба) слушает ws://localhost:3001/media`.

- [ ] **Step 3: Expose the WS and wire the Voximplant scenario (user)**

ngrok tunnels WebSockets. In a second terminal: `ngrok http 3001`, copy the `https://…` forwarding URL, and use its `wss://…/media` form as the WS URL.

In the Voximplant control panel, create a NEW scenario `inbound-stream` (do not edit the working `inbound`). Paste this starting scenario, replacing `<WSS-URL>` with the ngrok `wss` URL:

```js
require(Modules.WebSocket);

const WS_URL = "wss://<WSS-URL>/media";
let call, ws;

VoxEngine.addEventListener(AppEvents.CallAlerting, (e) => {
  call = e.call;
  call.answer();
  call.addEventListener(CallEvents.Connected, onConnected);
  call.addEventListener(CallEvents.Disconnected, () => { if (ws) ws.close(); VoxEngine.terminate(); });
});

function onConnected() {
  ws = VoxEngine.createWebSocket(WS_URL);
  ws.addEventListener(WebSocketEvents.OPEN, () => {
    // Отправляем аудио абонента в наш бэкенд и проигрываем абоненту то, что придёт назад.
    call.sendMediaTo(ws);
    ws.sendMediaTo(call);
  });
  ws.addEventListener(WebSocketEvents.CLOSE, () => Logger.write("WS закрыт"));
  ws.addEventListener(WebSocketEvents.ERROR, (e) => Logger.write("WS ошибка: " + JSON.stringify(e)));
}
```

⚠️ This is the make-or-break unknown. Voximplant's exact media framing (text metadata frame? binary PCM? sample rate? base64?) is precisely what this probe reveals. The scenario above is the documented shape; if `createWebSocket`/`sendMediaTo` signatures differ in your account's VoxEngine version, adjust per the Voximplant WebSocket module docs.

- [ ] **Step 4: Place a real call and read the probe output (user-verified)**

Point the routing rule at `inbound-stream`, then call via phone.voximplant.com and speak a few words.
**Pass criteria — record these in the M0 findings note (Step 5):**
- Binary audio frames arrive (frame count > 0, steady byte growth).
- The sample rate + encoding are known (from a text metadata frame, or confirmed via the Voximplant docs for the format `sendMediaTo` emits — typically 8 kHz mono 16-bit PCM for telephony).
- Echo check: only the caller's speech drives the byte flow (Ева isn't talking yet, so this is implicitly satisfied; re-confirm in M2).

If no frames arrive, STOP — the whole approach changes. Debug the Voximplant scenario / WS URL before any further task.

- [ ] **Step 5: Record findings and commit the probe**

Add a short comment block at the top of `stream-server.mjs` capturing the confirmed format, e.g. `// M0: Voximplant шлёт <encoding> @ <rate> Гц, бинарные фреймы ~<N> байт; метаданные: <...>`. This format drives every later task.

```bash
git add stream-server.mjs
git commit -m "feat: M0 WebSocket media probe; record Voximplant audio format"
```

---

## Task 4: M1 — streaming STT wrapper + offline harness

**Files:**
- Create: `stt-stream.mjs`
- Create: `stt-offline.mjs`

- [ ] **Step 1: Write `stt-stream.mjs` (v3 gRPC streaming STT wrapper)**

Use the sample rate confirmed in M0 as the default. The first request sends `session_options`; subsequent requests send audio `chunk`s; responses carry `partial`/`final` events.

```js
// Обёртка над Yandex SpeechKit v3 (gRPC, потоковое распознавание).
// openStt() возвращает { write(pcm), close() }. Колбэки: onPartial(text), onFinal(text), onError(err).
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

const API_KEY = process.env.YANDEX_API_KEY;
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = join(__dirname, "proto");

const pkgDef = protoLoader.loadSync("yandex/cloud/ai/stt/v3/stt_service.proto", {
  includeDirs: [PROTO_DIR],
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef);
const Recognizer = proto.yandex.cloud.ai.stt.v3.Recognizer;

export function openStt({ sampleRate = 8000, onPartial = () => {}, onFinal = () => {}, onError = () => {} }) {
  const client = new Recognizer(
    "stt.api.cloud.yandex.net:443",
    grpc.credentials.createSsl(),
  );
  const metadata = new grpc.Metadata();
  metadata.add("authorization", `Api-Key ${API_KEY}`);

  const stream = client.RecognizeStreaming(metadata);

  // Первое сообщение — настройки сессии: сырой PCM (LINEAR16), моно, частота из M0.
  stream.write({
    session_options: {
      recognition_model: {
        audio_format: {
          raw_audio: {
            audio_encoding: "LINEAR16_PCM",
            sample_rate_hertz: sampleRate,
            audio_channel_count: 1,
          },
        },
        text_normalization: { text_normalization: "TEXT_NORMALIZATION_ENABLED" },
        language_restriction: { restriction_type: "WHITELIST", language_code: ["ru-RU"] },
      },
    },
  });

  stream.on("data", (res) => {
    // События приходят в oneof "Event". Нас интересуют partial и final.
    if (res.partial?.alternatives?.length) {
      const text = res.partial.alternatives.map((a) => a.text).join(" ").trim();
      if (text) onPartial(text);
    }
    if (res.final?.alternatives?.length) {
      const text = res.final.alternatives.map((a) => a.text).join(" ").trim();
      if (text) onFinal(text);
    }
  });
  stream.on("error", onError);

  return {
    write(pcm) { stream.write({ chunk: { data: pcm } }); },
    close() { try { stream.end(); } catch {} },
  };
}
```

⚠️ Field names (`partial`/`final`/`session_options`/`raw_audio`) come from the v3 proto and `keepCase: true`. If M1 prints nothing, log the raw `res` object in `stream.on("data")` to see the actual event shape from your proto version, and adjust the field paths. This is exactly what the offline harness is for.

- [ ] **Step 2: Write `stt-offline.mjs` (M1 harness)**

Feeds a recorded PCM file through the wrapper. Requires a raw mono 16-bit little-endian PCM file at the M0 sample rate.

```js
// M1: офлайн-проверка потокового STT без телефонии.
// Нужен сырой PCM (моно, 16-бит LE) на частоте из M0.
// Запуск: node --env-file=.env stt-offline.mjs sample.pcm 8000
import { readFileSync } from "fs";
import { openStt } from "./stt-stream.mjs";

const file = process.argv[2] || "sample.pcm";
const sampleRate = Number(process.argv[3] || 8000);
const pcm = readFileSync(file);

console.log(`Отправляю ${pcm.length} байт PCM @ ${sampleRate} Гц…`);

const stt = openStt({
  sampleRate,
  onPartial: (t) => console.log("…частично:", t),
  onFinal: (t) => console.log("ИТОГ:", t),
  onError: (e) => console.error("STT ошибка:", e.message || e),
});

// Шлём кусками по 20 мс, имитируя реальный темп речи (важно для потокового распознавания).
const frameBytes = sampleRate * 0.02 * 2; // 20мс * 16бит моно
let off = 0;
const timer = setInterval(() => {
  if (off >= pcm.length) {
    clearInterval(timer);
    setTimeout(() => stt.close(), 2000); // дать время на финальный результат
    return;
  }
  stt.write(pcm.subarray(off, off + frameBytes));
  off += frameBytes;
}, 20);
```

- [ ] **Step 3: Get a test PCM sample**

If you have a short Russian phone-quality clip, convert it (ffmpeg) to raw PCM at the M0 rate:

```bash
ffmpeg -i sample.wav -f s16le -acodec pcm_s16le -ac 1 -ar 8000 sample.pcm
```

If you have no clip, generate one from the existing TTS at the M0 rate (note: synthesizing then recognizing your own audio is a valid loopback check):

```bash
node --env-file=.env -e "import('./speech.mjs').then(async m=>{const b=await m.synthesizePcm('Здравствуйте, делаете баннеры три на шесть метров?',8000);require('fs').writeFileSync('sample.pcm',b)})"
```

(The `synthesizePcm` helper lands in Task 5; if doing M1 first, instead convert any Russian `.wav` with the ffmpeg line above.)

- [ ] **Step 4: Run the offline harness (verified by reading output)**

Run: `node --env-file=.env stt-offline.mjs sample.pcm 8000`
Expected: live `…частично:` lines as audio streams, then an `ИТОГ:` line with the correct Russian transcription. If empty/garbled: confirm the PCM is raw mono 16-bit LE at the right rate, then log the raw `res` (Step 1 ⚠️) and fix field paths.
**Pass:** correct Russian transcription appears — the gRPC integration is proven, no telephony involved.

- [ ] **Step 5: Commit**

```bash
git add stt-stream.mjs stt-offline.mjs
git commit -m "feat: M1 Yandex v3 streaming STT wrapper + offline harness"
```

---

## Task 5: LPCM synthesis + sentence splitter

**Files:**
- Modify: `speech.mjs` (add `synthesizePcm`)
- Create: `sentences.mjs`
- Create: `sentences.test.mjs`

- [ ] **Step 1: Add `synthesizePcm` to `speech.mjs`**

Append after the existing `synthesize` function (do not modify `synthesize`):

```js
// Синтез в сыром PCM (LINEAR16) для стриминга обратно в Voximplant без перекодирования.
// Yandex TTS v1 поддерживает format=lpcm с sampleRateHertz 8000/16000/48000.
export async function synthesizePcm(text, sampleRateHertz = 8000, voice = "alena") {
  const body = new URLSearchParams({
    text, lang: "ru-RU", voice, emotion: "good", speed: "1.0",
    format: "lpcm", sampleRateHertz: String(sampleRateHertz), folderId: FOLDER_ID,
  });
  const res = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: { Authorization: `Api-Key ${API_KEY}` },
    body,
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
```

- [ ] **Step 2: Write the sentence-splitter test (failing)**

```js
// node --test sentences.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { splitSentences } from "./sentences.mjs";

test("splits on sentence punctuation", () => {
  assert.deepStrictEqual(
    splitSentences("Делаем баннеры. Цену рассчитает менеджер. Оформить заявку?"),
    ["Делаем баннеры.", "Цену рассчитает менеджер.", "Оформить заявку?"],
  );
});

test("returns whole text when no terminal punctuation", () => {
  assert.deepStrictEqual(splitSentences("Делаем баннеры"), ["Делаем баннеры"]);
});

test("ignores empty trailing fragments", () => {
  assert.deepStrictEqual(splitSentences("Да.  "), ["Да."]);
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `node --test sentences.test.mjs`
Expected: FAIL — `Cannot find module './sentences.mjs'`.

- [ ] **Step 4: Implement `sentences.mjs`**

```js
// Делит ответ на короткие предложения, чтобы синтезировать и отдавать их по очереди
// (Ева начинает говорить после первого предложения — это и есть снижение задержки).
export function splitSentences(text) {
  return (text.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/gu) || [])
    .map((s) => s.trim())
    .filter(Boolean);
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `node --test sentences.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 6: Smoke-check `synthesizePcm` produces audio**

Run: `node --env-file=.env -e "import('./speech.mjs').then(async m=>{const b=await m.synthesizePcm('Проверка синтеза.',8000);console.log('PCM байт:',b.length)})"`
Expected: prints a non-zero byte count (raw PCM, so roughly `rate * seconds * 2`).

- [ ] **Step 7: Commit**

```bash
git add speech.mjs sentences.mjs sentences.test.mjs
git commit -m "feat: LPCM synthesis + sentence splitter for incremental TTS"
```

---

## Task 6: Paced playback

**Files:**
- Create: `playback.mjs`
- Create: `playback.test.mjs`

- [ ] **Step 1: Write the paced-player test (failing)**

Drives the player with a fake clock-free check: enqueue 3 frames worth, assert frames are emitted in order and `stop()` halts further emission.

```js
// node --test playback.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { PacedPlayer } from "./playback.mjs";

test("emits fixed-size frames in order, then drains", async () => {
  const sent = [];
  const p = new PacedPlayer((f) => sent.push(f.length), { sampleRate: 8000, frameMs: 20 });
  p.enqueue(Buffer.alloc(320 * 3)); // ровно 3 фрейма по 320 байт (20мс@8к)
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(sent, [320, 320, 320]);
});

test("stop() halts emission and clears the queue", async () => {
  const sent = [];
  const p = new PacedPlayer((f) => sent.push(f.length), { sampleRate: 8000, frameMs: 20 });
  p.enqueue(Buffer.alloc(320 * 100));
  await new Promise((r) => setTimeout(r, 50)); // отдать пару фреймов
  p.stop();
  const count = sent.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(sent.length, count); // после stop ничего нового
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test playback.test.mjs`
Expected: FAIL — `Cannot find module './playback.mjs'`.

- [ ] **Step 3: Implement `playback.mjs`**

```js
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
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test playback.test.mjs`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add playback.mjs playback.test.mjs
git commit -m "feat: paced PCM player (frame-by-frame, instant stop for barge-in)"
```

---

## Task 7: M2 — full streaming session (no barge-in yet)

**Files:**
- Modify: `stream-server.mjs` (replace the probe with the session loop)

- [ ] **Step 1: Replace `stream-server.mjs` with the session loop**

Keep the M0 findings comment at the top. This wires STT → `ask()` → `synthesizePcm` (per sentence) → `PacedPlayer` → WS. Greeting is spoken on connect. Barge-in is intentionally NOT here yet — finals only.

```js
// M0: <вставить формат из Task 3 Step 5: кодек, частота, размер фрейма>
// Стриминговый сервер. Сессия на звонок: STT → YandexGPT → TTS по предложениям → плеер.
// Запуск: node --env-file=.env stream-server.mjs
import { WebSocketServer } from "ws";
import { ask, synthesizePcm } from "./speech.mjs";
import { SYSTEM } from "./prompt.mjs";
import { splitSentences } from "./sentences.mjs";
import { PacedPlayer } from "./playback.mjs";
import { openStt } from "./stt-stream.mjs";

const PORT = 3001;
const SAMPLE_RATE = 8000; // ⚠️ выставить по M0
const GREETING = "Здравствуйте! Это типография Альфа Принт, меня зовут Ева. Чем могу помочь?";

const wss = new WebSocketServer({ port: PORT, path: "/media" });

wss.on("connection", (ws) => {
  const callId = "stream-" + Date.now();
  const history = [{ role: "system", text: SYSTEM }];
  const player = new PacedPlayer((frame) => ws.send(frame), { sampleRate: SAMPLE_RATE, frameMs: 20 });
  let state = "SPEAKING";
  console.log(`[${callId}] подключился`);

  async function speak(text) {
    state = "SPEAKING";
    for (const sentence of splitSentences(text)) {
      try {
        const pcm = await synthesizePcm(sentence, SAMPLE_RATE);
        player.enqueue(pcm);
      } catch (e) {
        console.error(`[${callId}] TTS пропуск предложения:`, e.message);
      }
    }
  }

  async function onFinal(text) {
    if (!text) return;
    console.log(`[${callId}] клиент: ${text}`);
    history.push({ role: "user", text });
    state = "THINKING";
    let reply;
    try {
      reply = await ask(history);
    } catch (e) {
      console.error(`[${callId}] LLM ошибка:`, e.message);
      await speak("Извините, техническая ошибка, повторите пожалуйста.");
      state = "LISTENING";
      return;
    }
    history.push({ role: "assistant", text: reply });
    console.log(`[${callId}] Ева: ${reply}`);
    await speak(reply);
    state = "LISTENING";
  }

  const stt = openStt({
    sampleRate: SAMPLE_RATE,
    onPartial: (t) => { if (state === "LISTENING") console.log(`[${callId}] …${t}`); },
    onFinal,
    onError: (e) => console.error(`[${callId}] STT ошибка:`, e.message || e),
  });

  // Приветствие сразу после подключения.
  speak(GREETING).then(() => { state = "LISTENING"; });

  ws.on("message", (data, isBinary) => {
    if (isBinary) stt.write(data);            // аудио абонента → STT (всегда)
    // текстовые фреймы (метаданные) игнорируем в M2
  });
  ws.on("close", () => {
    console.log(`[${callId}] отключился`);
    stt.close();
    player.stop();
  });
  ws.on("error", (e) => console.error(`[${callId}] ws ошибка:`, e.message));
});

console.log(`Стриминговый сервер слушает ws://localhost:${PORT}/media`);
```

⚠️ Outgoing audio: `ws.send(frame)` sends raw PCM binary to Voximplant. If M0 showed Voximplant expects a different outbound framing (e.g. a JSON envelope or base64), wrap `frame` accordingly in the `sendFrame` callback. Adjust `SAMPLE_RATE` to the M0 value.

- [ ] **Step 2: Syntax-check and boot**

Run: `node --check stream-server.mjs`
Expected: exit 0.
Run: `node --env-file=.env stream-server.mjs`
Expected: prints `Стриминговый сервер слушает ws://localhost:3001/media`.

- [ ] **Step 3: Live call (user-verified)**

With ngrok pointing at 3001 and the `inbound-stream` scenario's `WS_URL` set to the current `wss://…/media`, call via phone.voximplant.com.
**Pass criteria (human-judged):**
- Ева greets on connect, in Alena's voice, intelligibly (confirms outbound PCM format + rate are right).
- You speak; the server logs `клиент: <your words>` (confirms inbound STT end-to-end through telephony) and Ева answers on-topic, starting to talk shortly after your first sentence finishes.
- Echo re-check: Ева does not transcribe her own speech (server shows no `клиент:` lines while only she is talking).

If Ева's audio is noise/wrong speed → outbound format/rate mismatch (Step 1 ⚠️). If `клиент:` never logs → inbound format mismatch vs M1 assumptions.

- [ ] **Step 4: Commit**

```bash
git add stream-server.mjs
git commit -m "feat: M2 full streaming session loop (greet, STT, LLM, sentence TTS)"
```

---

## Task 8: M3 — smart barge-in

**Files:**
- Create: `bargein.mjs`
- Create: `bargein.test.mjs`
- Modify: `stream-server.mjs` (use the filter during SPEAKING)

- [ ] **Step 1: Write the barge-in filter test (failing)**

```js
// node --test bargein.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { isSubstantive } from "./bargein.mjs";

test("backchannels do not count as interruption", () => {
  for (const w of ["угу", "ага", "да", "да-да", "мгм", "Ага."]) {
    assert.strictEqual(isSubstantive(w), false, `ожидалось false для "${w}"`);
  }
});

test("substantive speech counts as interruption", () => {
  assert.strictEqual(isSubstantive("подождите а сколько стоит"), true);
  assert.strictEqual(isSubstantive("нет я хотел баннер"), true);
});

test("empty or whitespace is not substantive", () => {
  assert.strictEqual(isSubstantive("  "), false);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test bargein.test.mjs`
Expected: FAIL — `Cannot find module './bargein.mjs'`.

- [ ] **Step 3: Implement `bargein.mjs`**

```js
// Эвристика «настоящего» перебивания: игнорируем короткие поддакивания (бэкчэннелы),
// перебиваем только на содержательной речи. Пороги — первое разумное приближение,
// уточняются после прослушивания реальных звонков (см. spec, «Backchannel thresholds»).
const BACKCHANNELS = new Set(["угу", "ага", "да", "дада", "да-да", "мгм", "ммм", "ну", "окей", "ок", "хорошо"]);

export function isSubstantive(partial) {
  const text = (partial || "").trim().toLowerCase();
  if (!text) return false;
  const words = text.split(/\s+/);
  // Одно короткое слово-поддакивание — не перебивание.
  if (words.length === 1 && BACKCHANNELS.has(words[0].replace(/[.,!?…]/g, ""))) return false;
  // Иначе содержательно, если набралось хотя бы 2 слова или достаточно символов.
  return words.length >= 2 || text.replace(/[^\p{L}]/gu, "").length >= 5;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test bargein.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 5: Wire barge-in into `stream-server.mjs`**

Add the import near the other imports:

```js
import { isSubstantive } from "./bargein.mjs";
```

Replace the `onPartial` handler in the `openStt({...})` call with one that interrupts during SPEAKING:

```js
    onPartial: (t) => {
      if (state === "LISTENING") { console.log(`[${callId}] …${t}`); return; }
      if (state === "SPEAKING" && isSubstantive(t)) {
        console.log(`[${callId}] BARGE-IN на: "${t}" — Ева замолкает`);
        player.stop();           // мгновенно обрываем воспроизведение и чистим очередь
        state = "LISTENING";     // дальше этот же STT-поток уже распознаёт реплику клиента
      }
    },
```

⚠️ `speak()` enqueues all sentences up front, so `player.stop()` must drop the *whole* queued reply — which `PacedPlayer.stop()` already does (clears `queue` + timer). The in-flight utterance keeps streaming to the same STT session and surfaces as the next `onFinal`, so no caller audio is lost.

- [ ] **Step 6: Syntax-check and boot**

Run: `node --check stream-server.mjs`
Expected: exit 0.
Run: `node --env-file=.env stream-server.mjs`
Expected: server boots as before.

- [ ] **Step 7: Live call (user-verified)**

Call via phone.voximplant.com.
**Pass criteria (human-judged):**
- Interrupt Ева mid-sentence with a real phrase ("подождите, а сколько…") → she stops within a beat and the server logs `BARGE-IN на: …`, then answers your new turn.
- Say a backchannel ("угу") while she talks → she keeps going; no `BARGE-IN` log.

If she cuts off on backchannels → tighten `bargein.mjs` thresholds. If she never stops → confirm partials arrive during SPEAKING (log them) and that `state` is `SPEAKING` when expected.

- [ ] **Step 8: Commit**

```bash
git add bargein.mjs bargein.test.mjs stream-server.mjs
git commit -m "feat: M3 smart barge-in (interrupt on substantive speech, ignore backchannels)"
```

---

## Task 9: Documentation — README scenario + CLAUDE.md + STT reconnect note

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `stream-server.mjs` (STT stream reconnect for long calls)

- [ ] **Step 1: Add STT reconnect handling for long calls**

Yandex streaming sessions have a max duration; on a long call the STT stream closes. In `stream-server.mjs`, make the STT openable lazily so it can be re-created. Wrap the `openStt` call in a factory and re-open on error:

```js
  let stt;
  function startStt() {
    stt = openStt({
      sampleRate: SAMPLE_RATE,
      onPartial: (t) => {
        if (state === "LISTENING") { console.log(`[${callId}] …${t}`); return; }
        if (state === "SPEAKING" && isSubstantive(t)) {
          console.log(`[${callId}] BARGE-IN на: "${t}" — Ева замолкает`);
          player.stop();
          state = "LISTENING";
        }
      },
      onFinal,
      onError: (e) => {
        console.error(`[${callId}] STT ошибка, переоткрываю поток:`, e.message || e);
        try { startStt(); } catch (re) { console.error(`[${callId}] переоткрытие не удалось:`, re.message); }
      },
    });
  }
  startStt();
```

Replace the previous single `const stt = openStt({...})` block with the factory above, and ensure `ws.on("message")` calls `stt.write(data)` (it reads the current `stt`).

Run: `node --check stream-server.mjs`
Expected: exit 0.

- [ ] **Step 2: Add the streaming scenario to `README.md`**

After the existing "The Voximplant `inbound` scenario" section, add a new section "The Voximplant `inbound-stream` scenario (streaming spike)" containing the final scenario from Task 3 Step 3 (with the `<WSS-URL>` placeholder note and a line: "streams call audio to the backend over WebSocket; the backend does STT/LLM/TTS and barge-in"). Note that it is a separate scenario from `inbound`, and that ngrok tunnels WebSockets.

- [ ] **Step 3: Update `CLAUDE.md` code map and commands**

In the Code map, add:
- `stream-server.mjs` — streaming WS server (`ws://…/media`, port 3001): per-call session, v3 streaming STT, sentence TTS, barge-in.
- `stt-stream.mjs`, `playback.mjs`, `sentences.mjs`, `bargein.mjs`, `prompt.mjs` — one-line each.

In Commands, add:
```bash
node --env-file=.env stream-server.mjs   # streaming backend (port 3001)
node --env-file=.env stt-offline.mjs sample.pcm 8000   # offline STT check
ngrok http 3001                          # tunnel the streaming WS
```
Note the streaming path is the spike (roadmap item 5), parallel to the turn-based `/reply`.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md stream-server.mjs
git commit -m "docs: streaming scenario + code map; STT reconnect for long calls"
```

---

## Verification Summary

- **Offline (agent-runnable, shown as output):** `node --test sentences.test.mjs`, `node --test playback.test.mjs`, `node --test bargein.test.mjs`, and `node --env-file=.env stt-offline.mjs sample.pcm 8000` (M1).
- **Regression:** `node verify-eva.mjs` against the turn-based backend (Task 1) — the refactor must not change Ева's behavior.
- **Live, user-verified (cannot be claimed working without a real call):** M0 (probe — audio arrives + format), M2 (greet/answer loop), M3 (barge-in vs backchannels). Each has explicit human-judged pass criteria above.

## Out of Scope

Streaming TTS (v3 gRPC) — follow-up after the spike. Order intake → CRM/Sheets (item 4), KB/RAG (item 3 remainder), permanent backend (item 6), real number (item 7), production extras (item 8). Tuning barge-in thresholds beyond the first guess.
