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

**Latency overhaul shipped (2026-07-05), needs a live-call verification.** Voice-to-voice
on the streaming path dropped from ~2.7–4.5 s to a target ~0.9–1.3 s via four stacked
changes: (1) **speculative turns** — the LLM (and TTS prewarm) starts while the endpoint
window is still confirming silence, and the commit attaches to the in-flight stream;
(2) **EOU fast path** — a Yandex stt-eou final shrinks the remaining silence window to
`ENDPOINT_FAST_MS` measured from last voice (a final used to RE-ARM the full 1200 ms);
(3) **chunk-streamed TTS** — PCM flows into the player as the provider generates it
instead of after the whole sentence; (4) dialog brain defaults to **`aliceai-llm-flash`**
(fastest TTFT ~553 ms warm, OpenAI-compatible API branch; eva-eval clean 2026-07-05).
All offline-tested (168 tests); the polish pass of 2026-07-04 (persona rework, shared
reply gates, Telegram lead delivery on both paths) also still awaits its live call.
Next: owner places a real call (turn-based + streaming), then tune from its logs; later
a richer FAQ and CRM/Sheets export.

The Voximplant scenario itself is **not in this repo** — it lives in the Voximplant
cloud; its canonical source is in `README.md` ("The Voximplant inbound scenario").

## Code map

- `speech.mjs` — `synthesize(text, voice="marina")` (TTS, oggopus, role `friendly`;
  marina is the only new-gen Yandex voice that works over v1 REST — dasha/lera/masha
  are v3-only; rollback: alena+good),
  `recognize(audio)` (STT, oggopus, ru-RU), `ask(messages)` — **default dialog model
  is `aliceai-llm-flash`** since 2026-07-05 (fastest TTFT in the catalog: ~553 ms warm,
  re-measured through our own `askStream`; eva-eval clean — phone gate, two-refusal
  release, digit read-back, robot deflection, no price/срок leaks). Flash speaks ONLY
  the **OpenAI-compatible API** — `ask`/`askStream` auto-branch to
  `https://ai.api.cloud.yandex.net/v1/chat/completions` (SSE deltas, model
  `gpt://<folder>/<model>` WITHOUT `/latest`, `max_completion_tokens`) for models in
  `OPENAI_ONLY_MODELS`; `LLM_API=openai` forces any model onto that branch. Rollbacks
  by degree: `LLM_MODEL=aliceai-llm` (flagship, ~610-770 ms TTFT, native API) →
  `LLM_MODEL=yandexgpt` (old prod). `temperature 0.4` — env `LLM_TEMPERATURE`;
  `maxTokens 120` — env `LLM_MAX_TOKENS`.
  lite was the root cause of "the AI works really bad": it spelled the caller's NAME
  letter-by-letter like a phone number, asked double questions, repeated canned lines
  verbatim and said goodbye without taking the phone. All Yandex HTTP calls go through
  one **undici keep-alive Agent** (60 s) — test seam: `setHttpDispatcher()`.
  `ask`/`askStream` **retry once on transient network errors** (ECONNRESET/`fetch
  failed`: the aliceai backend resets ~5% of connections — measured 2026-07-05, fresh
  connections too; yandexgpt also blips). askStream retries only before the first
  chunk; timeouts and caller aborts are never retried. Verified ~190 turns, 0 errors.
  `synthesizePcm(text, rate, {onChunk})` dispatches on `TTS_PROVIDER` (`yandex` default
  | `elevenlabs`) and, given `onChunk`, **streams PCM chunks as the response body
  arrives** (returns the full buffer either way); STT and `synthesize()` (oggopus)
  stay Yandex always.
