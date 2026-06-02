import express from "express";
   import { ask } from "./speech.mjs";
   import { SYSTEM } from "./prompt.mjs";

   const app = express();
   app.use(express.json());

   // YandexGPT-lite зеркалит приветствие клиента в первом ответе, даже когда промпт
   // это запрещает. Сценарий Voximplant уже здоровается в начале звонка, поэтому
   // срезаем ведущее приветствие из ответа — гарантированно, без надежды на модель.
   const GREETING_RE =
     /^[\s—–-]*(здравствуй(?:те)?|добр(?:ый|ое|ого)\s+(?:день|утро|вечер|дня|времени\s+суток)|приветствую(?:\s+вас)?|привет)[\s,!.…—–-]*/iu;

   function stripGreeting(text) {
     const stripped = text.replace(GREETING_RE, "");
     if (stripped === text || stripped.length === 0) return text; // приветствия не было — не трогаем
     return stripped.charAt(0).toUpperCase() + stripped.slice(1);  // восстанавливаем заглавную букву
   }

   // YandexGPT-lite иногда «доигрывает» диалог за обе стороны и дописывает фальшивые
   // реплики вида «Пользователь: …» / «Ассистент: …». Реплики по телефону короткие и
   // без переносов строк, поэтому метка роли с новой строки — это почти всегда галлюцинация.
   // Обрезаем ответ на первой такой метке: клиент должен услышать только первую реплику Евы.
   const ROLEPLAY_RE = /\n+\s*(?:пользовател[ья]|ассистент|клиент|оператор|ева|бот|собеседник|менеджер|user|assistant)\s*:/iu;

   function stripRolePlay(text) {
     const m = text.match(ROLEPLAY_RE);
     if (!m || m.index === 0) return text; // метки нет (или она в самом начале) — не трогаем
     return text.slice(0, m.index).trimEnd();
   }

   const dialogs = new Map(); // callId -> история диалога

   app.post("/reply", async (req, res) => {
     try {
       const { callId, text } = req.body;
       if (!callId || !text) return res.status(400).json({ error: "нужны callId и text" });

       let history = dialogs.get(callId);
       if (!history) {
         history = [{ role: "system", text: SYSTEM }];
         dialogs.set(callId, history);
       }
       history.push({ role: "user", text });

       const reply = stripGreeting(stripRolePlay(await ask(history)));
       history.push({ role: "assistant", text: reply });

       console.log(`[${callId}] клиент: ${text}`);
       console.log(`[${callId}] бот:    ${reply}`);
       res.json({ reply });
     } catch (err) {
       console.error(err);
       res.status(500).json({ error: String(err) });
     }
   });

   app.post("/end", (req, res) => {
     dialogs.delete(req.body?.callId);
     res.json({ ok: true });
   });

   app.listen(3000, () => console.log("Backend слушает http://localhost:3000"));