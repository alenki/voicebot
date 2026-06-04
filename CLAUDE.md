# CLAUDE.md

Operational guide for working in this repo. See `README.md` for the full project
write-up; this file is the short, actionable version.

## What this is

A Russian-language voice assistant that answers inbound calls for a printing house /
ad agency (greets, answers service questions, helps place orders). Telephony is
**Voximplant**; speech + brain are **Yandex Cloud** (SpeechKit STT/TTS + YandexGPT).
The Node backend is just the "brain" orchestrator behind `POST /reply`.

**Two pipelines exist — don't confuse them:**
- **Live today (turn-based):** Voximplant answers, does ASR itself (Google ru-RU),
  calls our `/reply` (→ YandexGPT), and speaks the reply with its own TTS player.
  Speak/listen alternate.
- **Spike (streaming):** a parallel path (`stream-server.mjs`, WS port 3001) over
  Voximplant's WebSocket media protocol — our own v3 gRPC STT + YandexGPT + LPCM TTS with
  **smart barge-in** (caller interrupts Ева; backchannels don't). Offline-tested **and
  verified live** on a real call (barge-in works). Not the production path yet (turn-based
  is live).

## Current focus

**Make the bot genuinely useful** (Roadmap items 3–4). The live call is verified and
already uses the Yandex Alena voice (`VoiceList.Yandex.Neural.ru_RU_alena`) — items 1–2
are done. Next: a knowledge base / FAQ and **structured order intake** (extract the
order from the dialog, read it back, write it to a CRM / Google Sheets).

The Voximplant scenario itself is **not in this repo** — it lives in the Voximplant
cloud; its canonical source is in `README.md` ("The Voximplant inbound scenario").

## Code map

- `speech.mjs` — `synthesize(text, voice="alena")` (TTS, oggopus, emotion `good`),
  `recognize(audio)` (STT, oggopus, ru-RU), `ask(messages, model="yandexgpt-lite")`
  (YandexGPT, `temperature 0.3`, `maxTokens 300`). Standalone async functions that
  call the Yandex Cloud HTTP APIs (and read the env keys); ES modules.
- `server.mjs` — Express on port `3000`. `POST /reply {callId, text} → {reply}` with
  per-`callId` history in an in-memory `Map`; `POST /end {callId}`. Holds the Russian
  `SYSTEM` prompt that defines the assistant persona.
- `test.mjs` — local round-trip smoke test (ask → synthesize → `reply.ogg` → recognize).

### Streaming path (roadmap item 5 — spike, parallel to the turn-based stack)

- `stream-server.mjs` — WebSocket server on port `3001` (`/media`). One per-call session runs
  a LISTENING ⇄ THINKING/SPEAKING loop over Voximplant's JSON+base64 media protocol:
  continuous v3 STT → streaming YandexGPT → sentence-by-sentence TTS → paced playback, plus
  **barge-in** (`onPartial` → `interrupt()`).
- `speaker.mjs` — voices a reply sentence-by-sentence under a per-call cancellation token;
  `abort()` stops the player **and** invalidates queued/in-flight sentences so a barge-in
  can't let Ева resume. Used by `stream-server.mjs`. Unit-tested in `speaker.test.mjs`.
- `bargein.mjs` — `isSubstantive(text)` (substantive speech vs backchannels) and
  `shouldInterrupt(state, partial, sinceFloorMs, graceMs, lastFinalText)` (the barge-in
  policy: floor + grace window + substantive + echo-gate against the caller's last
  finalized utterance). Wired into `stream-server.mjs`, not just a standalone filter; the
  server also logs suppressed "почти-перебивания" (`barge-in подавлен …`) for live tuning.
- `stt-stream.mjs` — Yandex SpeechKit v3 gRPC streaming STT wrapper (`openStt(...)`).
- `playback.mjs` — `PacedPlayer`: emits PCM in fixed 20 ms frames; `stop()` clears the queue
  so barge-in halts audio instantly.
- `sentences.mjs` — `splitSentences(text)` for incremental synthesis.
- `prompt.mjs` — the shared Ева `SYSTEM` persona, imported by both servers.
- `speech.mjs` (streaming additions) — `synthesizePcm(text, rate)` (LPCM TTS) and
  `askStream(messages, onChunk, { model, signal })` (streaming + abortable YandexGPT).
- Offline harnesses: `stt-offline.mjs` (STT on a recorded PCM) and `vox-replay.mjs` (replays
  captured Voximplant frames into the server — full loop without telephony).

## Commands

```bash
npm install                            # install ALL deps (express + ws + @grpc/* for streaming)
node --env-file=.env server.mjs        # run backend (prints "Backend слушает …:3000")
node --env-file=.env test.mjs          # backend-only smoke test, writes reply.ogg
ngrok http 3000                        # public tunnel; copy the Forwarding URL

# streaming spike (parallel path, roadmap item 5):
node --env-file=.env stream-server.mjs # streaming backend (WS /media:3001, health GET /health)
node --test *.test.mjs                 # offline unit tests (or: npm test)
ngrok http 3001                        # tunnel the streaming WS (WebSockets work over ngrok)
```

For a live call: run the backend **and** ngrok together, paste the ngrok URL into
`BACKEND`/`BACKEND_END` in the Voximplant scenario, then call via phone.voximplant.com.
Verify the backend is up first with `GET /health` (both servers expose it).

**Beta hardening (env knobs, all optional):** both servers now **fail fast on
startup** if `YANDEX_API_KEY`/`YANDEX_FOLDER_ID` are missing (clear error instead of a
mid-call `fetch failed`); `stream-server.mjs` also warns if the Telegram vars are unset.
Set `STREAM_SECRET` to gate the WS `/media` endpoint (it's public over ngrok) — when set,
the Voximplant scenario's WS URL **must** append `?token=<STREAM_SECRET>` or the upgrade is
rejected 401; unset = open + a loud boot warning. All Yandex `fetch` calls now have
timeouts (`TTS_TIMEOUT_MS` 8000 / `STT_TIMEOUT_MS` 10000 / `LLM_TIMEOUT_MS` 15000 /
`LLM_STREAM_TIMEOUT_MS` 20000, overridable in `.env`). `SIGTERM`/`SIGINT` drains active
sessions (flushes each call's Telegram lead) before exit.

## Conventions & constraints

- **Replies are Russian, phone-style:** short sentences, no lists, no markdown. Match
  the existing `SYSTEM` prompt in `server.mjs` and the Russian comments in the code.
- **Files are `.mjs` (ES modules)** even though `package.json` says `"type":
  "commonjs"` — the `.mjs` extension forces ESM, so it works. Keep new files `.mjs`
  with `import`/`export`, or fix `package.json` deliberately. There is no `start`
  script and no `index.js` despite `"main": "index.js"`.
- **Yandex auth** is `Authorization: Api-Key <key>` (NOT `Bearer`) and every call
  needs the folder ID. Keys come from `.env` (`YANDEX_API_KEY`, `YANDEX_FOLDER_ID`).
- **SpeechKit v1 limits:** synthesis ≤ ~250 chars, sync recognition ≤ ~30 s. Don't
  feed long text/audio to `speech.mjs` — use streaming modes for that.

## Watch out for

- **VPN must be OFF** when running the backend, or Yandex Cloud calls fail with
  `ConnectTimeoutError` (or whitelist `*.api.cloud.yandex.net`).
- **ngrok free rotates its URL** on every restart — the Voximplant scenario must be
  re-pasted with the current URL or the bot can't reach the backend.
- **Never commit secrets** — `.env` is gitignored; keep it that way.
- **Don't claim the live call works** without it actually being tested. The turn-based path
  is live (Alena voice). The streaming path + barge-in is offline-tested **and** confirmed
  on a real call (barge-in verified live); it is still not the production path. Keep
  confirming new streaming/telephony changes with a real call before claiming they work.
- **Two dev machines, switched interchangeably** — Windows 11 + WSL (Ubuntu) and
  macOS. Don't hardcode one: paths (`E:\…` / `/mnt/e/…` vs `~/voicebot`) and the Node
  version differ per machine; check which you're on before giving paths/shell commands.
  On Windows, prefer WSL/UTF-8 for anything with Russian text — the `cmd` console
  mangles Cyrillic (cp1251); WSL and macOS are fine.

## Verify before claiming done

- Backend change → run `node --env-file=.env test.mjs` (or curl `/reply`) and show
  the actual output.
- Scenario/telephony change → it can only be truly verified with a real call through
  phone.voximplant.com; say so rather than asserting it works.
