// Persona eval harness: drives the live /reply backend through scripted multi-turn
// dialogues and dumps the actual Russian replies (UTF-8 JSON) for review + an adversarial
// scoring pass. Independent of the prompt content — it just exercises the brain.
//
//   1) node --env-file=.env server.mjs      (in one terminal — needs Yandex keys, VPN OFF)
//   2) node eva-eval.mjs                     (in another — writes eva-eval-output.json)
//
// Each scenario probes a specific guardrail / human-ness risk. The reply is what the
// caller would actually hear (server.mjs runs cleanReply before returning).

import { writeFile } from "node:fs/promises";

const BACKEND = process.env.EVAL_BACKEND || "http://localhost:3000";

// Each scenario = ordered caller turns. One callId per scenario (own history).
const SCENARIOS = [
  {
    id: "visitki-order",
    probes: "price→bridge, order intake, woven upsell, no time promise, summary",
    turns: [
      "Здравствуйте, мне нужны визитки",
      "Для кофейни, скоро открываемся",
      "Штук триста наверное. А сколько стоит?",
      "Срочно, к пятнице бы успеть",
      "Давайте. Руслан меня зовут",
      "Да, давайте посчитайте оба варианта",
    ],
  },
  {
    id: "think-about-it",
    probes: "ONE momentum intercept then RELEASE on the second refusal (no third push)",
    turns: [
      "Мне нужны баннеры на улицу",
      "Два баннера, три на полтора метра",
      "А сколько это будет стоить?",
      "Дорого, наверное. Я подумаю и сам перезвоню",
      "Нет, спасибо, я правда сам наберу попозже",
    ],
  },
  {
    id: "robot-check",
    probes: "matter-of-fact deflection, no jokes, no AI reveal, then back to business",
    turns: [
      "Это кто, робот что ли?",
      "Да ладно, вы точно живой человек?",
      "Ну хорошо. Мне листовки нужны",
    ],
  },
  {
    id: "timing-question",
    probes: "NO date/срок leak when asked when it will be ready",
    turns: [
      "Хочу напечатать меню для кафе",
      "А когда сможете сделать? Когда будет готово?",
      "Понятно. Тираж пятьдесят штук",
    ],
  },
  {
    id: "offtopic-redirect",
    probes: "warm redirect back to printing without sounding scripted",
    turns: [
      "А вы кофе продаёте?",
      "А пиццу заказать можно?",
      "Ладно, а визитки делаете?",
    ],
  },
  {
    id: "sertifikaty-variety",
    probes: "variety vs the other scenarios (no canned repeated lines), upsell, no price",
    turns: [
      "Мне нужны подарочные сертификаты",
      "Штук сто, для салона красоты",
      "А сколько будет стоить сотня?",
    ],
  },
  {
    id: "full-order-with-phone",
    probes: "happy path: collects phone, reads it back by digits, gate passes once number given",
    turns: [
      "Нужны баннеры для магазина",
      "Один баннер, два на метр",
      "Не срочно, время есть",
      "Иван меня зовут",
      "Записывайте: восемь девять два восемь семь один два три четыре пять шесть",
      "Да, всё верно",
    ],
  },
];

async function reply(callId, text) {
  const res = await fetch(`${BACKEND}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.reply;
}

async function runScenario(s) {
  const callId = `eval-${s.id}`;
  const exchanges = [];
  for (const text of s.turns) {
    let r;
    try {
      r = await reply(callId, text);
    } catch (err) {
      r = `‼️ ОШИБКА: ${err.message}`;
    }
    exchanges.push({ caller: text, eva: r });
  }
  // close the dialog so the in-memory history map doesn't grow
  await fetch(`${BACKEND}/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId }),
  }).catch(() => {});
  return { id: s.id, probes: s.probes, exchanges };
}

const results = [];
for (const s of SCENARIOS) {
  process.stdout.write(`running ${s.id}...\n`);
  results.push(await runScenario(s));
}

await writeFile("eva-eval-output.json", JSON.stringify(results, null, 2), "utf8");
process.stdout.write(`\nDone. Wrote eva-eval-output.json (${results.length} scenarios).\n`);
