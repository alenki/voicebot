# Free 24/7 cloud deploy — runbook (2026-07-13)

**Goal:** both voicebot servers (`server.mjs` :3000 turn-based + `stream-server.mjs` :3001
streaming) running 24/7 on a free cloud server, lowest possible latency, replacing the
home-PC + ngrok setup.

**Research provenance:** all hosting/network facts below were web-verified 2026-07-13 by a
7-agent research workflow (4 researchers + 3 adversarial fact-checkers). Key sources are
cited inline; full findings in the session memory `free-hosting-research-2026-07`.

---

## Decisions (verified 2026-07-13)

1. **No tunnel, no domain, no TLS needed.** VoxEngine docs (fetched live):
   `createWebSocket` — *"For the ws:// protocol, it can accept both domain and IP
   addresses"*; `Net.httpRequest` does plain `http://` too. So the scenario can point
   straight at `ws://<VM_IP>:3001/media?token=…` and `http://<VM_IP>:3000/reply`.
   Trade-off: call audio is unencrypted in transit → mitigated by `STREAM_SECRET` gate;
   optional wss upgrade in §Optional TLS below.
2. **ngrok is disqualified** for production: Russian IPs fully blocked since ~04-2025
   (Error 1022 / ERR_NGROK_9040) AND free tier capped 2026-02 at 1 GB/month transfer
   (~8–17 h of 8 kHz call audio). It worked for our tests only because the dev machine and
   the connecting Voximplant platform were outside Russia. Cloudflare Tunnel is also out:
   Russian ISPs throttle Cloudflare-proxied connections to ~16 KB/connection since
   2025-06 (cloudflare blog, ongoing per 2026-04 reporting).
3. **Free-forever hosting in Russia does not exist** (as of 2026-07-13). Cloud.ru
   Evolution's free VM closed to accounts registered after **2026-06-30**. Yandex Cloud's
   permanent free tier is serverless-only (per-message WS invocations, 60-min WS cap,
   cold starts) — architecturally incompatible with the streaming media loop.
4. **The two real free options** (details + steps below):
   - **A. Рег.облако (reg.cloud) Free Tier FT1** — Moscow, 1 vCPU / 1 GB / 10 GB NVMe,
     always-on, **free 6 months** (launched 2026-04-17), then rolls onto a paid tariff
     (~150–300 ₽/mo class). Needs Russian identification. **Lowest latency** (single-digit
     ms to Yandex ru-central1 and Voximplant RU).
   - **B. Oracle Cloud Always Free** — EU home region (Amsterdam 46 ms / Stockholm 49 ms /
     Frankfurt 51 ms RTT from Moscow), Ampere A1 **2 OCPU / 12 GB** (halved from 4/24 on
     2026-06-15), **free indefinitely**. Needs a non-Russian, non-prepaid card; signup
     impossible from Russia (Oracle trade-compliance), Egypt not embargoed but self-serve
     signup unconfirmed. June-2026 reports: free (non-PAYG) tenancies can no longer create
     ARM instances → **upgrade to Pay-As-You-Go** (still $0 within Always Free limits) and
     it also (community-verified, no longer doc-guaranteed) stops idle reclamation.
     Add a keep-busy job: Oracle reclaims instances whose 7-day 95th-pct CPU AND network
     AND memory are all <20%.
   - Fallback **C. ClawCloud Run** (Frankfurt) — recurring $5/month free credit (GitHub
     account ≥180 days, no card), containers, ~10 GB/mo traffic (~130 h audio). WS support
     not officially documented; young platform. Demo-grade only; needs a Dockerfile.
5. **Latency impact:** Moscow host ≈ +0 ms; EU host ≈ +50 ms RTT on the Voximplant media
   leg and on every Yandex STT/LLM/TTS round-trip → roughly +150–250 ms voice-to-voice.
   US hosts (+175 ms RTT, e.g. free GCP e2-micro, US-only) are unfit. (RTTs: WonderNetwork
   Moscow matrix, 2026-07-13.)
6. **ElevenLabs-from-Russia check (blocker for option A):** before committing to a Moscow
   VM, verify `api.elevenlabs.io` responds from the VM (US AI services often reject RU
   IPs). If blocked: either `TTS_PROVIDER=yandex` (marina) on the Moscow VM, or host in EU
   (option B) where both providers are reachable.

---

## Phase 1 — get the server

### Option A: Рег.облако Free Tier (Moscow, free 6 months)

All details below re-verified 2026-07-13 directly on reg.cloud official pages
(offer: `reg.cloud/services/free-tier`, ordering doc:
`reg.cloud/support/cloud/oblachnyye-servery/zakaz-i-upravleniye-uslugoy-oblachnyye-servery/besplatnyy-server-free-tier`,
идентификация doc: `reg.cloud/support/cloud/nachalo-raboty/kak-proyti-identifikatsiyu-kliyentam-reg-oblaka`).

