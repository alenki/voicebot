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
                      → Alice AI LLM (aliceai-llm)     text → reply
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
| LLM ("brain") | **Alice AI LLM** (`aliceai-llm` by default; `LLM_MODEL=yandexgpt` to roll back) | Same Yandex account/API as speech; benchmarked 2026-07-05 (`bench-llm.mjs`): smarter than `yandexgpt` pro AND ~250-400 ms faster to first token (~610-770 ms vs ~850-1180 ms). Earlier, lite proved too weak for the persona (spelled names letter-by-letter, double questions, verbatim repeats) |
| Voice | Yandex SpeechKit **`marina`** (role `friendly`; ex-`alena`) | Yandex's newest-gen premium Russian female voice that still works over the v1 REST path |
| Backend | **Node.js + Express**, local, exposed via **ngrok** | Simple orchestrator; ngrok gives a public URL for Voximplant |

> GigaChat was the original plan for the brain, but its developer portal was down
> (workspace loading error), so we moved to YandexGPT. GigaChat is kept as a backup.

## Repository layout

| Path | What it is |
|---|---|
| `speech.mjs` | Core library: `synthesize()` (TTS), `recognize()` (STT), `ask()` (YandexGPT). Tested; **not yet used in live calls.** |
| `server.mjs` | Express service on port `3000`. `POST /reply` (per-call dialog memory) and `POST /end` (extracts the order and **delivers the lead to Telegram**). Optional `REPLY_SECRET` gate (header `X-Backend-Token`). |
| `dialog-store.mjs` | Per-call history store for `server.mjs`: TTL sweep for calls whose `/end` never arrived, lead finalization (extractOrder → Telegram) on end/TTL/shutdown. |
| `leads.ndjson` | Local fallback journal: every lead that could NOT be delivered to Telegram is appended here (gitignored). |
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
| `POST /end` | `{ "callId": string }` | `{ "ok": true }` | Finalizes the call: extracts the order from the dialog (YandexGPT) and sends the lead to the owner's Telegram, then drops the history. Calls that never get `/end` are finalized by a TTL sweep (`DIALOG_TTL_MS`, default 30 min). |

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
// Общий секрет с бэкендом (REPLY_SECRET в .env). Пусто = без авторизации (бэкенд
// предупредит об этом на старте). ngrok-URL публичен — для беты секрет обязателен.
const BACKEND_TOKEN = "";
const VOICE = VoiceList.Yandex.Neural.ru_RU_marina; // Yandex Marina (premium, новее alena)
// Просодия Евы. Без ttsOptions Voximplant синтезирует с НЕЙТРАЛЬНОЙ ролью и темпом
// по умолчанию. Для Yandex ru_RU поддерживаются emotion и speed ("0.1".."3.0");
// pitch/volume в Voximplant доступны ТОЛЬКО для Google — не задаём. Роли marina:
// neutral|whisper|friendly (good у неё НЕТ). friendly = тёплый тон, 0.95 = чуть
// спокойнее на телефоне. Совпадает с speech.mjs. НЕ ПРОВЕРЕНО живым звонком: если
// Voximplant отвергнет emotion:"friendly" (тишина/ошибка TTS в логе сценария) —
// убрать поле emotion (marina по умолчанию neutral) или откатить голос на
// VoiceList.Yandex.Neural.ru_RU_alena + emotion:"good".
const TTS_OPTIONS = { emotion: "friendly", speed: "0.95" };
const HEADERS = ["Content-Type: application/json", "ngrok-skip-browser-warning: 1"];
if (BACKEND_TOKEN) HEADERS.push("X-Backend-Token: " + BACKEND_TOKEN);
// Молчание абонента: ASR с singleUtterance может вообще не прислать Result — без
// таймера звонок висел в мёртвой тишине бесконечно.
const ASR_TIMEOUT_MS = 12000;
// Фолбэк при лежащем бэкенде: живой номер, чтобы звонок не пропал зря.
const FALLBACK_PHONE = "плюс семь, девятьсот шестьдесят семь, четыреста двадцать пять, семьдесят девять, семьдесят девять";

