# Deploy the streaming voicebot 24/7 on Yandex Cloud (beta) — Design

**Date:** 2026-06-03
**Status:** Design — awaiting review before implementation planning
**Scope:** Get the **streaming** pipeline (`stream-server.mjs`) running 24/7 on a virtual
server with the **lowest possible reply latency for callers in Russia**, as a **beta**
sized for **1–2 concurrent calls**, doing the **bare minimum** required to go live safely.

---

## 1. Goal & constraints

- **Primary goal:** absolute lowest spoken-reply latency for Russian callers, 24/7.
- **Pipeline:** the streaming + barge-in path (`stream-server.mjs`, WS `/media`, our own
  gRPC STT → streaming YandexGPT → sentence-by-sentence LPCM TTS). NOT the turn-based
  `server.mjs` path.
- **Scale (beta):** 1–2 simultaneous calls. Single VM, no HA.
- **Operational model:** self-managed Linux VM (user is comfortable with VM + Docker/SSH).
- **Billing:** Yandex Cloud billing account is available (confirmed) — so we co-locate
  inside Yandex Cloud.

### Decided trade-offs
- **Bare minimum to go live.** Only the changes strictly needed for a working, safe 24/7
  `wss` deployment are in scope. Resilience/scale work is explicitly deferred (§8) with its
  risks documented (§9) so beta's limitations are known, not hidden.

---

## 2. Why this is the fastest setup in Russia

The streaming path is latency-dominated by network round-trips to the Yandex AI APIs
(continuous STT + streaming GPT + per-sentence TTS, every turn). The single biggest lever
is **physical co-location**, not CPU speed.

- **Host the VM in Yandex Cloud Compute, region `ru-central1` (Moscow).** The SpeechKit
  (`stt.api`/`tts.api.cloud.yandex.net`) and YandexGPT (`llm.api`/`ai.api.cloud.yandex.net`)
  endpoints serve from in-region Russian datacenters. A VM in `ru-central1` reaches them over
  Yandex's own backbone at single-digit-ms RTT, vs tens-to-hundreds of ms from outside Russia.
  *(Confirmed: the endpoints are global hostnames — there is **no** region-specific API URL;
  the RTT win comes purely from VM placement.)*
- **Use a Russian DID on Voximplant.** Voximplant runs RU media PoPs, one cluster physically
  **inside Yandex Cloud Moscow** (`158.160.135.x`). A Russian number keeps the call on RU
  infrastructure, minimizing the Voximplant→VM hop. *(Caveat: there is no documented knob to
  pin which Voximplant js-server originates the WebSocket, so this is best-effort — but
  co-location carries no downside.)*

---

## 3. Architecture

```
   Caller (Russia)
        │  PSTN
        ▼
  Voximplant (VoxEngine scenario) ── Russian DID → RU media PoPs (one inside Yandex Cloud)
        │
        │  scenario dials OUT:  wss://voice.<domain>/media   (PCM16 @ 8 kHz, 20 ms frames)
        ▼
┌──────────────────  Yandex Cloud  ru-central1 (Moscow)  ──────────────────┐
│  VM  standard-v3 · 2 vCPU @ 100% · 2 GB · 20 GB SSD · Ubuntu LTS · Node 24 │
│                                                                           │
│   ┌─────────┐   wss        ┌───────────────────────────┐                  │
│   │  Caddy  │── 127.0.0.1 ─▶│  Node: stream-server.mjs  │                  │
│   │ TLS/LE  │    :3001      │  (systemd, Restart=always)│                  │
│   └─────────┘               └─────────────┬─────────────┘                 │
│      ▲ :443 / :80                          │ same-region backbone (~ms)    │
│      │                                     ▼                               │
│      │              stt.api / tts.api / llm.api .cloud.yandex.net :443      │
└──────┼─────────────────────────────────────────────────────────────────────┘
       │  firewall: 443+80 public (TLS is the real control), 22 admin-IP only
```

- **VoxEngine is the WebSocket client**; our Node app is the WebSocket server. The scenario
  dials out to our public `wss://voice.<domain>/media`.
- **Caddy terminates TLS** and reverse-proxies to Node on `127.0.0.1:3001`. Node is never
  exposed directly.

---

## 4. Server (infrastructure)

### VM
| Item | Value | Rationale |
|---|---|---|
| Platform | `standard-v3` (Intel Ice Lake) | Current general-purpose Intel platform. |
| vCPU | **2 @ 100% (guaranteed)** | Guaranteed core avoids noisy-neighbor jitter mid-call — the latency requirement forbids burstable. |
| RAM | **2 GB** | Ample for Node + 1–2 gRPC STT streams + audio buffers at beta scale. |
| Disk | **20 GB network-SSD** | SSD for snappy I/O; cost delta over HDD is trivial. |
| OS | Ubuntu LTS (22.04 or 24.04) | Standard, well-supported. |
| Instance type | **Standard on-demand** (NOT preemptible) | Preemptible VMs are force-stopped ≤24 h and not auto-restarted — unacceptable for a phone line. |
| Region/zone | `ru-central1` (any Moscow zone) | Co-location with Yandex AI endpoints (§2). |
| Public IP | Static | Needed for the DNS A record / `wss` domain. |

