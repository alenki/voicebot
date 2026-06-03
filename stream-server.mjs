// M0 (подтверждено живым звонком): Voximplant шлёт медиапоток как JSON-текстовые фреймы
// (протокол в стиле Twilio Media Streams), НЕ сырые бинарные кадры. Точная форма кадра
// (из реального захвата /tmp/vox-frames.ndjson):
//   start: {"event":"start","sequenceNumber":0,"start":{"mediaFormat":{"encoding":"PCM16","sampleRate":8000}}}
//   media: {"event":"media","sequenceNumber":N,"media":{"timestamp":<сэмплы>,"chunk":N,"payload":"<base64 PCM16>"}}
// Аудио: PCM16 (16-бит LE), 8000 Гц, моно; payload каждого кадра = 320 байт = 160 сэмплов = 20 мс.
// timestamp растёт В СЭМПЛАХ (+160 на 20-мс кадр), chunk — на 1.
// Обратно аудио шлём кадром ТОЧНО ТАКОЙ ЖЕ формы (с timestamp и chunk), иначе Voximplant
// не распознаёт его как медиа и не проигрывает абоненту (кадр уходит в onmessage вхолостую).
//
// Стриминговый сервер. Сессия на звонок: STT → YandexGPT → TTS по предложениям → плеер.
// Запуск: node --env-file=.env stream-server.mjs
import { WebSocketServer } from "ws";
import { askStream, synthesizePcm } from "./speech.mjs";
import { SYSTEM } from "./prompt.mjs";
import { splitSentences } from "./sentences.mjs";
import { PacedPlayer } from "./playback.mjs";
import { openStt } from "./stt-stream.mjs";
import { stripLeadingGreeting, stripMarkup } from "./reply-clean.mjs";
import { Speaker } from "./speaker.mjs";
import { shouldInterrupt } from "./bargein.mjs";

const PORT = 3001;
const GREETING = "Здравствуйте! Это типография Альфа Принт, меня зовут Ева. Чем могу помочь?";
// Стриминг-онли добавка к промпту: в голосовом диалоге длинные ответы тормозят и труднее
// перебиваются. Просим отвечать очень коротко. Общий prompt.mjs (его делит turn-based
// сервер) не трогаем — это касается только потокового пути.
const BREVITY =
`ВАЖНО для голосового разговора: отвечай очень коротко — одно-два коротких предложения. Не перечисляй услуги списком и не выкладывай всё сразу. Веди диалог по шагам: задай один встречный вопрос и жди ответа.`;

const wss = new WebSocketServer({ port: PORT, path: "/media" });

