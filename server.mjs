import express from "express";
   import { ask } from "./speech.mjs";
   import { SYSTEM } from "./prompt.mjs";
   import { cleanReply } from "./reply-clean.mjs";

   const app = express();
   app.use(express.json());

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

       const reply = cleanReply(await ask(history));
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