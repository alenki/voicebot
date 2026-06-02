# Streaming + Barge-in Spike (Ева) — Design

**Date:** 2026-06-02
**Roadmap item:** 5 — Dialogue quality (barge-in, lower latency) via our own STT/TTS
instead of the turn-based pipeline.
**Type:** Spike (Approach A). Goal is to turn unknowns into facts cheaply, not to ship
a production replacement.

## Goal

Prove an end-to-end streaming voice loop for one live call:

```
caller → Voximplant → WebSocket → our Node backend
            → Yandex SpeechKit v3 gRPC streaming STT
            → YandexGPT (ask())
            → Yandex TTS v1 LPCM, synthesized sentence-by-sentence
            → audio back over the WebSocket → caller
```

with **smart barge-in**: the caller can interrupt Ева mid-sentence and she stops and
listens, but short backchannels ("угу", "да-да") do not interrupt her.

The existing turn-based pipeline (`server.mjs` `POST /reply`, the live Voximplant
scenario) is **left untouched and working**. The spike adds a *parallel* path so a
half-built spike can never break the verified production call.

## Chosen approach — "Lean own-stack spike" (Approach 3)

Of three options considered:

1. **Full own-stack streaming** — v3 gRPC streaming for *both* STT and TTS. Truest to
   the roadmap, lowest latency, but two simultaneously-unproven gRPC integrations plus
   WS media plus barge-in all at once — most risk for a spike.
2. **Barge-in inside Voximplant, backend untouched** — keep Voximplant's own ASR/TTS,
   add barge-in in the scenario. Tiny effort, but proves none of our own streaming
   stack — not the spike we want.
3. **Lean own-stack spike (CHOSEN)** — WS media + **one** new gRPC integration
   (streaming STT, which is what barge-in needs) + reuse the existing v1 `synthesize()`
   for TTS (as LPCM, synthesized sentence-by-sentence and streamed back).

Approach 3 isolates the genuinely-new risk (WS media + our streaming STT + barge-in)
while holding TTS fixed at code that already works. If the spike succeeds, upgrading to
streaming TTS (Approach 1) becomes a small, well-understood follow-up.

## Key technical constraint

The current `speech.mjs` uses Yandex SpeechKit **v1 synchronous HTTP** APIs:
`recognize()` (whole audio buffer → final text), `synthesize()` (whole audio file out),
`ask()` (non-streaming). None of these can stream. Real barge-in needs (a) streaming STT
to detect the caller talking mid-sentence, (b) a continuous media path instead of
turn-based listen, and (c) the ability to stop playback the instant the caller speaks.
So despite earlier notes that `speech.mjs` is "tested and ready for streaming," the
streaming path is essentially new work.

## Architecture & components

The streaming path runs **alongside** the turn-based stack, not replacing it.

**New files / changes:**

- **`stream-server.mjs`** — WebSocket server (npm `ws`) on a `/media` path. Voximplant
  opens one WS per call. Owns the per-call **session** and orchestrates the loop
  (STT → LLM → TTS → playback) and barge-in. Runs in the same Node process as Express
  (shares the HTTP server, or a second port — decided in the plan).
- **`stt-stream.mjs`** — thin wrapper around Yandex SpeechKit **v3 gRPC streaming STT**
  (`@grpc/grpc-js` + `@grpc/proto-loader`, vendored Yandex `.proto` files). Exposes e.g.
  `openStt({ sampleRate, onPartial, onFinal })` returning a writable audio sink. Isolates
  the one genuinely-new, risky integration in its own testable unit.
- **`prompt.mjs`** — extract the `SYSTEM` prompt (the `FACTS` / `BEHAVIOR` blocks) out of
  `server.mjs` into a tiny shared module so both servers use the same Ева persona without
  duplicating it. Small, justified refactor — both pipelines need it.
- **Extend `speech.mjs`** — add an LPCM synthesis option (Yandex TTS v1 supports
  `format=lpcm` at a given `sampleRateHertz`) so synthesized audio matches the
  WebSocket's raw-PCM format and we avoid transcoding ogg→PCM. The existing
  `synthesize()` (oggopus) stays as-is for the turn-based smoke test.
- **Voximplant streaming scenario** — a *new* scenario variant that streams call media to
  our WS instead of doing its own ASR/TTS. Lives in the Voximplant cloud (not the repo);
  canonical copy kept in `README.md` like the existing one.

**New dependencies:** `ws`, `@grpc/grpc-js`, `@grpc/proto-loader` (the repo currently
depends only on `express`), plus vendored Yandex proto files.

**Reused unchanged:** `ask()` (YandexGPT), the per-`callId` dialog `Map` pattern, the Ева
prompt.

## Data flow & the per-call session

On WS connect, the backend creates one **session** holding: the STT stream handle, the
dialog history (seeded with the shared `SYSTEM` prompt), a `state` flag, and a handle to
abort the current playback.

A two-state machine; caller audio is forwarded to STT **continuously** in both states:

```
   ┌──────────────┐  final STT result   ┌──────────────┐
   │  LISTENING   │ ──────────────────► │   SPEAKING    │
   │ (Ева silent) │                     │ (Ева talking) │
   └──────────────┘ ◄────────────────── └──────────────┘
                   substantive partial = BARGE-IN
```