**Cost estimate:** ≈ **2,400 ₽/month** for the VM + disk (plus static IP + modest egress).
⚠️ **Unverified — treat as ±10%.** The live price table is CAPTCHA-gated and a price update
took effect **2026-05-01** of unknown magnitude. Read the real figure off
`https://yandex.cloud/prices` before committing budget. SpeechKit/YandexGPT usage is billed
separately (per-audio / per-token).

### TLS — Caddy
- Caddy reverse-proxies `wss` → `127.0.0.1:3001`, with **automatic Let's Encrypt** and
  **automatic WebSocket upgrade** (no `header_up` needed in Caddy v2). Default proxy stream
  timeouts are unlimited, so long calls aren't force-closed.
- Add **`flush_interval -1`** so 20 ms PCM frames flush immediately (low-latency mode).
- Requires a **DNS A record** for the host → the VM's static IP. `wss://` will **not** accept a
  bare IP, so a domain is mandatory.

### Domain (resolved)
A domain is the one hard prerequisite for `wss`. Two acceptable paths for beta:
- **Free subdomain (recommended for beta): DuckDNS** — `something.duckdns.org` with an A record
  pointing at the VM IP. It's a real DNS name, so Caddy/Let's Encrypt issues a valid cert and
  Voximplant accepts it. Zero cost, set up in minutes.
- **Own domain** — buy a cheap domain (~a few $/yr) at any registrar and add an A record (or
  use Yandex Cloud DNS). Use this if you want a branded host; otherwise DuckDNS is fine.

