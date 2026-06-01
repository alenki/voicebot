import express from "express";
   import { ask } from "./speech.mjs";

   const app = express();
   app.use(express.json());

   const SYSTEM =
     "Ты — голосовой ассистент типографии и рекламного агентства. " +
     "Отвечай вежливо, кратко, по-русски, как в телефонном разговоре: " +
     "короткими фразами, без списков и разметки. Помогай с вопросами по услугам " +
     "(визитки, листовки, баннеры, печать, дизайн), примерным срокам и оформлению заказа. " +
     "Точные цены не выдумывай: если не уверен — скажи, что уточнит менеджер, и предложи записать заявку.";

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

       const reply = await ask(history);
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