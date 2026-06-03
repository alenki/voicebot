# voicebot — voice assistant for a printing house

A voice assistant that answers inbound calls for an advertising agency / printing
house. It greets the caller, answers questions about services (business cards,
flyers, banners, printing, design) and helps place an order. Language: **Russian**.
Market: **Russia**. Target voice: a pleasant female voice (Yandex SpeechKit `alena`).

> **Status — turn-based bot is assembled and wired end to end.**
> All three building blocks (voice / hearing / brain) are verified individually and
> connected through telephony. A full call goes: greet → listen → answer → listen…
>
> **Live call verified** with the Yandex **Alena** voice
> (`VoiceList.Yandex.Neural.ru_RU_alena`) — Ева greets, answers, and speaks in Alena
> on a real inbound call (Roadmap items 1–2 done).
>
> **Next:** make the bot genuinely useful — knowledge base / FAQ and structured order
> intake (items 3–4 of the [Roadmap](#roadmap)).

---

## How it works

### Current pipeline (turn-based, what runs today)

```
Caller
  → Voximplant (answers the call)
  → Voximplant built-in ASR  (Google ru-RU profile)   speech → text
  → POST /reply  →  our Node backend
                      → YandexGPT (yandexgpt-lite)     text → reply
  → Voximplant TTS player speaks the reply             text → speech
  → listen again …
```

The bot speaks and listens **in turns** (one at a time). All speech recognition and
synthesis during a call happen **inside Voximplant**; our backend only runs the
"brain" (`/reply` → YandexGPT).

### Streaming pipeline (spike — built, offline-tested, parallel to the live path)

```
Caller → Voximplant → Backend (Node orchestrator)
   → Yandex STT → YandexGPT → Yandex TTS
   → back through Voximplant → Caller
```

A parallel streaming path is now built: `stream-server.mjs` (WebSocket on port `3001`)
runs continuous v3 gRPC STT → streaming YandexGPT → sentence-by-sentence TTS over
Voximplant's media protocol, with **smart barge-in** — the caller can interrupt Ева
mid-sentence, but short backchannels ("угу", "да-да") don't. It is offline-tested
(unit tests + replay harness) **and verified live on a real call** — barge-in works; it
is **not the production path yet** — the turn-based pipeline above is what runs live. Our
own STT/TTS in `speech.mjs` is used here, not in the live turn-based call.

## Tech stack (and why)

| Concern | Choice | Why |
|---|---|---|
| Telephony | **Voximplant** — JS (VoxEngine) scenarios in the cloud | Programmable telephony that fits our JS/Node stack |
| STT + TTS | **Yandex Cloud SpeechKit** | One account, one bill, low latency, no certificate hassle |
| LLM ("brain") | **YandexGPT** (`yandexgpt-lite`) | Same Yandex account as speech; low latency |
| Voice | Yandex SpeechKit **`alena`** (emotion `good`) | Pleasant Russian female voice |
| Backend | **Node.js + Express**, local, exposed via **ngrok** | Simple orchestrator; ngrok gives a public URL for Voximplant |

> GigaChat was the original plan for the brain, but its developer portal was down
> (workspace loading error), so we moved to YandexGPT. GigaChat is kept as a backup.

## Repository layout

| Path | What it is |
|---|---|
| `speech.mjs` | Core library: `synthesize()` (TTS), `recognize()` (STT), `ask()` (YandexGPT). Tested; **not yet used in live calls.** |
| `server.mjs` | Express service on port `3000`. `POST /reply` (per-call dialog memory) and `POST /end`. Holds the system prompt. |
| `test.mjs` | Local smoke test: `ask` → `synthesize` → write `reply.ogg` → `recognize` (full round trip). |
| `reply.ogg` | Generated audio artifact from `test.mjs` (a synthesized sample). |
| `.env` | `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`. **Secrets — gitignored, never commit.** |
| `package.json` | Declares the `express` dependency. |
| `ubuntu commands.txt` | Scratch notes: WSL `cd` path and `curl` test commands. |
| Voximplant `inbound` scenario | **Lives in the Voximplant cloud, not in this repo.** Full source is in [The Voximplant scenario](#the-voximplant-inbound-scenario) below. |

## Prerequisites

- **Node.js ≥ 20.6** (for the `--env-file` flag used below; the version differs per
  machine — e.g. `v22.21.0` on the Windows box).
- A **Yandex Cloud** account with a service account, API key, folder ID, and the
  SpeechKit/YandexGPT roles (see [Accounts & resources](#accounts--resources)).
- A **Voximplant** account with the `voicebot` application, an `inbound` scenario,
  a routing rule, and a SIP user for testing.
- An **ngrok** account (authtoken linked).
- **VPN off** while running — see [Gotchas](#gotchas).

Create `.env` in the project root:

```
YANDEX_API_KEY=<service-account API key>
YANDEX_FOLDER_ID=<folder ID>
```

Install dependencies:

```bash
npm install
```

## Run & test a live call

The live call needs **two terminals running at the same time**:

1. **Terminal 1 — backend:**
   ```bash
   node --env-file=.env server.mjs
   # → "Backend слушает http://localhost:3000"
   ```
2. **Terminal 2 — public tunnel:**
   ```bash
   ngrok http 3000
   # copy the https URL from the "Forwarding" line
   ```
3. Paste that ngrok URL into **`BACKEND`** and **`BACKEND_END`** in the Voximplant
   `inbound` scenario, and **save**. On ngrok free the URL changes on every restart,
   so this must match the current tunnel.
4. Open **phone.voximplant.com**, log in as the SIP user, dial any digits, and talk
   to the bot.

**Logs:** the server terminal prints `client / bot` lines; the Voximplant call
history shows the `Logger.write` lines from the scenario.

**Quick backend-only smoke test** (no telephony):

```bash
# round-trip ask → synthesize → recognize, writes reply.ogg
node --env-file=.env test.mjs

# or hit the HTTP endpoint directly
curl -s -X POST http://localhost:3000/reply \
  -H "Content-Type: application/json" \
  -d '{"callId":"test1","text":"Здравствуйте! Делаете баннеры три на шесть метров?"}'
```

## Backend API

| Method & path | Body | Response | Notes |
|---|---|---|---|
| `POST /reply` | `{ "callId": string, "text": string }` | `{ "reply": string }` | Keeps per-`callId` dialog history in memory; `400` if `callId`/`text` missing. |
| `POST /end` | `{ "callId": string }` | `{ "ok": true }` | Drops that call's history from memory. |

Dialog memory lives in an in-process `Map` — it is **lost on restart** and not
shared across processes.

## The Voximplant `inbound` scenario

This code is **not in the repo** (it runs in Voximplant). Keep it here as the source
of truth. Update `BACKEND` / `BACKEND_END` to the current ngrok URL after each tunnel
restart.

```js
require(Modules.ASR);
require(Modules.Player);

const BACKEND = "https://<CURRENT-NGROK>.ngrok-free.dev/reply";
const BACKEND_END = "https://<CURRENT-NGROK>.ngrok-free.dev/end";
const VOICE = VoiceList.Yandex.Neural.ru_RU_alena; // Yandex Alena (neural, premium voice)
const HEADERS = ["Content-Type: application/json", "ngrok-skip-browser-warning: 1"];

let call;
const callId = "vox-" + Date.now() + "-" + Math.floor(Math.random() * 1000);

VoxEngine.addEventListener(AppEvents.CallAlerting, (e) => {
  call = e.call;
  call.answer();
  call.addEventListener(CallEvents.Connected, onConnected);
  call.addEventListener(CallEvents.Disconnected, onDisconnected);
});

function onConnected() {
  say("Здравствуйте! Это типография Альфа Принт, меня зовут Ева. Чем могу помочь?", listen);
}

function say(text, done) {
  const player = VoxEngine.createTTSPlayer(text, { language: VOICE, progressivePlayback: true });
  player.sendMediaTo(call);
  player.addEventListener(PlayerEvents.PlaybackFinished, () => { if (done) done(); });
}

function listen() {
  const asr = VoxEngine.createASR({ profile: ASRProfileList.Google.ru_RU, singleUtterance: true });
  call.sendMediaTo(asr);
  asr.addEventListener(ASREvents.Result, async (e) => {
    call.stopMediaTo(asr);
    const text = (e.text || "").trim();
    Logger.write("Клиент сказал: " + text);
    if (!text) { say("Извините, я вас не расслышал. Повторите, пожалуйста.", listen); return; }
    try {
      const res = await Net.httpRequestAsync(BACKEND, {
        method: "POST", headers: HEADERS,
        postData: JSON.stringify({ callId, text }),
      });
      if (res.code === 200) {
        const reply = JSON.parse(res.text).reply;
        Logger.write("Бот отвечает: " + reply);
        say(reply, listen);
      } else {
        Logger.write("Backend error " + res.code + ": " + res.text);
        say("Извините, техническая ошибка. Попробуйте ещё раз.", listen);
      }
    } catch (err) {
      Logger.write("Request failed: " + err);
      say("Извините, связь прервалась. Повторите, пожалуйста.", listen);
    }
  });
}

async function onDisconnected() {
  try {
    await Net.httpRequestAsync(BACKEND_END, { method: "POST", headers: HEADERS, postData: JSON.stringify({ callId }) });
  } catch (e) {}
  VoxEngine.terminate();
}
```

## Gotchas

- **VPN breaks Yandex Cloud.** Running the backend with a VPN on causes
  `ConnectTimeoutError`. Turn the VPN off, or whitelist `*.api.cloud.yandex.net`.
- **ngrok free rotates the URL** on every restart — re-paste it into the Voximplant
  scenario each time.
- **Yandex auth** uses the header `Authorization: Api-Key <key>` (not `Bearer`) and
  requires the folder ID.
- **SpeechKit v1 is for short phrases:** synthesis ≤ ~250 characters, synchronous
  recognition ≤ ~30 s. Long / live audio needs the streaming modes.
- **Russian text in the Windows `cmd` console** breaks (cp1251). Use UTF-8 files or
  run from WSL / Linux / the macOS terminal (no issue there).
- **Never commit secrets** (`.env`, tokens, passwords). `.env` is gitignored.

## Roadmap

In priority order:

1. ~~**Test the live call**~~ — ✅ done; verified on a real inbound call.
2. ~~**Switch the voice to Alena.**~~ — ✅ done; the `inbound` scenario uses
   `VoiceList.Yandex.Neural.ru_RU_alena` (the canonical copy below matches).
3. **Make the bot genuinely useful:**
   - Tune the system prompt (less "I'll pass it to a manager", more concrete answers
     that move toward placing an order).
   - Knowledge base / FAQ via RAG so it answers with real services, timelines, and
     ballpark prices instead of deferring to a manager.
4. **Order intake (the key business task):** extract a structured order from the
   conversation (what to print, quantity, format, material, deadline, contact),
   read each field back and confirm it, then write the order to a CRM or Google Sheets.
5. **Dialogue quality (streaming spike):** ~~**barge-in**~~ — ✅ implemented and
   **verified live** on a real call (`bargein.mjs` + `stream-server.mjs`; the caller
   interrupts Ева, backchannels don't). Remaining: silence timeouts, lower latency, and
   promoting the streaming pipeline to the production path in place of the turn-based
   approach.
6. **Permanent backend:** host on a Yandex Cloud VM instead of ngrok — a stable
   address that runs without a laptop open.
7. **Real inbound number:** rent a number in Voximplant and move the accounts to a
   legal entity (for production billing and a Russian number).
8. **Production extras:** call recording (with caller notice), analytics, monitoring,
   and error / edge-case handling.

## Cost estimate

Rough per-component estimate: **~2.5–5 ₽ per minute** of conversation
(telephony + STT + TTS + LLM), plus fixed **~420 ₽/month** for a number and
**~2 000 ₽/month** for a server. The biggest hidden cost with a custom stack is
**development and maintenance time.**

## Accounts & resources

No secrets here — values live in `.env` and the cloud consoles.

- **Yandex Cloud:** cloud + folder `default`; service account `voicebot`; API key
  (in `.env`); folder ID (in `.env`); roles `ai.speechkit-tts.user`,
  `ai.speechkit-stt.user`, `ai.languageModels.user`.
- **Voximplant:** account; application `voicebot`
  (domain `voicebot.<account>.voximplant.com`); `inbound` scenario; routing rule `.*`;
  SIP user for testing via phone.voximplant.com.
- **ngrok:** account + linked authtoken; temporary public URL.
- **Dev environment:** developed on two machines interchangeably, tracked on GitHub:
  - **Windows 11 + WSL (Ubuntu)** — project at `E:\Desktop\PC\WORK\Web Development\voicebot`
    (`/mnt/e/Desktop/PC/WORK/Web Development/voicebot` in WSL), Node `v22.21.0`.
  - **macOS** — project at `~/voicebot` (per the original handover note).
