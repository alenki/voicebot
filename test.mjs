import { ask, synthesize, recognize } from "./speech.mjs";
import { writeFile } from "node:fs/promises";

const messages = [
  { role: "system", text: "Ты — голосовой ассистент типографии и рекламного агентства. Отвечай кратко, вежливо, по-русски, как по телефону." },
  { role: "user", text: "Здравствуйте! Делаете широкоформатные баннеры?" },
];

console.log("1) Спрашиваю мозг…");
const reply = await ask(messages);
console.log("   Ответ:", reply);

console.log("2) Синтезирую речь…");
const audio = await synthesize(reply);
await writeFile("reply.ogg", audio);
console.log(`   Сохранил reply.ogg, ${audio.length} байт`);

console.log("3) Распознаю обратно…");
console.log("   Услышал:", await recognize(audio));