- **Connect:** Voximplant sends a metadata frame (sample rate, encoding). Backend opens a
  v3 STT stream for that rate, then synthesizes the greeting ("Здравствуйте! Это
  типография Альфа Принт, меня зовут Ева…") as LPCM and streams it back → SPEAKING.
- **LISTENING:** every inbound PCM frame is forwarded to the STT stream. STT emits
  partials (live) and a final (caller paused). On **final** → push text to history →
  `ask()` YandexGPT → split the reply into sentences → for each sentence,
  `synthesize(lpcm)` and stream its frames back over the WS → SPEAKING. Sentence-by-
  sentence is the latency trick: Ева starts talking after the *first* sentence is
  synthesized, not the whole reply.
- **SPEAKING:** Ева's audio frames flow out, **but STT keeps running on inbound audio**.
  Always-listening is what makes barge-in possible.

**Barge-in (smart):** while SPEAKING, each partial is tested against a filter — interrupt
only if it looks *substantive* (≥ a small char/word threshold or ≥ a duration, AND not in
a backchannel stop-list like `угу / ага / да / да-да / мгм`). If it passes: stop sending
TTS frames immediately, abort the remaining queued sentences, and transition to
LISTENING. The interrupting utterance is already being transcribed by the still-running
STT, so no audio is lost — it flows into the next turn.

**Deliberate spike simplifications:**

- **Echo:** Ева's outgoing audio is *not* fed back into STT (Voximplant streams only the
  caller's leg), so she won't barge-in on herself. Confirmed in milestone M0.
- **Backchannel thresholds are guesses** until we hear real calls — the design needs only
  *a* filter; the numbers get tuned in a later pass.

## Error handling & lifecycle

Spike principle: **fail loud and clean, don't build elaborate recovery** — but define
behavior for the failures that will happen on real calls.

- **STT stream max-duration / closes mid-call:** Yandex streaming sessions have a time
  cap. The session detects the close and transparently re-opens a fresh STT stream,
  continuing to forward inbound frames. If re-open fails: speak "связь прервалась,
  повторите пожалуйста" and keep the call alive.
- **YandexGPT error/timeout:** speak a short apology ("Извините, техническая ошибка,
  повторите пожалуйста") and return to LISTENING — never drop the call on one bad turn.
- **TTS synth error on a sentence:** skip that sentence, log it, continue the rest.
- **WebSocket drops (caller hangs up):** tear down the session — close the STT stream,
  abort playback, delete the dialog history from the Map (same cleanup `POST /end` does).
- **Malformed/unexpected first frame:** log the raw frame and close. This doubles as the
  M0 probe behavior.

**Logging:** every session logs `[callId]` state transitions, recognized text, Ева's
replies, and barge-in events to the console, in the same `client / bot` style as
`server.mjs`. For a spike, the console log *is* the primary observability.

**Non-goals:** no persistence, no reconnect-the-call logic, no multi-process session
sharing. In-memory per-process, lost on restart — like the current `/reply` Map.

## Verification & milestones

Telephony is only truly verified by a real call through phone.voximplant.com, so each
new piece is de-risked **offline first** where possible. Four sequential milestones:

- **M0 — WebSocket media probe (throwaway).** Minimal WS server logs the metadata frame
  and inbound audio frames ("N frames, sample rate X, encoding Y"). Trigger a real call.
  **Pass:** bytes arrive and we know the exact format. The make-or-break unknown — if it
  fails the whole approach changes, and we learn it first. Also confirms the echo
  assumption (only the caller's leg streams in).
- **M1 — Streaming STT proven offline (no telephony).** A local harness (like `test.mjs`)
  feeds a recorded PCM file into `stt-stream.mjs` and prints partials + finals.
  **Pass:** correct Russian transcription with live partials — proving the risky gRPC
  integration in isolation, no Voximplant involved.
- **M2 — Full loop, no barge-in.** Wire M0 + M1 + `ask()` + LPCM sentence-synthesis. Real
  call: greet → caller speaks → Ева answers, talking after the first sentence. **Pass:** a
  coherent spoken exchange over the streaming path, with noticeably lower latency than the
  turn-based path.
- **M3 — Barge-in.** Add SPEAKING-state partial detection + backchannel filter. Real call:
  interrupt Ева mid-sentence → she stops and listens; say "угу" → she keeps talking.
  **Pass:** substantive speech interrupts, backchannels don't.

**Verification ownership:** the M1 offline harness can be built and run locally and its
output shown. M0, M2, M3 each need a real call placed by the user (and the streaming
scenario pasted into Voximplant + the backend reachable over a WS-capable tunnel — ngrok
tunnels WebSockets fine). No call-dependent milestone is claimed "working" without the
user's confirmation, per the repo convention.

## Out of scope

- Streaming TTS (v3 gRPC) — the follow-up after the spike proves the loop (Approach 1).
- Structured order intake → CRM/Sheets (roadmap item 4).
- Knowledge base / FAQ / RAG (rest of item 3).
- Permanent backend / VM hosting (item 6), real inbound number (item 7), production
  extras (item 8).
- Tuning the backchannel thresholds beyond a first reasonable guess.