**Eligibility:** accounts registered on/after **2026-04-13**, OR older accounts that never
ordered any Рег.облако service. One free server per account. Included free: 1 vCPU /
1 GB RAM / 10 GB SSD (tariff «Стандартный +»), **1 public IPv4 (confirmed included)**,
basic DDoS protection; bandwidth capped 20 Мбит/с (fine — one call ≈ 0.3 Мбит/с).
DCs: Москва / Санкт-Петербург / Самара — **pick Москва**.

1. **Register** at `cloud.reg.ru/panel/auth` (creates a Рег.ру account).
2. **Fill in the account-owner contact details** in the Рег.ру cabinet
   (Настройки → Контакты владельца аккаунта) — идентификация FAILS without this.
3. **Pass идентификация** (hosting-law requirement, one of):
   - **Госуслуги** (confirmed account): Настройки → «Пройти идентификацию» → authorize.
   - **Card top-up with auto-identification**: when topping up, toggle «Пройти
     автоматическую идентификацию» ON and pay from a **Russian, non-prepaid card in the
     account owner's own name** (kills steps 3+4 in one action).
   - **SMS**: bind a Russian-operator mobile number in Настройки (re-bind if already bound).
   - Fallback for non-Russians: document upload (passport) + foreign-currency wire for
     the balance — slow/untested; realistically the owner should do the signup.
4. **Top up the cloud balance ≥100 ₽** (panel → Финансы → Пополнить; card / СБП /
   SberPay / ЮMoney; credits in 10–15 min). Balance must stay positive.
5. **Order the server**: panel → **Новый ресурс → Сервер** → tariff **«Стандартный +»**
   → free tariff **«Free Tier»** → OS **Ubuntu 24.04** → region **Москва** → skip paid
   extras (floating IP / backups / extended DDoS — the included IP suffices) → add
   **SSH public key** + server name → **Создать сервер**. Ready in minutes; connection
   details emailed.
6. Note the public IP. **Calendar-mark the 6-month expiry**: the server auto-switches to
   paid tariff «Stdp C1-M1-D10» ≈ **586 ₽/mo** at 2026-02 prices (CPU 119.49 + RAM 195.54
   + 10 GB SSD 108.60 + IP 162.94 ₽/mo); if the balance can't cover it → suspended 7 days
   → **deleted permanently**. Before expiry: top up, or migrate to a cheaper VPS
   (~300 ₽/mo class), or renegotiate with the owner.

Free Tier can't be resized; scaling = switching to a paid tariff (no data migration).
The program can be changed/closed by Рег.ру at any time — order sooner rather than later.

### Option B: Oracle Cloud Always Free (EU, free forever)
1. Sign up at `oracle.com/cloud/free` — real credit/debit card (no prepaid/virtual;
   small temporary auth hold), one account per email. **Home region: Amsterdam or
   Stockholm** (Frankfurt is the most capacity-starved for free ARM). Home region is
   locked forever at signup.
2. **Upgrade the account to Pay-As-You-Go** (Console → Account Management). Reasons:
   free-only tenancies reportedly can't create ARM instances since ~06-2026; PAYG
   accounts get capacity and (community-verified) exemption from idle reclamation;
   Always Free usage remains $0. Immediately set a **budget alert at ~$1**.
3. Create instance: **VM.Standard.A1.Flex, 2 OCPU / 12 GB** (do NOT exceed — the free
   limit was halved to 2/12 on 2026-06-15), **Ubuntu 24.04 (aarch64)**, in the home
   region. If "Out of host capacity": try each availability/fault domain, retry later.
   Assign/keep a **reserved (static) public IP**.
4. Open the network path — Oracle needs BOTH layers:
   - VCN Security List ingress: TCP 3000, 3001 from `0.0.0.0/0`; TCP 22 from admin IP.
   - On-VM iptables (Oracle Ubuntu images end INPUT with REJECT):
     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3001 -j ACCEPT
     sudo netfilter-persistent save
     ```
5. Keep-busy job (belt-and-suspenders vs idle reclaim — criteria: 7-day 95th-pct CPU,
   network AND memory all <20%):
   ```bash
   sudo apt-get install -y stress-ng
   ( crontab -l 2>/dev/null; echo '0 3 * * * stress-ng --cpu 1 --cpu-load 30 --timeout 7200' ) | crontab -
   ```
   (2 h/day at 30% ≈ 8.3% of the week above 20% → 95th percentile ≥20%.)

---

## Phase 2 — common VM setup (options A and B)

SSH in (`ssh ubuntu@<IP>` on Oracle; user per panel on Reg.ru), then:

1. **Basics + firewall (Reg.ru / any non-Oracle box):**
   ```bash
   sudo apt-get update && sudo apt-get -y upgrade
   sudo ufw allow 22/tcp && sudo ufw allow 3000/tcp && sudo ufw allow 3001/tcp && sudo ufw enable
   sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
   ```
2. **Node 24 + git:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   sudo apt-mark hold nodejs
   node --version   # v24.x
   ```
