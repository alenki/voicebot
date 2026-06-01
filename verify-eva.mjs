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
