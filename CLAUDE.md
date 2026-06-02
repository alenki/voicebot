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
- **Future (streaming):** uses our own `speech.mjs` STT/TTS for barge-in + low
  latency. `speech.mjs` is tested but **not wired into live calls yet.**

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

## Commands

```bash
npm install                            # install express
node --env-file=.env server.mjs        # run backend (prints "Backend слушает …:3000")
node --env-file=.env test.mjs          # backend-only smoke test, writes reply.ogg
ngrok http 3000                        # public tunnel; copy the Forwarding URL
```

For a live call: run the backend **and** ngrok together, paste the ngrok URL into
`BACKEND`/`BACKEND_END` in the Voximplant scenario, then call via phone.voximplant.com.

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
- **Don't claim the live call works** without it actually being tested — the bot still
  speaks with the default voice, and the streaming path is unbuilt.
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