3. **Deploy the code** (push local commits to GitHub first):
   ```bash
   sudo useradd --system --create-home --home-dir /opt/voicebot --shell /usr/sbin/nologin voicebot
   sudo git clone https://github.com/alenki/voicebot.git /opt/voicebot   # PAT if private
   sudo chown -R voicebot:voicebot /opt/voicebot
   cd /opt/voicebot && sudo -u voicebot -H npm install --omit=dev
   ls proto   # must list: google yandex (gRPC protos needed at runtime)
   ```
4. **Create `.env`** (copy values from the local machine's `.env`; NEVER from git):
   ```bash
   sudo -u voicebot nano /opt/voicebot/.env
   sudo chmod 600 /opt/voicebot/.env
   ```
   Must contain: `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`, `ELEVENLABS_API_KEY` + voice vars (if using ElevenLabs), and —
   **fixes the Tier-1 open-endpoint blocker** — freshly generated secrets:
   ```bash
   openssl rand -hex 24   # run twice → REPLY_SECRET and STREAM_SECRET
   ```
5. **Provider reachability test (critical on a Moscow VM):**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://api.elevenlabs.io/v1/models   # 401 = reachable; timeout/403 = geo-blocked
   curl -s -o /dev/null -w '%{http_code}\n' https://api.telegram.org
   ```
   If ElevenLabs is blocked from the RU IP: set `TTS_PROVIDER=yandex` or switch to option B.
6. **Two systemd services** (`node --env-file` keeps parity with local dev):

   `/etc/systemd/system/voicebot.service` — and a copy `voicebot-stream.service` with
   `server.mjs` → `stream-server.mjs` in `ExecStart`:
   ```ini
   [Unit]
   Description=Voicebot turn-based backend (:3000)
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=voicebot
   WorkingDirectory=/opt/voicebot
   Environment=LANG=C.UTF-8
   ExecStart=/usr/bin/node --env-file=.env server.mjs
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
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now voicebot voicebot-stream
   systemctl status voicebot voicebot-stream --no-pager
   ```
   Both servers already ship graceful SIGTERM drain, `/health`, fail-fast on missing
   Yandex env, and the token gates — no code changes required.
7. **Cap journald** (verbose per-call logs): in `/etc/systemd/journald.conf` set
   `SystemMaxUse=500M`, `MaxRetentionSec=2week`, then `sudo systemctl restart systemd-journald`.
8. **Health checks from your own PC:**
   ```
   curl http://<IP>:3000/health
   curl http://<IP>:3001/health
   ```

## Phase 3 — re-point Voximplant (one-time, IP never rotates)

In the Voximplant scenario(s):
- Turn-based: `BACKEND = http://<IP>:3000/reply`, `BACKEND_END = http://<IP>:3000/end`,
  header `X-Backend-Token: <REPLY_SECRET>` (scenario var `BACKEND_TOKEN`).
- Streaming: `VoxEngine.createWebSocket("ws://<IP>:3001/media?token=<STREAM_SECRET>")`
  — plain `ws://`, IP allowed per docs. Keep `WebSocketAudioEncoding.PCM8` (8 kHz).
- Save; make a **real test call** (both paths) watching `journalctl -u voicebot-stream -f`.
  Verify: greeting, turns, barge-in, lead lands in Telegram, `systemctl restart` drains
  instead of dropping a live call. Per repo rules, nothing is "working" until this call.

## Optional TLS upgrade (later, still free)

If encrypted media is wanted: free DuckDNS subdomain → A record to the VM IP → install
Caddy → `reverse_proxy 127.0.0.1:3001` with `flush_interval -1` → scenario URL becomes
`wss://<name>.duckdns.org/media?token=…`. (The 2026-06-03 plan has the full Caddy steps;
add routing `/media`→3001, rest→3000 to also cover `/reply` over https.)

## Ops notes / risks

- **leads.ndjson** (fallback lead journal) now lives on the VM — back it up or scp it
  periodically; it's the only copy of leads that failed Telegram delivery.
- Oracle-specific: silent free-tier changes happen (June 2026 halving proves it); budget
  alert + keep-busy + PAYG are the mitigations. Account terminations without appeal are
  reported — keep the repo + `.env` copies off-box.
- Reg.ru-specific: 6-month clock, then ≈586 ₽/mo (or migrate); public IPv4 confirmed
  included in the free tariff; balance must stay positive at all times.
- ngrok stays useful ONLY for local dev outside Russia; never for production.
- Cheapest paid safety net if both free options fail: RU VPS ~150–300 ₽/mo (RuVDS/
  Timeweb 1 GB class) or Fly.io/Hetzner ~$2–5/mo in EU.
