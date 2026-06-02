// M0 (подтверждено живым звонком): Voximplant шлёт медиапоток как JSON-текстовые фреймы
// (протокол в стиле Twilio Media Streams), НЕ сырые бинарные кадры:
//   start: {"event":"start","start":{"mediaFormat":{"encoding":"PCM16","sampleRate":8000}}}
//   media: {"event":"media","media":{"timestamp":..,"chunk":N,"payload":"<base64 PCM16>"}}
// Аудио: PCM16 (16-бит LE), 8000 Гц, моно; payload каждого кадра = 320 байт = 20 мс.
// Обратно аудио тоже шлём JSON-фреймами {"event":"media","media":{"payload":"<base64>"}}.
//
// Стриминговый сервер. Сессия на звонок: STT → YandexGPT → TTS по предложениям → плеер.
// Запуск: node --env-file=.env stream-server.mjs
import { WebSocketServer } from "ws";
import { ask, synthesizePcm } from "./speech.mjs";
import { SYSTEM } from "./prompt.mjs";
import { splitSentences } from "./sentences.mjs";
import { PacedPlayer } from "./playback.mjs";
import { openStt } from "./stt-stream.mjs";
import { cleanReply } from "./reply-clean.mjs";

const PORT = 3001;
const GREETING = "Здравствуйте! Это типография Альфа Принт, меня зовут Ева. Чем могу помочь?";

const wss = new WebSocketServer({ port: PORT, path: "/media" });

wss.on("connection", (ws) => {
  const callId = "stream-" + Date.now();
  const history = [{ role: "system", text: SYSTEM }];
  let sampleRate = 8000;
  let player = null;
  let stt = null;
  let state = "SPEAKING"; // пока играет приветствие
  let outSeq = 0;
  console.log(`[${callId}] подключился`);

  // Отправка одного PCM-фрейма обратно в Voximplant в виде JSON media-кадра.
  function sendFrame(pcm) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({
      event: "media",
      sequenceNumber: ++outSeq,
      media: { payload: pcm.toString("base64") },
    }));
  }

  async function speak(text) {
    state = "SPEAKING";
    for (const sentence of splitSentences(text)) {
      try {
        const pcm = await synthesizePcm(sentence, sampleRate);
        player.enqueue(pcm);
      } catch (e) {
        console.error(`[${callId}] TTS пропуск предложения:`, e.message);
      }
    }
  }

  async function onFinal(text) {
    if (!text) return;
    console.log(`[${callId}] клиент: ${text}`);
    history.push({ role: "user", text });
    state = "THINKING";
    let reply;
    try {
      reply = cleanReply(await ask(history));
    } catch (e) {
      console.error(`[${callId}] LLM ошибка:`, e.message);
      await speak("Извините, техническая ошибка, повторите пожалуйста.");
      state = "LISTENING";
      return;
    }
    history.push({ role: "assistant", text: reply });
    console.log(`[${callId}] Ева: ${reply}`);
    await speak(reply);
    state = "LISTENING";
  }

  function startSession() {
    player = new PacedPlayer(sendFrame, { sampleRate, frameMs: 20 });
    stt = openStt({
      sampleRate,
      onPartial: (t) => { if (state === "LISTENING") console.log(`[${callId}] …${t}`); },
      onFinal,
      onError: (e) => console.error(`[${callId}] STT ошибка:`, e.message || e),
    });
    // Приветствие сразу после старта сессии.
    speak(GREETING).then(() => { state = "LISTENING"; });
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // Voximplant шлёт media как ТЕКСТ; бинарных кадров не ждём
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "start") {
      sampleRate = msg.start?.mediaFormat?.sampleRate || 8000;
      console.log(`[${callId}] start: PCM16 @ ${sampleRate} Гц`);
      startSession();
    } else if (msg.event === "media" && msg.media?.payload) {
      if (stt) stt.write(Buffer.from(msg.media.payload, "base64")); // аудио абонента → STT
    } else if (msg.event === "stop") {
      console.log(`[${callId}] stop`);
    }
  });

  ws.on("close", () => {
    console.log(`[${callId}] отключился`);
    if (stt) stt.close();
    if (player) player.stop();
  });
  ws.on("error", (e) => console.error(`[${callId}] ws ошибка:`, e.message));
});

console.log(`Стриминговый сервер слушает ws://localhost:${PORT}/media`);