wss.on("connection", (ws) => {
  const callId = "stream-" + Date.now();
  const history = [{ role: "system", text: SYSTEM + "\n\n" + BREVITY }];
  let sampleRate = 8000;
  let player = null;
  let stt = null;
  let speaker = null;        // озвучка ответа под токеном хода (для barge-in)
  let currentTurn = null;    // AbortController текущего хода LLM (если идёт THINKING)
  let floorAt = 0;           // когда «слово» перешло к Еве — отсчёт окна прогрева barge-in
  let turnStartedAt = 0;     // старт текущего хода — для лога «время до 1го кадра»
  let lastFinalText = "";    // последняя финализированная реплика абонента (эхо-защита + дедуп)
  let lastFinalAt = 0;       // когда её обработали — для дедупа запоздавшего дубля
  const GRACE_MS = 500;      // окно прогрева: первые 500мс речи Евы не перебиваем (хвост абонента)
  const DEDUP_MS = 7000;     // окно дедупа: Yandex stt-eou повторяет уже обработанную реплику ~5с спустя
  let state = "SPEAKING"; // пока играет приветствие
  let lastVoiceAt = 0;    // время последнего партиала — для замера паузы EOU
  let inCount = 0;        // принято медиа-кадров от Voximplant (по 20мс каждый)
  let inFirstAt = 0;      // время первого входящего кадра
  let lastInCount = 0;    // для замера частоты входящих кадров (диагностика транспорта)
  let hb = null;          // heartbeat-таймер
  // Эндпойнтинг по стенным часам: тишина абонента приходит сжато (DTX/silence-suppression),
  // поэтому EOU-классификатор Yandex (audio-time) ждёт паузу 6-8с реального времени.
  // Завершаем реплику сами: если партиал не меняется ENDPOINT_MS мс — это конец фразы.
  const ENDPOINT_MS = 1000;     // тишина после последнего изменения партиала → конец фразы
  let pendingPartial = "";      // последний партиал текущей реплики абонента
  let endpointTimer = null;
  let turnHandled = false;      // реплика уже финализирована (защита от двойного срабатывания)
  const recentFrames = [];      // метки времени недавних входящих кадров (VAD-гейт эндпойнта)
  let outSeq = 0;   // sequenceNumber — как у Voximplant, с 1
  let outChunk = 0; // media.chunk — как у Voximplant, с 0
  let outTs = 0;    // media.timestamp В СЭМПЛАХ — растёт на длину кадра
  const tConn = Date.now();
  const ts = () => `+${((Date.now() - tConn) / 1000).toFixed(2)}s`; // wall-clock от старта звонка
  console.log(`[${callId}] подключился`);

  // Перед медиа сервер ДОЛЖЕН объявить формат исходящего аудио start-кадром
  // (так задокументирован playback-протокол Voximplant: start → media → stop).
  // Зеркалим ровно то, что Voximplant прислал нам: PCM16 (16-бит linear) @ 8000 Гц.
  function sendStart() {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({
      event: "start",
      sequenceNumber: 0,
      start: { mediaFormat: { encoding: "PCM16", sampleRate } },
    }));
  }

  // Отправка одного PCM-фрейма обратно в Voximplant. Форма кадра ТОЧНО повторяет то,
  // что Voximplant шлёт нам (event/sequenceNumber/media.{timestamp,chunk,payload}) —
  // только так платформа распознаёт кадр как медиа и проигрывает его абоненту.
  function sendFrame(pcm) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({
      event: "media",
      sequenceNumber: ++outSeq,
      media: { timestamp: outTs, chunk: outChunk++, payload: pcm.toString("base64") },
    }));
    outTs += pcm.length / 2; // PCM16: 2 байта на сэмпл (160 сэмплов на 20-мс кадр)
  }

  // TTS с одним повтором: сетевые сбои (fetch failed) иначе роняют целое предложение,
  // и Ева «проглатывает» кусок реплики.
  async function synthPcm(text) {
    for (let i = 0; ; i++) {
      try { return await synthesizePcm(text, sampleRate); }
      catch (e) { if (i >= 1) throw e; }
    }
  }

  // Озвучить готовый текст (приветствие / извинение) — не из LLM. Через speaker, чтобы
  // barge-in мог прервать его так же, как обычный ответ. Сам возвращает сессию в LISTENING,
  // если речь не была перебита (если перебита — interrupt() уже выставил LISTENING).
  async function speak(text) {
    turnStartedAt = Date.now();
    floorAt = Date.now();
    currentTurn = null;               // не из LLM — отменять нечего
    state = "SPEAKING";
    const token = speaker.begin();
    for (const sentence of splitSentences(text)) speaker.say(token, sentence);
    await speaker.drain();
    if (token !== speaker.gen) return; // нас перебили — состояние уже LISTENING
    beginListening();
  }

  // Возврат в режим прослушивания и сброс состояния реплики для следующего хода.
  function beginListening() {
    state = "LISTENING";
    turnHandled = false;
    pendingPartial = "";
    clearTimeout(endpointTimer);
    endpointTimer = null;
  }

  function armEndpoint() {
    clearTimeout(endpointTimer);
    endpointTimer = setTimeout(onEndpointFire, ENDPOINT_MS);
  }

  // VAD-гейт: партиал не менялся ENDPOINT_MS, но если кадры всё ещё идут с речевой частотой —
  // абонент просто сделал паузу внутри фразы, не обрываем; ждём реальной тишины.
  function onEndpointFire() {
    const now = Date.now();
    const recent = recentFrames.filter((t) => t >= now - 300).length; // кадров за 300мс
    // Активная речь ≈ 50 кадров/с (≈15 за 300мс). Затухающий «хвост» после речи ≈ 5-7.
    // Порог 11 (≈37 кадров/с): откладываем финал только при ЯВНОЙ речи, хвост не задерживаем.
    if (recent >= 11) { armEndpoint(); return; }
    finalizeTurn(pendingPartial, `endpoint ${ENDPOINT_MS}мс`);
  }

  // Единая точка финализации реплики абонента: и наш эндпойнтинг, и EOU Yandex идут сюда.
  // turnHandled защищает от двойного срабатывания (что сработало первым — то и берём).
  function finalizeTurn(text, src) {
    if (turnHandled || state !== "LISTENING" || !text) return;
    // Дедуп: наш эндпойнт финализирует реплику за ~1с, а Yandex stt-eou той же реплики
    // приходит на несколько секунд позже (audio-time лаг при сжатой тишине) и иначе
    // обработался бы как ВТОРОЙ ход — Ева отвечает дважды. Гасим точный повтор в окне.
    if (text === lastFinalText && Date.now() - lastFinalAt < DEDUP_MS) {
      console.log(`[${callId}] ${ts()} дубль реплики [${src}] пропущен: ${text}`);
      return;
    }
    turnHandled = true;
    lastFinalText = text;            // эхо-защита barge-in + дедуп следующего дубля
    lastFinalAt = Date.now();
    clearTimeout(endpointTimer);
    endpointTimer = null;
    handleTurn(text, src);
  }

  // Барж-ин: абонент заговорил, пока слово у Евы. Гасим речь и LLM, возвращаемся слушать,
  // и заводим перебившую реплику как следующий ход (тот же STT-поток уже её распознаёт).
  function interrupt(partial) {
    console.log(`[${callId}] ${ts()} BARGE-IN на: "${partial}" — Ева замолкает`);
    try { currentTurn?.abort(); } catch {}  // прерываем LLM-стрим, если идёт THINKING
    speaker.abort();                         // стоп-плеер + инвалидация токена — без возобновления
    beginListening();                        // LISTENING + сброс хода (turnHandled/pendingPartial)
    pendingPartial = partial;                // перебившая реплика — затравка следующего хода
    armEndpoint();
  }

  async function handleTurn(text, src) {
    const t0 = Date.now();
    turnStartedAt = t0;
    floorAt = t0;                       // «слово» перешло к Еве (THINKING) — отсюда грейс barge-in
    const eouGap = lastVoiceAt ? t0 - lastVoiceAt : 0; // пауза от последней речи до финализации
    const audioRecvSec = (inCount * 0.02).toFixed(1);               // сколько секунд аудио ПРИНЯТО от Voximplant
    const wallSec = inFirstAt ? ((t0 - inFirstAt) / 1000).toFixed(1) : "0"; // сколько прошло по часам
    console.log(`[${callId}] ${ts()} клиент [${src}]: ${text}  ⏱пауза≈${eouGap}ms | аудио принято ${audioRecvSec}s за ${wallSec}s`);
    history.push({ role: "user", text });
    state = "THINKING";

    const ac = new AbortController();
    currentTurn = ac;
    const token = speaker.begin();

    // Потоковый LLM: достаём ЗАВЕРШЁННЫЕ предложения по мере генерации и озвучиваем их
    // по очереди через speaker, не дожидаясь полного ответа — Ева заговорит раньше.
    let consumed = 0;          // индекс в raw, уже превращённый в речь
    let raw = "";              // последний накопленный текст модели
    let isFirst = true;
    const spoken = [];         // озвученные (очищенные) предложения — для истории/лога

    const enqueueSpeak = (sentence) => {
      let cleaned = stripMarkup(sentence).trim();
      if (isFirst) {
        cleaned = stripLeadingGreeting(cleaned).trim();
        if (!cleaned) return;   // предложение было только приветствием — выбрасываем, isFirst оставляем
        isFirst = false;
      }
      if (!cleaned) return;
      state = "SPEAKING";
      spoken.push(cleaned);
      speaker.say(token, cleaned);
    };

    const drainComplete = () => {
      const matches = raw.slice(consumed).match(/[^.!?…]*[.!?…]+/gu); // только завершённые предложения
      if (!matches) return;
      for (const m of matches) { consumed += m.length; enqueueSpeak(m.trim()); }
    };

    try {
      raw = await askStream(history, (cum) => { raw = cum; drainComplete(); }, { signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) {           // barge-in во время THINKING — тихо выходим
        if (spoken.length) history.push({ role: "assistant", text: spoken.join(" ") });
        return;                          // LISTENING уже выставлен interrupt()
      }
      console.error(`[${callId}] LLM ошибка:`, e.message);
      await speak("Извините, техническая ошибка, повторите пожалуйста.");
      return;                            // speak() сам вернул сессию в LISTENING
    }
    drainComplete();                            // добиваем завершённые предложения
    const tail = raw.slice(consumed).trim();
    if (tail) enqueueSpeak(tail);               // последний «хвост» без терминатора
    await speaker.drain();                      // ждём, пока всё синтезировано и поставлено в очередь

    if (ac.signal.aborted) {             // barge-in во время SPEAKING
      if (spoken.length) history.push({ role: "assistant", text: spoken.join(" ") });
      return;                            // LISTENING уже выставлен interrupt()
    }

    const reply = spoken.join(" ");
    history.push({ role: "assistant", text: reply });
    console.log(`[${callId}] Ева (${reply.length}c): ${reply}`);
    beginListening();
  }

  function startSession() {
    sendStart(); // объявляем формат исходящего аудио до первого media-кадра
    player = new PacedPlayer(sendFrame, {
      sampleRate, frameMs: 20,
      onIdle: () => console.log(`[${callId}] ${ts()} плеер: очередь пуста (аудио доиграло)`),
    });
    // Синтез для speaker: сохраняем существующий повтор synthPcm и лог пропуска предложения.
    const synthForSpeaker = async (text) => {
      try { return await synthPcm(text); }
      catch (e) { console.error(`[${callId}] TTS пропуск:`, e.message); throw e; }
    };
    speaker = new Speaker(player, synthForSpeaker, {
      onFirstFrame: () => console.log(`[${callId}] ${ts()} ⏱ до 1го кадра ${Date.now() - turnStartedAt}ms`),
    });
    stt = openStt({
      sampleRate,
      onPartial: (t) => {
        lastVoiceAt = Date.now();
        // Пока слово у Евы (приветствие/размышление/речь) — проверяем партиал на barge-in.
        // Защита от ложного перебивания хвостом собственной реплики абонента: окно прогрева
        // GRACE_MS (от floorAt) + эхо-гейт (точное равенство последней финализации).
        // ⚠️ Эвристика «первого приближения», тюнится на реальных звонках (см. spec):
        //   1) эхо-гейт строгий (==): дословный повтор той же фразы абонентом не перебьёт —
        //      на практике редко, т.к. партиалы растут пословно и перебивают раньше полного
        //      совпадения; floorAt задаётся в начале THINKING, и при медленном LLM грейс может
        //      истечь, пока Ева ещё молчит. Уточнить пороги по логам живых звонков.
        if (state === "SPEAKING" || state === "THINKING") {
          if (t !== lastFinalText && shouldInterrupt(state, t, Date.now() - floorAt, GRACE_MS)) {
            interrupt(t);
          }
          return;
        }
        // LISTENING: обычный эндпойнтинг.
        console.log(`[${callId}] ${ts()} …${t}`);
        // Партиал изменился — речь продолжается, сбрасываем таймер конца фразы.
        // Стабилен ENDPOINT_MS мс — считаем фразу законченной (по стенным часам, не по audio-time).
        if (t && t !== pendingPartial) {
          pendingPartial = t;
          armEndpoint();
        }
      },
      onFinal: (t) => finalizeTurn(t, "stt-eou"),
      onError: (e) => console.error(`[${callId}] STT ошибка:`, e.message || e),
    });
    // Диагностика транспорта: частота входящих кадров (норма = 50/с при 20мс).
    hb = setInterval(() => {
      const fps = inCount - lastInCount;
      lastInCount = inCount;
      console.log(`[${callId}] ${ts()} вход: ${fps} кадров/с (норма 50; всего ${inCount})`);
    }, 1000);
    // Приветствие сразу после старта сессии (speak() сам вернёт сессию в LISTENING).
    speak(GREETING);
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
      const now = Date.now();
      if (!inFirstAt) inFirstAt = now;
      inCount++;
      recentFrames.push(now);
      if (recentFrames.length > 60) recentFrames.shift(); // держим ~окно последней секунды
      if (stt) stt.write(Buffer.from(msg.media.payload, "base64")); // аудио абонента → STT
    } else if (msg.event === "stop") {
      console.log(`[${callId}] stop`);
    }
  });

  ws.on("close", () => {
    console.log(`[${callId}] отключился`);
    if (hb) clearInterval(hb);
    clearTimeout(endpointTimer);
    if (stt) stt.close();
    if (player) player.stop();
  });
  ws.on("error", (e) => console.error(`[${callId}] ws ошибка:`, e.message));
});

console.log(`Стриминговый сервер слушает ws://localhost:${PORT}/media`);