- `tts-elevenlabs.mjs` — ElevenLabs PCM synthesis for the streaming path (voice
  Victoria via `ELEVENLABS_VOICE_ID`, model `eleven_flash_v2_5`, ~280 ms to first
  pcm_8000 chunk, no VPN needed). With `{onChunk}` the response body **streams
  chunk-by-chunk** (before, the whole sentence was buffered — +0.3–1.4 s to first
  sound); URL carries `optimize_streaming_latency=3` (deprecated-but-accepted; level 4
  would disable text normalization and mangle spoken prices/phones — never use it; env
  `ELEVENLABS_STREAM_LATENCY`, empty = don't send). **Requires a paid ElevenLabs
  plan** — Voice Library voices over the API return 402 on free (verified 2026-07-05;
  integration is wired and tested up to that paywall, flip `TTS_PROVIDER=elevenlabs`
  once subscribed). Own keep-alive agent; test seam `setElevenFetch()`. Unit-tested
  offline. Note: with this provider the boot-time PCM-cache prewarm (~18 phrases) and
  **discarded speculations** (see `SPECULATE_TTS`) spend ElevenLabs credits.
- `server.mjs` — Express on port `3000`. `POST /reply {callId, text} → {reply}`;
  `POST /end {callId}` now **finalizes the lead** (extractOrder → Telegram) — before,
  the LIVE path silently threw every lead away (Telegram delivery existed only in the
  streaming spike). Optional `REPLY_SECRET` (header `X-Backend-Token`) gates both
  endpoints; empty LLM replies get a spoken fallback instead of dead air; 500s return
  a generic error (no internals); SIGTERM/SIGINT drains leads with a 20 s deadline.
- `dialog-store.mjs` — per-call history store for `server.mjs`: TTL sweep
  (`DIALOG_TTL_MS`, default 30 min) finalizes calls whose `/end` never arrived —
  no memory leak, no silently lost lead. Unit-tested with injected deps.
- `history.mjs` — `windowForLlm(history)`: sliding window (system + last ~24 messages)
  sent to the LLM by both servers; the **full** history object stays intact for
  `enforcePhoneGate` and `extractOrder`.
- `reply-clean.mjs` — deterministic gates backing the prompt up (the prompt alone
  doesn't hold the model): greeting/markup/quote strip, `stripRolePlay` (now also
  inline «Ева:»/«Менеджер:» labels and label-prefixed replies), `feminize` (with
  subject guards — «заказ будет готов» stays masculine), `spellOutPhoneRuns` (7+ digit
  runs → «восемь, девять…» so alena doesn't read one giant number), `hasBotLeak`/
  `BOT_DEFLECT` («как языковая модель…» → Ева's stock deflection), `hasPhone`
  (contiguous digit runs — scattered «90 на 50, тираж 1000» no longer counts as a
  phone; numbers split across two turns DO), `enforcePhoneGate` with widened
  callback-promise verbs («свяжемся», «позвоним», «наберет», «соединю»), tightened
  ask-detection, rotation of 3 `PHONE_ASKS` variants, and a two-refusal stand-down
  (after the caller refuses twice, the gate stops pushing).
- `order-extract.mjs` — post-call order extraction (full `yandexgpt`, temp 0, one
  retry); `normalizePhone` converts dictated number-words to digits; `hasOrder`
  parses strictly (string "false" ≠ true).
- `lead.mjs` — Telegram delivery with a 10 s timeout (env `TELEGRAM_TIMEOUT_MS`), one
  retry, and a **local fallback journal** `leads.ndjson` (env `LEADS_FILE`, gitignored):
  a lead that can't reach Telegram is appended there instead of vanishing.
- `test.mjs` — local round-trip smoke test (ask → synthesize → `reply.ogg` → recognize).
- `eva-eval.mjs` — scripted multi-turn dialogs through a running `/reply`; writes
  `eva-eval-output.json` for a persona/guardrail review. Run it after any prompt change.

### Streaming path (roadmap item 5 — spike, parallel to the turn-based stack)

- `stream-server.mjs` — WebSocket server on port `3001` (`/media`). One per-call session runs
  a LISTENING ⇄ THINKING/SPEAKING loop over Voximplant's JSON+base64 media protocol:
  continuous v3 STT → streaming YandexGPT → sentence-by-sentence TTS → paced playback, plus
  **barge-in** (`onPartial` → `interrupt()`). Latency features: per-process **PCM cache**
  (greeting/apologies/fillers/idle-prompts/phone-asks prewarmed at boot, capped at 200
  entries; **prewarmed keys are pinned** — dialog phrases can't evict them — and hits are
  LRU-refreshed), **thinking-gap filler** (4 rotating clips from the cache if no real audio
  after `FILLER_MS`, default 1200 ms, plus `FILLER_COOLDOWN_MS` default 10 s; skipped when
  the first reply sentence is already in TTS, padded with 250 ms of silence),
  wall-clock endpointing tunable via `ENDPOINT_MS` (default 1200) with a 250 ms VAD re-check
  (frame-based deferrals are budgeted — max ~3 s — so a no-DTX line with constant
  comfort-noise frames can't mute Ева forever), and newline-as-sentence-boundary so
  list-shaped LLM replies stream instead of stalling.
  **Speed stack (2026-07-05, offline-tested — live call still owed):** (1) **speculative
  turns** — after `SPECULATE_MS` (250) of stable partial or on a stt-eou final, the LLM
  starts on `[...history, user]` WITHOUT touching state, and (at `SPECULATE_TTS=1`) its
  cleaned sentences pre-synthesize through the same exported `makeReplyGater` the real
  turn uses (byte-identical text → cache/inflight hits); the commit attaches to the
  in-flight stream via `takeSpec()` — no second LLM call; continued speech / discard
  paths / close abort it, and NOTHING plays before the endpoint commits. (2) **EOU fast
  path** — when Yandex closed the utterance (segments non-empty, partial consumed) the
  window shrinks to `ENDPOINT_FAST_MS` measured **from last voice** (a final used to
  re-arm the full window: commit ≈ final+1200 ms). (3) **per-session `inflightSynth`** —
  concurrent synthesis of the same sentence (speculation + commit) shares one TTS call;
  late subscribers replay received chunks, then stream; retry only before the first
  emitted chunk. (4) **chunk-streamed playback** — `Speaker.say` feeds provider chunks
  straight into the player under the turn token.
  **Turn finalization is silence-driven:** Yandex stt-eou finals do NOT start a turn — they
  accumulate as segments, and the turn fires only after the endpoint window of real silence
  (fast or full). The
  late-duplicate dedup now has a **fresh-voice exemption**: a caller legitimately answering
  «да» to two consecutive questions is a new turn (has fresh partials/frames), while a late
  stt-eou replay (silence in the line) is still dropped. A **tail-echo gate** drops a "turn"
  that begins right after Ева stops speaking and is mostly her own words. **Reply hygiene
  now matches the turn-based path**: per-sentence `feminize` + quote-strip +
  `spellOutPhoneRuns`, roleplay labels are clipped mid-stream, `hasBotLeak` swaps in the
  stock deflection, and the **phone gate** replaces a callback-promise-without-number
  sentence with a `PHONE_ASKS` variant (rest of that turn's stream is muted). **Idle
  re-prompt**: after `IDLE_PROMPT_MS` (default 15 s, `0` off) of caller silence in
  LISTENING Ева asks «Алло, вы меня слышите?» — max 2 in a row. On ws close the Speaker is
  aborted (queued sentences stop burning TTS calls) and the session stays in the drain set
  until its lead delivery settles; a duplicate `start` frame is ignored; WS `maxPayload`
  is 1 MiB. Lead is sent when the extraction says `hasOrder` **or a phone was captured**.
  **Noise robustness (energy gates, 2026-07-05, offline-tested — live call still owed):**
  STT transcribes ANY speech in the line (TV, people nearby), and the session used to trust
  partials as proof the *caller* spoke — background chatter deferred the endpoint forever
  (Ева stopped answering), barged in on her, and became "caller turns". Now `vad.mjs`
  classifies every inbound frame loud/quiet and three gates use it: (1) **endpoint** —
  energy-less partial changes don't re-arm the silence window and don't defer the fire,
  plus a hard `MAX_TURN_MS` cap so a turn ALWAYS finalizes; (2) **barge-in** — a
  substantive partial with no recent loud frame is logged and ignored; (3) **turn
  acceptance** — a finalized turn whose window (1 s pre-roll for STT lag) had almost no
  loud audio is dropped silently as background; after 2 consecutive drops Ева asks
  «не расслышала» — **max 2 such prompts in a row** (continuous chatter used to loop the
  apology every ~4 s till hangup; a real accepted turn resets the cap). Safety rule:
  gates activate only after the caller has proven
  near-field loudness (`callLoudEver`); a quiet-mic call degrades to the old behavior,
  never to a deaf Ева. Audio always reaches STT — energy shapes decisions only.
- `speaker.mjs` — voices a reply sentence-by-sentence under a per-call cancellation token;
  `abort()` stops the player, invalidates queued/in-flight sentences **and resets the synth
  chain** (the next turn no longer queues behind a stalled TTS call of the cancelled turn).
  `synth(text, emit)` may **stream PCM chunks** via `emit` — each chunk is token-gated, so
  barge-in mid-stream drops the rest; a non-streaming synth (old fakes, cache hits without
  chunks) still returns a whole buffer. `sayPcm(token, buf)` plays pre-synthesized PCM
  (fillers) bypassing the synth chain — it does NOT set `spokeThisTurn`. Unit-tested in
  `speaker.test.mjs`.
- `vad.mjs` — energy VAD for the streaming path: per-frame RMS vs an **adaptive noise
  floor** (drifts to the line's comfort-noise level on quiet frames, creeps up slowly on
  loud ones, capped at `floorMaxDb` so adaptation can never mute real speech).
  `new EnergyVad().frame(pcm)` → `{db, speech}`. Unit-tested in `vad.test.mjs`.
- `bargein.mjs` — `isSubstantive(text)` (substantive speech vs backchannels),
  `isEchoOf(partial, selfText)` (≥80 % of the partial's words are in Ева's current reply →
  it's her own voice echoing back, not the caller) and
  `shouldInterrupt(state, partial, sinceFloorMs, graceMs, lastFinalText, selfText)` (the
  barge-in policy: floor + grace window + substantive + echo-gates against the caller's
  last finalized utterance AND Ева's own speech). On top of the policy the server applies a
  **sustain gate** (`BARGE_SUSTAIN_MS`, default 300): an interrupt fires only when
  substantive speech persists across partials — a single STT blip (line noise, a snatch of
  side conversation) no longer silences her. The server logs suppressed
  "почти-перебивания" (`barge-in подавлен …`) and pre-sustain candidates for live tuning.
- `stt-stream.mjs` — Yandex SpeechKit v3 gRPC streaming STT wrapper (`openStt(...)`).
  **Auto-reconnects** on gRPC error or silent stream end (exponential backoff 300 ms → 5 s,
  test seam: `connect` factory + `reconnectDelayMs`) — previously one network blip left Ева
  deaf for the rest of the call. Frames sent during the gap are knowingly dropped.
  `close()` also closes the per-call gRPC client channel (they used to accumulate).
- `sentences.mjs` — `splitSentences` no longer breaks after abbreviations («г.», «ул.» —
  the FACTS address used to be spoken as fragments); `chunkForTts` splits >240-char
  sentences so SpeechKit v1's ~250-char limit can't silently swallow one.
- `playback.mjs` — `PacedPlayer`: emits PCM in fixed 20 ms frames; `stop()` clears the queue
  so barge-in halts audio instantly.
- `sentences.mjs` — `splitSentences(text)` for incremental synthesis.
- `prompt.mjs` — the shared Ева `SYSTEM` persona, imported by both servers.
- `speech.mjs` (streaming additions) — `synthesizePcm(text, rate)` (LPCM TTS) and
  `askStream(messages, onChunk, { model, signal })` (streaming + abortable YandexGPT).
- Offline harnesses: `stt-offline.mjs` (STT on a recorded PCM), `vox-replay.mjs` (replays
  captured Voximplant frames into the server — full loop without telephony) and
  `call-sim.mjs` (synthetic caller: synthesizes caller phrases, streams them into a live
  stream-server at real-time pace and measures voice-to-voice latency — uses real Yandex
  services, costs money; measured 767–1227 ms warm on 2026-07-05).

## Commands

```bash
npm install                            # install ALL deps (express + ws + undici + @grpc/* for streaming)
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

**Latency/turn-taking knobs (env, all optional):** `ENDPOINT_MS` (default 1200) — streaming
end-of-utterance silence window when the utterance is NOT yet closed by a Yandex final.
Deliberately conservative per owner feedback ("answer only when the caller has really
stopped talking"); lowering it trades politeness for speed — verify **on live calls only**.
`ENDPOINT_FAST_MS` (default 800, clamped ≤ `ENDPOINT_MS`; set = `ENDPOINT_MS` to disable) —
the shorter window used once a stt-eou final closed the utterance (Yandex's EOU classifier
already sat out its own pause); measured from last voice, not from final arrival.
`SPECULATE_MS` (default 250, `0` off) — partial-stability window before the speculative
LLM turn starts; a reply never sounds before the endpoint commits, discarded speculations
just cost an LLM call. `SPECULATE_TTS` (default 1, `0` off) — whether speculation also
pre-synthesizes TTS (burns ElevenLabs credits on discarded speculations when
`TTS_PROVIDER=elevenlabs`). `FILLER_MS` (default 1200,
`0` disables) — delay before the cached filler masks a slow LLM+TTS turn (skipped if the
reply is already in TTS). `FILLER_COOLDOWN_MS` (default 10000) — minimum gap between
fillers. `BARGE_SUSTAIN_MS` (default 300) — how long substantive caller speech must persist
before it interrupts Ева. `IDLE_PROMPT_MS` (default 15000, `0` off) — caller-silence window
before Ева asks «алло?» (max 2 in a row).

**Noise-robustness knobs (env, streaming path):** `VAD_MARGIN_DB` (default 10) — how far
above the adaptive noise floor a frame must be to count as caller speech; **`0` disables
all energy gates** (full rollback to pre-VAD behavior). `VAD_MIN_DB` (default -50) —
absolute speech minimum in dBFS. `MAX_TURN_MS` (default 40000, `0` off) — hard cap on one
caller turn; a noisy-line safety net, NOT a limit on real callers (12000 cut off a live
caller's monologue mid-thought on 2026-07-06 — felt like being interrupted; keep it high).
`MIN_TURN_LOUD_MS`
(default 150) — minimum loud audio inside a turn's window before it's accepted (below it =
background speech, dropped). `BARGE_ENERGY_MS` (default 600) — how recent a loud frame must
be for a partial to count toward barge-in. All gates self-disarm on quiet-mic calls
(`callLoudEver`): they only tighten behavior after the caller has been heard loud once.

**Voice knobs (env):** `TTS_PROVIDER` (`yandex` default | `elevenlabs` — bad value =
fail-fast at boot), `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (**Elena Gromova
`0ArNnoIAWKlT4WweaVMY` since 2026-07-06** — "Podcasts & Conversation", naturally
conversational, picked after live-call feedback that Victoria sounded aggressive/theatrical;
Victoria rollback: `D5RRIJYa9pFwxiSpbGbR`),
`ELEVENLABS_MODEL` (default `eleven_flash_v2_5` — the only latency tier fit for live
calls). **Voice character** (live-call feedback 2026-07-06: stock Victoria was too
aggressive/fast): `ELEVENLABS_SPEED` (default 0.9, range 0.7–1.2), `ELEVENLABS_STABILITY`
(default 0.3 — lower = livelier intonation), `ELEVENLABS_SIMILARITY` (default 0.75),
`ELEVENLABS_STYLE` (default 0.4 — expressiveness), `ELEVENLABS_VOICE_SETTINGS=0` = send
none (stock Voice Library preset, the pre-2026-07-06 sound). All verified on flash_v2_5
live — no first-chunk latency penalty. Yandex voice/role live in `speech.mjs`
(`marina`/`friendly` since 2026-07-05).

**Brain knobs (env):** `LLM_MODEL` (default `aliceai-llm-flash` — fastest TTFT, lives on
the OpenAI-compatible API only; `aliceai-llm` = flagship on the native API, first
rollback; `yandexgpt` = previous prod, second rollback; `yandexgpt-lite` saves money at a
real quality cost — never go back to it), `LLM_API=openai` forces any model onto the
OpenAI-compatible endpoint, `LLM_TEMPERATURE` (default 0.4),
`LLM_MAX_TOKENS` (default 120; order extraction passes its own 400 explicitly).
`REPLY_SECRET` — gates `/reply`+`/end` via `X-Backend-Token` (set the same value in the
Voximplant scenario's `BACKEND_TOKEN`). `DIALOG_TTL_MS` (default 30 min) — turn-based
dialog sweep. `TELEGRAM_TIMEOUT_MS` (default 10000), `LEADS_FILE` (default `leads.ndjson`,
empty string disables the fallback lead journal).

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
  is live (voice: README's canonical scenario switched to Marina+friendly on 2026-07-05,
  but the Voximplant cloud copy speaks whatever was last pasted — re-paste and live-call
  verify; previously Alena+good). The streaming path + barge-in is
  offline-tested **and** confirmed
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
- Prompt/persona change → run `node --env-file=.env server.mjs` + `node eva-eval.mjs`
  and read the transcripts in `eva-eval-output.json` against the guardrails (price/срок
  leaks, double questions, lost phone, bot tells).
- Scenario/telephony change → it can only be truly verified with a real call through
  phone.voximplant.com; say so rather than asserting it works.
