# Make the Bot Useful (Ева) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the `SYSTEM` prompt in `server.mjs` so the bot answers real questions about Альфа Принт as a natural-sounding employee named Ева and captures order requests without inventing prices/timelines.

**Architecture:** Approach B — split the prompt into a `FACTS` data block and a `BEHAVIOR` block (persona + order-capture flow + guardrails) composed into `SYSTEM`. No other `server.mjs` logic changes. Add a repeatable behavioral verification script and update the canonical Voximplant scenario greeting in `README.md`.

**Tech Stack:** Node.js (ESM `.mjs`), Express, YandexGPT via `ask()` in `speech.mjs`. Verification by running scripted `POST /reply` turns and reading the output (the repo convention — LLM output is non-deterministic, so checks are human-judged, not string asserts).

---

## File Structure

- **Modify `server.mjs`** — replace the single `SYSTEM` const (lines 7–12) with `FACTS`, `BEHAVIOR`, and a composed `SYSTEM`. Everything else (`/reply`, `/end`, dialog `Map`, Express setup) untouched.
- **Create `verify-eva.mjs`** — a standalone script that runs a scripted multi-turn dialog against the running backend's `/reply` (one `callId`) and prints `клиент / Ева` lines. Mirrors the existing `test.mjs` manual-smoke convention.
- **Modify `README.md`** — update the greeting line inside the "The Voximplant `inbound` scenario" code block (canonical copy of the cloud scenario) to introduce Ева.

> **Note on the running backend:** a backend process is already running with the OLD prompt loaded in memory. After editing `server.mjs` it must be restarted for the change to take effect. Restart steps are included.

---

### Task 1: Rewrite the prompt in `server.mjs` (FACTS + BEHAVIOR + SYSTEM)

**Files:**
- Modify: `server.mjs:7-12` (the `SYSTEM` const)

- [ ] **Step 1: Replace the `SYSTEM` const with three consts**

Replace exactly this block (current lines 7–12):

```js
   const SYSTEM =
     "Ты — голосовой ассистент типографии и рекламного агентства. " +
     "Отвечай вежливо, кратко, по-русски, как в телефонном разговоре: " +
     "короткими фразами, без списков и разметки. Помогай с вопросами по услугам " +
     "(визитки, листовки, баннеры, печать, дизайн), примерным срокам и оформлению заказа. " +
     "Точные цены не выдумывай: если не уверен — скажи, что уточнит менеджер, и предложи записать заявку.";
```

with (preserve the file's 3-space indentation on the `const` lines; the template-literal
contents are left-aligned on purpose):

```js
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

Что ты делаешь: рассказываешь об услугах, адресе, режиме работы и контактах (см. ФАКТЫ) и помогаешь оформить заявку на заказ.

Цены и сроки: никогда не называй конкретные цены и сроки и не выдумывай их. Если спрашивают — объясни, что это зависит от тиража, размера и материала, и что менеджер рассчитает точно. Предложи оформить заявку, чтобы менеджер перезвонил с расчётом.

Оформление заявки: когда клиент хочет заказать, спокойно собери детали, спрашивая по одному-два пункта за раз (не все сразу): 1) что нужно изготовить; 2) тираж; 3) формат или размер; 4) материал, если применимо; 5) желаемый срок; 6) имя и номер телефона. Если клиент чего-то не знает — это нормально, иди дальше, менеджер уточнит. В конце кратко повтори заявку своими словами и попроси подтвердить. Скажи, что передашь заявку менеджеру и он перезвонит с ценой и сроком.

Если вопрос не по теме — вежливо верни разговор к услугам «Альфа Принт». Если не расслышала — вежливо переспроси.`;

   const SYSTEM = `${BEHAVIOR}\n\nФАКТЫ О КОМПАНИИ:\n${FACTS}`;
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check server.mjs`
Expected: no output, exit code 0 (no syntax error).

- [ ] **Step 3: Restart the backend so the new prompt loads**

Stop the currently-running backend process, then start it fresh:
Run: `node --env-file=.env server.mjs`
Expected: prints `Backend слушает http://localhost:3000`. (VPN must be OFF.)

- [ ] **Step 4: Commit**

```bash
git add server.mjs
git commit -m "feat: rewrite SYSTEM prompt as Ева (FACTS + BEHAVIOR)"
```

---

### Task 2: Add a repeatable behavioral verification script

**Files:**
- Create: `verify-eva.mjs`

- [ ] **Step 1: Create `verify-eva.mjs`**

```js
// Scripted behavioral check for the Ева prompt.
// Requires the backend running on :3000. Run: node verify-eva.mjs
const BASE = "http://localhost:3000";
const callId = "verify-eva";

const turns = [
  "Здравствуйте! Сколько стоит напечатать визитки?",       // price → must NOT give a number
  "А баннер три на шесть метров за сколько сделаете?",       // price again
  "Давайте оформим заказ на визитки.",                       // start order capture
  "Тираж тысяча штук, размер стандартный.",                  // give some details
  "Меня зовут Аслан, телефон 928 111 22 33.",                // contact
  "Вы робот?",                                               // must deflect, stay in role
];

async function reply(text) {
  const res = await fetch(`${BASE}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId, text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).reply;
}

for (const text of turns) {
  console.log(`\nКлиент: ${text}`);
  console.log(`Ева:    ${await reply(text)}`);
}

await fetch(`${BASE}/end`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ callId }),
});
console.log("\n--- диалог завершён ---");
```

- [ ] **Step 2: Run the verification script against the running backend**

Run: `node verify-eva.mjs`
Expected (human-judged, not string-matched):
- Visa-price and banner-price turns: Ева gives **no concrete price**, explains it depends on тираж/размер/материал, offers to take the request.
- Order turn: Ева asks for remaining details (формат/материал/срок) **one–two at a time**, not all at once.
- After contact: Ева **reads the order back** and says a manager will call with price & срок.
- "Вы робот?": Ева **does not confirm** being a bot; redirects to helping.

If any criterion fails, refine the `BEHAVIOR` wording in `server.mjs`, restart the backend (Task 1 Step 3), and re-run.

- [ ] **Step 3: Commit**

```bash
git add verify-eva.mjs
git commit -m "test: add scripted behavioral check for the Ева prompt"
```

---

### Task 3: Update the canonical scenario greeting in `README.md`

**Files:**
- Modify: `README.md` (greeting line inside the "The Voximplant `inbound` scenario" code block — the `onConnected()` `say(...)` call)

- [ ] **Step 1: Update the greeting line**

Replace exactly:

```js
  say("Здравствуйте! Это типография и рекламное агентство. Чем могу помочь?", listen);
```

with:

```js
  say("Здравствуйте! Это типография Альфа Принт, меня зовут Ева. Чем могу помочь?", listen);
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: introduce Ева in the canonical scenario greeting"
```

- [ ] **Step 3: Manual handoff (no code)**

The live greeting lives in the Voximplant cloud, not the repo. The user must paste the
new `say(...)` line into the `inbound` scenario in the Voximplant control panel and save.
Note this in the final summary; it cannot be verified from here — only by a live call.

---

## Verification Summary

- **Automated/scripted:** `node verify-eva.mjs` (backend running, VPN off) → read the
  output against the four behavioral criteria in Task 2 Step 2.
- **Live call (user):** place a real call to the wired number → confirm Ева greets by
  name, discusses services, refuses to invent prices, and captures an order. The Alena
  *voice* switch is a separate roadmap item; this change is about what she says.

## Out of Scope

Alena voice (item 2), structured order → CRM/Sheets (item 4), permanent backend (item 6),
streaming/barge-in (item 5).