Either way the cert is real (Let's Encrypt) — verify acceptance on the live call.

Reference `Caddyfile`:
```
voice.<domain> {
    reverse_proxy 127.0.0.1:3001 {
        flush_interval -1
    }
}
```

### Process supervision — systemd
- Dedicated non-root `voicebot` user. `Restart=always`, start on boot, load `.env` via
  `EnvironmentFile` (and **drop** the `--env-file` flag from `ExecStart`).
- `KillSignal=SIGTERM` + `TimeoutStopSec=120` to pair with graceful drain (§5).
- **`.env` values must be unquoted** (`KEY=value`, no surrounding quotes, no inline comments)
  — systemd's `EnvironmentFile` parser treats quotes literally, unlike `node --env-file`.

Reference unit (`/etc/systemd/system/voicebot.service`):
```ini
[Unit]
Description=Voicebot streaming server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=voicebot
WorkingDirectory=/opt/voicebot
EnvironmentFile=/opt/voicebot/.env
Environment=LANG=C.UTF-8
ExecStart=/usr/bin/node stream-server.mjs
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=120
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/voicebot

[Install]
WantedBy=multi-user.target
```

### Node
- Pin **Node 24 LTS** (NodeSource + `apt-mark hold nodejs`). Covers native `fetch`, `ws`,
  `@grpc/grpc-js`, and stable `--env-file`.

### Logs
- Rely on **journald** (captures stdout/stderr). Cap it (`SystemMaxUse=500M`,
  `MaxRetentionSec=2week`). UTF-8 locale so Cyrillic renders.

### Security (essential, in scope even for beta)
- **Security group:** allow `443/tcp` + `80/tcp` from anywhere (TLS + Let's Encrypt HTTP-01),
  `22/tcp` **from admin IP only**. Node `3001` bound to `127.0.0.1` — never in an ingress rule.
- **SSH:** key-only (`PasswordAuthentication no`, `PermitRootLogin no`).
- `unattended-upgrades` for OS security patches (schedule reboots — a reboot drops calls).
- **Voximplant source IPs are dynamic** (`api.voximplant.com/getMediaResources`), so an IP
  allowlist on 443 is best-effort noise reduction, not a real control. **TLS is the control.**
  See §8 for the recommended app-level token (deferred but cheap).

### Backups (cheap insurance, in scope)
- One **daily disk snapshot** with a 7-snapshot retention schedule.
- Provision via a documented setup runbook or a `cloud-init` script. (Full Terraform IaC is
  deferred — §8.)

---

## 5. App changes — bare minimum to productionize `stream-server.mjs`

The streaming server is a verified spike. The following are the **only** changes required to
run it safely behind Caddy/systemd 24/7:

1. **Env-driven port + bind to `127.0.0.1`.** Today it hardcodes `port: 3001` on all
   interfaces (`stream-server.mjs:31`). Read `PORT` from env; bind loopback so only Caddy
   reaches it.
2. **`/health` endpoint.** A lightweight HTTP route (separate from the `wss` `/media` path)
   returning `200` when the process/event-loop is responsive, `503` otherwise. Used by uptime
   monitoring. *(Note: `ws`'s `WebSocketServer({ port })` owns the port; serving `/health`
   means attaching the WS server to an `http.Server` and handling the upgrade for `/media`.)*
3. **SIGTERM graceful drain.** On `SIGTERM`: stop accepting new connections (`wss.close()`),
   let the 1–2 in-flight calls finish (deadline ~110 s, under `TimeoutStopSec=120`), then
   `process.exit(0)`. Today there is no signal handler — a deploy/restart drops live calls
   mid-sentence.
4. **Auth token on `/media`.** Require a shared secret (read from env, e.g. `MEDIA_TOKEN`)
   before accepting a `/media` WebSocket — checked against a query param or header on the
   upgrade request; reject (close) the socket otherwise. The matching secret goes into the
   Voximplant scenario's `wss` URL. Cheap (~10 lines) and prevents anyone who finds the URL
   from opening sessions and burning Yandex API spend.

**Out of scope for beta (see §8):** STT 5-minute reconnect, concurrency cap, WS keepalive
ping, dead-air/fallback resilience, retry/backoff, debug-gating the heartbeat log.

---

## 6. Voximplant scenario change (lives in the Voximplant cloud, not this repo)

- Point `VoxEngine.createWebSocket(...)` at **`wss://voice.<domain>/media?token=<MEDIA_TOKEN>`**
  (replacing the ngrok dev URL), carrying the shared secret that the server checks (§5.4).
- Set the outbound media encoding to **`WebSocketAudioEncoding.PCM8`** (or `PCM16_8KHZ`) to
  match the server's 8 kHz PCM16 pipeline. **Do NOT use `WebSocketAudioEncoding.PCM16`** — that
  constant is **16 kHz** — and there is no `WebSocketAudioEncoding.PCM` constant.
- Confirm with the Voximplant account that 24/7 RU production usage is provisioned for the
  number/account (ownership/billing-entity caveat).

---

## 7. Verification plan (before claiming it works)

Per the repo rule "don't claim the live call works without testing it":
1. Backend smoke test locally after code changes (existing offline harnesses / unit tests
   still pass: `node --test speaker.test.mjs bargein.test.mjs sentences.test.mjs
   playback.test.mjs speech.test.mjs`).
2. Stand up the VM + Caddy + systemd; confirm `wss://voice.<domain>/media` accepts a TLS
   connection and `/health` returns 200.
3. **Make a real phone call** through `phone.voximplant.com` and confirm: Ева greets, the loop
   works, and **barge-in still works** over the real cert/domain (ngrok's TLS is gone — the new
   path must be re-verified, not assumed).
4. Confirm `systemctl restart voicebot` drains rather than hard-drops a live test call.

---

## 8. Deferred (before real traffic / scaling) — documented, not done

| Item | Why deferred | When it becomes required |
|---|---|---|
| **STT 5-minute reconnect** | Beta calls are short | SpeechKit caps a streaming session at **5 min (hard limit)**. Any call >5 min loses STT until the gRPC stream is transparently reopened. Required before real/long calls. |
| **In-call resilience / "never dead air"** (cached fallback LPCM clips, per-dependency timeouts, retry/backoff, circuit breaker, callback exit) | Bare-minimum cut | Before real customer traffic — a dependency hiccup currently leaves silence. |
| **Concurrency cap / admission control** | 1–2 calls only | When approaching the VM's tested ceiling. |
| **WS keepalive ping** | Continuous media keeps the socket warm | Long idle gaps / longer calls. |
| **YandexGPT quota bump (10 → 20–30 concurrent sync generations)** | Irrelevant at 1–2 calls | Before going past ~8 concurrent calls. |
| **HA: instance-group-of-1 auto-heal, or size-2 + NLB** | Beta accepts manual recovery | When new-call downtime during host failure/deploys is unacceptable. |
| **Yandex Lockbox for secrets** | `.env` 0600 is acceptable at beta | When you want key rotation / no key on disk. |
| **Full Terraform IaC** | Manual/cloud-init setup is enough for one beta box | When you need reproducible multi-env infra. |
| **Monitoring/alerting** (Yandex Monitoring → Telegram/email + external uptime checker) | Bare-minimum cut | Strongly recommended soon after launch; at minimum add an external uptime check on `/health`. |

---

## 9. Known beta limitations (accepted for now)

- **Calls longer than 5 minutes** will lose speech recognition (STT session hard cap) until
  the reconnect fix (§8) lands.
- **Dependency hiccups produce silence** — no fallback audio/graceful degradation yet.
- **Single VM:** if the host or OS dies, recovery is manual (no auto-heal). `systemd` recovers
  process crashes but not host failure.
- **Cost figure is unverified** (§4) — confirm on the live calculator.

---

## 10. Open questions to confirm during implementation

- Domain: **resolved** — default to a free DuckDNS subdomain unless the user prefers a bought
  domain (§4 "Domain").
- Does `stt-stream.mjs` already detect a server-side stream close (relevant to the deferred
  5-min reconnect)?
- Voximplant account: RU 24/7 production provisioning confirmed?
