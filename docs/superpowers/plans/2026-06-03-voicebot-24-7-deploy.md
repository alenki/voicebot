# Deploy streaming voicebot 24/7 on Yandex Cloud (beta) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement **Phase A** task-by-task. Steps use checkbox (`- [ ]`) syntax. **Phase B is an operator runbook the human runs** — its steps are also checkboxes to track.

**Goal:** Run the streaming voicebot (`stream-server.mjs`) 24/7 on a single low-latency Yandex Cloud VM in `ru-central1`, fronted by Caddy `wss` + systemd, sized for 1–2 beta calls.

**Architecture:** VoxEngine dials `wss://<host>/media?token=…` → Caddy (TLS/Let's Encrypt) → Node on `127.0.0.1:3001`. The VM is co-located with SpeechKit/YandexGPT so per-turn round-trips stay in-region (single-digit-ms). Bare-minimum production hardening only; resilience/HA deferred (see spec §8/§9).

**Tech Stack:** Node 24 LTS, `ws`, `@grpc/grpc-js`, Caddy v2, systemd, Ubuntu 24.04, Yandex Cloud Compute, DuckDNS.

**Spec:** `docs/superpowers/specs/2026-06-03-voicebot-24-7-deploy-design.md`

---

## File structure (Phase A — code)

- **Create** `media-auth.mjs` — pure `parseUpgrade(reqUrl, expectedToken) → {ok, path}`. One job: decide whether a WS upgrade request is allowed (`/media` + valid token). Unit-testable without network.
- **Create** `media-auth.test.mjs` — unit tests for the gate.
- **Modify** `stream-server.mjs` — wrap the WS server in an `http.Server` (adds `/health`), gate upgrades through `parseUpgrade`, read `PORT`/`HOST`/`MEDIA_TOKEN` from env, bind to `127.0.0.1`, add SIGTERM/SIGINT graceful drain.

Everything else (`speech.mjs`, `stt-stream.mjs`, `speaker.mjs`, etc.) is unchanged.

---

# PHASE A — Code changes (Claude does these)

### Task 1: `media-auth.mjs` — the upgrade gate (TDD)

**Files:**
- Create: `media-auth.mjs`
- Test: `media-auth.test.mjs`

- [ ] **Step 1: Write the failing tests**

`media-auth.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpgrade } from "./media-auth.mjs";

test("принимает /media с верным токеном", () => {
  assert.deepEqual(parseUpgrade("/media?token=secret", "secret"), { ok: true, path: "/media" });
});

test("отклоняет /media с неверным токеном", () => {
  assert.equal(parseUpgrade("/media?token=wrong", "secret").ok, false);
});

test("отклоняет /media без токена, когда токен задан", () => {
  assert.equal(parseUpgrade("/media", "secret").ok, false);
});

test("отклоняет чужой путь даже с верным токеном", () => {
  assert.equal(parseUpgrade("/other?token=secret", "secret").ok, false);
});

test("без заданного токена пускает /media (dev-режим)", () => {
  assert.equal(parseUpgrade("/media", "").ok, true);
});

test("кривой URL не роняет, а отклоняется", () => {
  assert.equal(parseUpgrade(undefined, "secret").ok, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test media-auth.test.mjs`
Expected: FAIL — `Cannot find module './media-auth.mjs'` (or "parseUpgrade is not a function").

- [ ] **Step 3: Write the minimal implementation**

`media-auth.mjs`:
```js
// Гейт на upgrade WebSocket: пускаем только путь /media и (если задан) верный токен.
// Чистая функция — тестируется без сети. Используется в stream-server.mjs на событии "upgrade".
export function parseUpgrade(reqUrl, expectedToken) {
  let u;
  try {
    u = new URL(reqUrl ?? "", "http://localhost"); // base — чтобы парсить относительный путь
  } catch {
    return { ok: false, path: null };
  }
  if (u.pathname !== "/media") return { ok: false, path: u.pathname };
  if (!expectedToken) return { ok: true, path: u.pathname }; // токен не задан → dev-режим, пускаем
  return { ok: u.searchParams.get("token") === expectedToken, path: u.pathname };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test media-auth.test.mjs`
Expected: PASS — `# pass 6  # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add media-auth.mjs media-auth.test.mjs
git commit -m "feat: add /media WebSocket upgrade auth gate"
```

---

### Task 2: Wrap `stream-server.mjs` in an HTTP server (`/health`, env config, auth gate, bind localhost)

**Files:**
- Modify: `stream-server.mjs` (imports; the `PORT`/server block near lines 13–33; the listen log at line 357)

- [ ] **Step 1: Update the imports**

In `stream-server.mjs`, change the `ws` import block (currently starting line 13) to add `http` and the gate. Replace:
```js
import { WebSocketServer } from "ws";
```
with:
```js
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { parseUpgrade } from "./media-auth.mjs";
```

- [ ] **Step 2: Replace the `PORT` constant + server creation with env config + HTTP server + gated upgrade**

Replace this block (currently line 23):
```js
const PORT = 3001;
```
...and the later server-creation line (currently line 31):
```js
const wss = new WebSocketServer({ port: PORT, path: "/media" });
```
with a single block. Put this where `const PORT = 3001;` was, and **delete** the old `const wss = new WebSocketServer({ port: PORT, path: "/media" });` line:
```js
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "127.0.0.1"; // за Caddy: слушаем только localhost
const MEDIA_TOKEN = process.env.MEDIA_TOKEN || "";
if (!MEDIA_TOKEN) {
  console.warn("⚠ MEDIA_TOKEN не задан — /media открыт без авторизации (только для dev/offline-тестов)");
}

// Состояние для /health и graceful drain (объявлено до обработчиков, которые его читают).
let draining = false;
const conns = new Set();

// HTTP-сервер: отдаёт /health для мониторинга; апгрейд на /media уходит в WebSocketServer.
const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(draining ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: draining ? "draining" : "ok", calls: conns.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

// Гейт апгрейда: только /media + верный токен (см. media-auth.mjs). Иначе рвём сокет.
httpServer.on("upgrade", (req, socket, head) => {
  if (!parseUpgrade(req.url, MEDIA_TOKEN).ok) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
```

- [ ] **Step 3: Track live connections inside the connection handler**

The connection handler currently begins (line 33–34):
```js
wss.on("connection", (ws) => {
  const callId = "stream-" + Date.now();
```
Add connection tracking immediately after `const callId = ...`:
```js
wss.on("connection", (ws) => {
  const callId = "stream-" + Date.now();
  conns.add(ws);
```
And in the existing `ws.on("close", ...)` handler (currently line 347), add `conns.delete(ws);` as its first line:
```js
  ws.on("close", () => {
    conns.delete(ws);
    console.log(`[${callId}] отключился`);
```

- [ ] **Step 4: Replace the startup log with `httpServer.listen(...)`**

Replace the final line (currently line 357):
```js
console.log(`Стриминговый сервер слушает ws://localhost:${PORT}/media`);
```
with:
```js
httpServer.listen(PORT, HOST, () => {
  console.log(`Стриминговый сервер слушает на ${HOST}:${PORT} — ws /media, health /health`);
});
```

- [ ] **Step 5: Verify it starts and `/health` works (manual, no Yandex needed)**

Run (PowerShell, from the repo dir):
```
$env:MEDIA_TOKEN="testsecret"; node stream-server.mjs
```
Expected log: `Стриминговый сервер слушает на 127.0.0.1:3001 — ws /media, health /health`
In a second terminal:
```
curl http://127.0.0.1:3001/health
```
Expected: `{"status":"ok","calls":0}`
Then stop the server with Ctrl+C (it should exit promptly — drain handler added in Task 3 makes this clean).

- [ ] **Step 6: Verify existing unit tests still pass**

Run: `node --test speaker.test.mjs bargein.test.mjs sentences.test.mjs playback.test.mjs speech.test.mjs media-auth.test.mjs`
Expected: all pass (`# fail 0`).

- [ ] **Step 7: Commit**

```bash
git add stream-server.mjs
git commit -m "feat: HTTP server with /health, env-driven port/host, gated /media upgrade"
```

---

### Task 3: SIGTERM/SIGINT graceful drain in `stream-server.mjs`

**Files:**
- Modify: `stream-server.mjs` (append after the `httpServer.listen(...)` block)

- [ ] **Step 1: Add the shutdown handler**

Append to the end of `stream-server.mjs`:
```js
// Graceful drain: на SIGTERM/SIGINT перестаём принимать новые звонки, даём активным
// договорить (до дедлайна, чуть меньше systemd TimeoutStopSec=120), затем выходим.
function shutdown(signal) {
  if (draining) return;
  draining = true;
  console.log(`${signal}: graceful drain, активных звонков: ${conns.size}`);
  wss.close();        // не принимаем новые WebSocket-апгрейды
  httpServer.close();  // не принимаем новые HTTP-соединения (live /health дослуживаются)
  const deadline = Date.now() + 110_000;
  const iv = setInterval(() => {
    if (conns.size === 0 || Date.now() > deadline) {
      clearInterval(iv);
      for (const ws of conns) { try { ws.close(1001, "server restart"); } catch {} }
      console.log("drain завершён — выходим");
      process.exit(0);
    }
  }, 1000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

- [ ] **Step 2: Verify drain on an idle server**

Run: `node stream-server.mjs` (no token needed for this check), then press Ctrl+C.
Expected logs: `SIGINT: graceful drain, активных звонков: 0` → `drain завершён — выходим`, and the process exits within ~1 s (no active calls).

- [ ] **Step 3: Commit**

```bash
git add stream-server.mjs
git commit -m "feat: graceful SIGTERM/SIGINT drain (stop new calls, finish in-flight)"
```

---

### Task 4: Push so the VM can pull it

- [ ] **Step 1: Push the commits to GitHub**

These three commits must be on `origin` before Phase B clones them. From the repo:
```bash
git push origin HEAD
```
(If you made them on `main`, that's `git push origin main`. The VM will clone whatever branch you push — note the branch name for Phase B, Task 7.)
Expected: GitHub shows the new commits in `alenki/voicebot`.

---

# PHASE B — Provisioning runbook (you do these, in order)

> Everything below is in the Yandex Cloud / DuckDNS / Voximplant web consoles and over SSH. Commands are for the **Ubuntu VM** unless they say PowerShell. Keep your VPN **off** on the VM (Yandex API calls fail behind some VPNs).

### Task 5: Create the SSH key + the VM

- [ ] **Step 1: Make an SSH key on your Windows machine (if you don't have one)**

PowerShell:
```
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_ed25519 -N '""'
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```
Copy the printed public key (starts with `ssh-ed25519 …`).

- [ ] **Step 2: Create the VM in the Yandex Cloud console**

Compute Cloud → **Create VM**:
- **Image:** Ubuntu 24.04 LTS.
- **Availability zone:** any `ru-central1` zone (e.g. `ru-central1-a`).
- **Platform:** Intel Ice Lake (`standard-v3`).
- **vCPU:** 2 · **Guaranteed vCPU share: 100%** · **RAM:** 2 GB.
- **Disk:** SSD, 20 GB.
- **Public IP:** Auto (you'll make it static in Task 5.3).
- **Access → Login:** `voxadmin` · **SSH key:** paste the public key from Step 1.
- Create. Wait until it's RUNNING and note the **public IP**.

- [ ] **Step 3: Make the public IP static**

VPC → **IP addresses** → find the VM's address → **Make static** (so it survives reboots — DuckDNS points at it).

- [ ] **Step 4: First SSH in**

PowerShell:
```
ssh voxadmin@<PUBLIC_IP>
```
Expected: an Ubuntu shell prompt (`voxadmin@…:~$`). Type `yes` to accept the host key on first connect.

---

### Task 6: Lock down the firewall (security group) + SSH

- [ ] **Step 1: Find your own public IP**

In a browser visit `https://2ip.ru` (or `https://ifconfig.me`) and note your IP — this is the only IP allowed to SSH.

- [ ] **Step 2: Create + attach a security group**

VPC → **Security groups** → Create, in the VM's network. Add **ingress** rules:
- TCP **443** from CIDR `0.0.0.0/0`  (wss media + Let's Encrypt + health-over-TLS)
- TCP **80** from CIDR `0.0.0.0/0`  (Let's Encrypt HTTP-01 challenge)
- TCP **22** from CIDR `<YOUR_IP>/32`  (SSH, admin only)
Leave **egress** as allow-all (the VM must reach `*.api.cloud.yandex.net`).
Then attach this security group to the VM's network interface (Compute → the VM → Edit → Security groups).

- [ ] **Step 3: Harden SSH on the VM**

On the VM:
```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```
Expected: no error; your existing SSH session stays open (don't close it until you've confirmed a fresh `ssh voxadmin@<IP>` still works in a new window).

- [ ] **Step 4: Enable automatic security updates**

```bash
sudo apt-get update && sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # choose "Yes"
```

---

### Task 7: Point a domain (DuckDNS) at the VM

- [ ] **Step 1: Create a DuckDNS subdomain**

Go to `https://www.duckdns.org`, sign in (Google/GitHub), create a subdomain — e.g. `mybot` → giving you **`mybot.duckdns.org`**. Set its **current IP** to your VM's static public IP. Note your DuckDNS **token** (only needed if you later automate IP updates).

- [ ] **Step 2: Verify DNS resolves to the VM**

PowerShell:
```
nslookup mybot.duckdns.org
```
Expected: it resolves to your VM's static public IP. (Use **your** subdomain throughout the rest — replace `mybot.duckdns.org` everywhere below.)

---

### Task 8: Install Node, deploy the app, create `.env`

- [ ] **Step 1: Install Node 24 LTS + git (on the VM)**

```bash
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo apt-mark hold nodejs
node --version
```
Expected: `v24.x.x`.

- [ ] **Step 2: Create the service user + app directory**

```bash
sudo useradd --system --create-home --home-dir /opt/voicebot --shell /usr/sbin/nologin voicebot
```
Expected: no output (user created).

- [ ] **Step 3: Get the code onto the VM**

The repo is at `github.com/alenki/voicebot`. Clone the branch you pushed in Task 4 (`<branch>` = `main` unless you used another):
```bash
sudo git clone -b <branch> https://github.com/alenki/voicebot.git /opt/voicebot
```
If the repo is **private**, this prompts for a username + a **GitHub Personal Access Token** (Settings → Developer settings → Tokens) as the password. Then:
```bash
sudo chown -R voicebot:voicebot /opt/voicebot
ls /opt/voicebot/proto   # must list: google  yandex
```
Expected: `proto/` contains `google` and `yandex` (the gRPC STT protos — required at runtime).

- [ ] **Step 4: Install dependencies**

```bash
cd /opt/voicebot
sudo -u voicebot -H npm install --omit=dev
```
Expected: installs `express`, `ws`, `@grpc/grpc-js`, `@grpc/proto-loader` with no errors.

- [ ] **Step 5: Create `.env` on the VM (never from git — values UNQUOTED)**

Generate a media token:
```bash
openssl rand -hex 24
```
Copy the output, then create the file:
```bash
sudo -u voicebot tee /opt/voicebot/.env >/dev/null <<'EOF'
YANDEX_API_KEY=PUT_YOUR_KEY_HERE
YANDEX_FOLDER_ID=PUT_YOUR_FOLDER_ID_HERE
MEDIA_TOKEN=PUT_THE_GENERATED_TOKEN_HERE
PORT=3001
HOST=127.0.0.1
EOF
sudo chmod 600 /opt/voicebot/.env
```
Then edit in the real values:
```bash
sudo -u voicebot nano /opt/voicebot/.env
```
⚠ **No quotes, no inline comments** — systemd reads quotes literally. Save your `YANDEX_API_KEY` / `YANDEX_FOLDER_ID` (same ones from your local `.env`) and the generated `MEDIA_TOKEN`. **Keep the `MEDIA_TOKEN` handy — it goes into the Voximplant URL in Task 12.**

---

### Task 9: Install Caddy (TLS + reverse proxy)

- [ ] **Step 1: Install Caddy**

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```
Expected: `caddy version` prints a v2.x version.

- [ ] **Step 2: Write the Caddyfile (use YOUR DuckDNS domain)**

Set a shell variable to your domain, then write the file (so the domain is substituted correctly):
```bash
DOMAIN=mybot.duckdns.org   # <-- change to YOUR subdomain
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:3001 {
        flush_interval -1
    }
}
EOF
sudo systemctl reload caddy
```
(`flush_interval -1` = flush 20 ms audio frames immediately; WebSocket upgrade is automatic in Caddy v2 — no extra directives. Note the heredoc uses unquoted `EOF` so `$DOMAIN` expands.)

- [ ] **Step 3: Confirm Caddy obtained a TLS certificate**

```bash
sudo journalctl -u caddy --no-pager | grep -i "certificate obtained" | tail -1
```
Expected: a line showing a certificate was obtained for your domain (needs ports 80/443 open + DNS resolving to this VM — Tasks 6 & 7).

---

### Task 10: Run the app under systemd

- [ ] **Step 1: Create the service unit**

```bash
sudo tee /etc/systemd/system/voicebot.service >/dev/null <<'EOF'
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
EOF
```

- [ ] **Step 2: Cap journald size (so verbose per-call logs don't fill the disk)**

```bash
sudo sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
sudo sed -i 's/^#\?MaxRetentionSec=.*/MaxRetentionSec=2week/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

- [ ] **Step 3: Enable + start the service**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now voicebot
sudo systemctl status voicebot --no-pager
```
Expected: `active (running)`, and a log line `Стриминговый сервер слушает на 127.0.0.1:3001 — ws /media, health /health`. (No `MEDIA_TOKEN не задан` warning — if you see it, `.env` didn't load; re-check Task 8.5.)

- [ ] **Step 4: Verify health locally and through Caddy (TLS)**

```bash
curl -s http://127.0.0.1:3001/health
curl -s https://<YOUR_SUBDOMAIN>.duckdns.org/health
```
Expected: both print `{"status":"ok","calls":0}`. The second proves TLS + the Caddy→Node path work end to end.

---

### Task 11: Daily disk snapshots (cheap insurance)

- [ ] **Step 1: Create a snapshot schedule**

Compute Cloud → **Snapshot schedules** → Create:
- Add the VM's boot disk.
- Schedule: **daily**. Retention: **keep 7**.
- Save.

Expected: the schedule lists the disk and shows the next run time.

---

### Task 12: Update the Voximplant scenario (in the Voximplant console)

- [ ] **Step 1: Point the scenario at the production wss URL with the token**

In your VoxEngine scenario, change the WebSocket creation to your domain + token (from `.env`):
```js
const ws = VoxEngine.createWebSocket(
  "wss://<YOUR_SUBDOMAIN>.duckdns.org/media?token=<MEDIA_TOKEN>"
);
```

- [ ] **Step 2: Set the audio encoding to 8 kHz PCM**

In the `call.sendMediaTo(ws, {...})` call, set:
```js
call.sendMediaTo(ws, { encoding: WebSocketAudioEncoding.PCM8 });
```
⚠ Use **`PCM8`** (8 kHz). Do **not** use `PCM16` — that constant is **16 kHz** and will mismatch the server's 8 kHz pipeline. There is no `WebSocketAudioEncoding.PCM` constant.

- [ ] **Step 3: Save the scenario** and confirm the number is bound to it.

---

### Task 13: Verify with a real call (the only true test)

- [ ] **Step 1: Watch the logs**

On the VM:
```bash
journalctl -u voicebot -f
```

- [ ] **Step 2: Call the number** via your Voximplant phone number / `phone.voximplant.com`.

Expected in the logs: `[stream-…] подключился` → `start: PCM16 @ 8000 Гц` → greeting plays → your speech appears as partials/finals → Ева replies. Confirm by ear: **greeting, a back-and-forth turn, and barge-in** (talk over Ева — she should stop). The new TLS/domain path replaces ngrok, so this must be confirmed live, not assumed.

- [ ] **Step 3: Confirm graceful drain doesn't murder a live call**

While on a test call, from a second SSH session: `sudo systemctl restart voicebot`. Expected log: `SIGTERM: graceful drain, активных звонков: 1` and the call finishes its current exchange rather than cutting instantly.

- [ ] **Step 4: If the call fails, check in this order**

- `journalctl -u voicebot -n 50` — app errors (e.g. `STT ошибка`, `LLM ошибка` → check `.env` keys / VPN off).
- `sudo journalctl -u caddy -n 50` — TLS/cert or proxy errors.
- A `403`/instant close with no `подключился` log → token mismatch between the Voximplant URL and `.env` `MEDIA_TOKEN`, or DNS/firewall (Tasks 6–7).

---

## Known beta limitations now live (from spec §9)

- Calls **> 5 minutes** lose STT (SpeechKit hard session cap — reconnect deferred).
- A SpeechKit/GPT/TTS hiccup produces **silence** (no dead-air fallback yet).
- **Single VM:** host/OS failure needs manual recovery (`systemctl`/snapshot rebuild).

These are accepted for beta and tracked in the spec's deferred list (§8).