let call;
let silentRounds = 0; // подряд «ничего не расслышали»
let failRounds = 0;   // подряд ошибок бэкенда
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
  const player = VoxEngine.createTTSPlayer(text, {
    language: VOICE,
    progressivePlayback: true,
    ttsOptions: TTS_OPTIONS, // тёплая роль friendly + темп 0.95 для marina
  });
  player.sendMediaTo(call);
  let called = false;
  const finish = () => { if (called) return; called = true; clearTimeout(guard); if (done) done(); };
  // Страховка: если TTS упал и PlaybackFinished не пришёл — не зависаем навсегда.
  const guard = setTimeout(finish, 4000 + text.length * 120);
  player.addEventListener(PlayerEvents.PlaybackFinished, finish);
}

function listen() {
  const asr = VoxEngine.createASR({ profile: ASRProfileList.Google.ru_RU, singleUtterance: true });
  let finished = false;
  const finish = (text) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    call.stopMediaTo(asr);
    onHeard(text);
  };
  const timer = setTimeout(() => finish(""), ASR_TIMEOUT_MS); // молчание — Result может не прийти
  call.sendMediaTo(asr);
  asr.addEventListener(ASREvents.Result, (e) => finish((e.text || "").trim()));
}

async function onHeard(text) {
  Logger.write("Клиент сказал: " + text);
  if (!text) {
    silentRounds++;
    if (silentRounds >= 3) { hangup("Плохо вас слышно, к сожалению. Наберите нас ещё раз, хорошо? Всего доброго!"); return; }
    say(silentRounds === 1 ? "Алло, вы меня слышите?" : "Простите, вас совсем не слышно. Повторите, пожалуйста.", listen);
    return;
  }
  silentRounds = 0;
  const reply = await askBackend(text);
  if (reply === null) {
    failRounds++;
    if (failRounds >= 2) {
      hangup("Простите, у нас неполадки со связью. Запишите, пожалуйста, номер: " + FALLBACK_PHONE + ". Позвоните или напишите в ВотсАп — всё посчитаем. Всего доброго!");
      return;
    }
    say("Извините, я на секунду отвлеклась. Повторите, пожалуйста.", listen);
    return;
  }
  failRounds = 0;
  Logger.write("Бот отвечает: " + reply);
  say(reply, listen);
}

// Один быстрый повтор на транзиентные 5xx/обрывы ngrok; null = бэкенд недоступен.
async function askBackend(text) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await Net.httpRequestAsync(BACKEND, {
        method: "POST", headers: HEADERS,
        postData: JSON.stringify({ callId, text }),
      });
      if (res.code === 200) return JSON.parse(res.text).reply;
      Logger.write("Backend error " + res.code + " (attempt " + attempt + "): " + res.text);
    } catch (err) {
      Logger.write("Request failed (attempt " + attempt + "): " + err);
    }
  }
  return null;
}

function hangup(text) {
  say(text, async () => {
    await postEnd();
    VoxEngine.terminate();
  });
}

async function postEnd() {
  try {
    await Net.httpRequestAsync(BACKEND_END, { method: "POST", headers: HEADERS, postData: JSON.stringify({ callId }) });
  } catch (e) {}
}

async function onDisconnected() {
  await postEnd(); // бэкенд по /end извлекает заявку и шлёт её менеджеру в Telegram
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
3. **Make the bot genuinely useful:** largely done — the persona prompt drives to a
   captured lead, answers address/hours/payment directly from FACTS, never invents
   prices; the dialog brain is `aliceai-llm` (Yandex's newest flagship — smarter and
   faster than `yandexgpt` pro, measured 2026-07-05). Remaining: richer FAQ facts
   from the owner (materials, typical формats) as they arrive.
4. **Order intake (the key business task):** ✅ done for Telegram — BOTH paths now
   extract a structured order after the call (what/qty/format/material/deadline/
   name/phone, phone normalized to digits) and deliver it to the owner's Telegram,
   with a local `leads.ndjson` fallback journal. CRM / Google Sheets — later.
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



Доступ к серверу

Логин: root
Пароль: n4GW4SDRMzDgrfsD


Доступ к DNS

Адрес: https://dnsadmin.hosting.reg.ru/manager/ispmgr
Логин: ce107292771
Пароль: W!a57IOxnneKHJ6
DNS: ns5.hosting.reg.ru • ns6.hosting.reg.ru 