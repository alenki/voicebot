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
import http from "node:http";
import { WebSocketServer } from "ws";
import { askStream, synthesizePcm } from "./speech.mjs";
import { SYSTEM } from "./prompt.mjs";
import { splitSentences } from "./sentences.mjs";
import { PacedPlayer } from "./playback.mjs";
import { openStt } from "./stt-stream.mjs";
import { stripLeadingGreeting, stripMarkup } from "./reply-clean.mjs";
import { Speaker } from "./speaker.mjs";
import { shouldInterrupt, isSubstantive } from "./bargein.mjs";
import { extractOrder } from "./order-extract.mjs";
import { deliverLead } from "./lead.mjs";
import { assertEnv, missingKeys } from "./env.mjs";
import { isAuthorized, healthHandler, drainSessions } from "./stream-guard.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Общий секрет для гейта /media (ngrok публичен — без гейта любой жжёт квоту Yandex).
// Не задан → пускаем всех, но громко предупреждаем на старте (в start()).
const STREAM_SECRET = process.env.STREAM_SECRET || "";
// Реальные зависимости сессии. В тестах подменяются фейками через runSession(ws, deps),
// чтобы прогонять оркестрацию звонка без сети Yandex.
const DEFAULT_DEPS = { askStream, synthesizePcm, openStt, extractOrder, deliverLead };

const PORT = 3001;
const GREETING = "Здравствуйте! Это типография Альфа Принт, меня зовут Ева. Чем могу помочь?";
// Стриминг-онли добавка к промпту: в голосовом диалоге длинные ответы тормозят и труднее
// перебиваются. Просим отвечать очень коротко. Общий prompt.mjs (его делит turn-based
// сервер) не трогаем — это касается только потокового пути.
const BREVITY =
`ВАЖНО для голосового разговора: отвечай очень коротко — одно-два коротких предложения. Не перечисляй услуги списком и не выкладывай всё сразу. Веди диалог по шагам: задай один встречный вопрос и жди ответа.`;

// Активные сессии звонков — для грейсфул-дренажа заявок при остановке сервера.
const sessions = new Set();

// HTTP-сервер: health-проба (убедиться, что бэкенд жив перед вставкой ngrok-URL в сценарий)
// + апгрейд до WS только на /media и только с верным token.
const server = http.createServer((req, res) => {
  if (healthHandler(req, res)) return;
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://x").pathname; } catch {}
  if (pathname !== "/media") { socket.destroy(); return; }
  if (!isAuthorized(req.url, STREAM_SECRET)) {
    console.warn(`WS отклонён (нет/неверный token) от ${req.socket.remoteAddress}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => runSession(ws));

export function runSession(ws, deps = DEFAULT_DEPS) {
  const callId = "stream-" + Date.now();
  const history = [{ role: "system", text: SYSTEM + "\n\n" + BREVITY }];
  let sampleRate = 8000;
  let player = null;
  let stt = null;
  let speaker = null;        // озвучка ответа под токеном хода (для barge-in)
  let currentTurn = null;    // AbortController текущего хода LLM (если идёт THINKING)
  let floorAt = 0;           // когда «слово» перешло к Еве — отсчёт окна прогрева barge-in
  let turnStartedAt = 0;     // старт текущего хода — для лога «время до 1го кадра»
  let speakingDoneToken = 0; // токен хода, чьё аудио синтезировано и доигрывается плеером
  let lastFinalText = "";    // последняя финализированная реплика абонента (эхо-защита + дедуп)
  let lastFinalAt = 0;       // когда её обработали — для дедупа запоздавшего дубля
  const GRACE_MS = 500;      // окно прогрева: первые 500мс речи Евы не перебиваем (хвост абонента)
  const DEDUP_MS = 7000;     // окно дедупа: Yandex stt-eou повторяет уже обработанную реплику ~5с спустя
  let closed = false;        // звонок завершён (ws close): запрещаем новые ходы и обрываем текущий
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
  let outSeq = 0;   // sequenceNumber — как у Voximplant, с 1; заодно счётчик отданных кадров
  let lastOutSeq = 0; // для замера частоты ИСХОДЯЩИХ кадров (норма 50/с в речи Евы)
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
      try { return await deps.synthesizePcm(text, sampleRate); }
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
    finishWhenPlayed(token);           // слушаем только когда плеер доиграет очередь
  }

  // Аудио хода полностью синтезировано и поставлено в очередь, но плеер ещё ПРОИГРЫВАЕТ.
  // Остаёмся в SPEAKING и ждём, пока очередь доиграет, и ТОЛЬКО потом слушаем — иначе
  // состояние было бы LISTENING, пока Ева ещё ГОВОРИТ, и barge-in (он только в SPEAKING/
  // THINKING) не срабатывал бы во время самой речи (а это и есть «перебить Еву»).
  function finishWhenPlayed(token) {
    speakingDoneToken = token;
    if (!player || !player.speaking) finishSpeaking(token); // уже доиграл — слушаем сразу
    // иначе finishSpeaking вызовется из player.onIdle, когда очередь опустеет
  }

  // Очередь доиграла — возвращаемся слушать, если этот ход всё ещё актуален (не перебит,
  // не сменился новым ходом). Вызывается из finishWhenPlayed и из player.onIdle.
  function finishSpeaking(token) {
    if (token !== speaker.gen) return;   // ход уже отменён/сменился — игнор
    if (state !== "SPEAKING") return;    // подстраховка
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
    if (closed) return;                       // звонок завершён — не заводим новый ход
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
    if (closed) return;                       // звонок завершился между финализацией и ходом
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
      raw = await deps.askStream(history, (cum) => { raw = cum; drainComplete(); }, { signal: ac.signal });
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

    // Ход не перебили, но Ева не произнесла ни звука: синтез упал на всех предложениях (TTS
    // недоступен) или модель вернула пустой/только-приветственный ответ. Не оставляем «мёртвую
    // тишину» перед владельцем — коротко извиняемся и снова слушаем.
    if (!speaker.spokeThisTurn) {
      console.warn(`[${callId}] ${ts()} ход без озвучки — извиняемся вместо тишины`);
      await speak("Извините, не расслышала, повторите пожалуйста.");
      return;                            // speak() сам вернул сессию в LISTENING
    }

    const reply = spoken.join(" ");
    history.push({ role: "assistant", text: reply });
    console.log(`[${callId}] Ева (${reply.length}c): ${reply}`);
    finishWhenPlayed(token);           // остаёмся SPEAKING, пока плеер не доиграет реплику
  }

  function startSession() {
    sendStart(); // объявляем формат исходящего аудио до первого media-кадра
    player = new PacedPlayer(sendFrame, {
      sampleRate, frameMs: 20,
      onIdle: () => {
        console.log(`[${callId}] ${ts()} плеер: очередь пуста (аудио доиграло)`);
        finishSpeaking(speakingDoneToken); // доиграли — теперь слушаем (если ход актуален)
      },
    });
    // Синтез для speaker: сохраняем существующий повтор synthPcm и лог пропуска предложения.
    const synthForSpeaker = async (text) => {
      try { return await synthPcm(text); }
      catch (e) { console.error(`[${callId}] TTS пропуск:`, e.message); throw e; }
    };
    speaker = new Speaker(player, synthForSpeaker, {
      onFirstFrame: () => console.log(`[${callId}] ${ts()} ⏱ до 1го кадра ${Date.now() - turnStartedAt}ms`),
    });
    stt = deps.openStt({
      sampleRate,
      onPartial: (t) => {
        if (closed) return;                   // запоздавший партиал после трубки — игнор
        lastVoiceAt = Date.now();
        // Пока слово у Евы (приветствие/размышление/речь) — проверяем партиал на barge-in.
        // Вся политика — в shouldInterrupt(): слово у Евы + окно прогрева GRACE_MS (от floorAt)
        // + содержательность + эхо-гейт (партиал ≠ последней финализации lastFinalText).
        // ⚠️ Эвристика «первого приближения», тюнится на реальных звонках (см. spec):
        //   1) эхо-гейт строгий (==): дословный повтор той же фразы абонентом не перебьёт —
        //      на практике редко, т.к. партиалы растут пословно и перебивают раньше полного
        //      совпадения; floorAt задаётся в начале THINKING, и при медленном LLM грейс может
        //      истечь, пока Ева ещё молчит. Уточнить пороги по логам живых звонков.
        if (state === "SPEAKING" || state === "THINKING") {
          const sinceFloor = Date.now() - floorAt;
          if (shouldInterrupt(state, t, sinceFloor, GRACE_MS, lastFinalText)) {
            interrupt(t);
          } else if (isSubstantive(t)) {
            // «Почти-перебивание»: содержательная речь, пока слово у Евы, но barge-in не сработал.
            // Логируем причину и тайминг — ровно те данные, по которым на живых звонках тюнятся
            // GRACE_MS и эхо-гейт (см. spec, отложенный tuning pass). Только лог, без влияния на
            // поведение.
            const why = sinceFloor < GRACE_MS ? `грейс ${sinceFloor}/${GRACE_MS}мс`
              : t === lastFinalText ? "эхо последней реплики"
              : "иное";
            console.log(`[${callId}] ${ts()} barge-in подавлен [${why}] @${state}: "${t}"`);
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
      const outFps = outSeq - lastOutSeq; // отданных кадров/с — в речи Евы должно быть ≈50
      lastOutSeq = outSeq;
      console.log(`[${callId}] ${ts()} вход: ${fps} | выход: ${outFps} кадров/с (норма 50; всего вход ${inCount}, выход ${outSeq})`);
    }, 1000);
    // Приветствие сразу после старта сессии (speak() сам вернёт сессию в LISTENING).
    speak(GREETING);
  }

  // По завершении звонка: извлекаем заявку из всего диалога и шлём менеджеру в Telegram.
  // Один раз за звонок (stop и close могут прийти оба). Любой сбой — только лог, не бросаем,
  // чтобы доставка заявки не мешала корректному закрытию сессии.
  let leadSent = false;
  async function finalizeLead() {
    if (leadSent) return;
    leadSent = true;
    try {
      const { hasOrder, fields } = await deps.extractOrder(history);
      if (!hasOrder) {
        console.log(`[${callId}] заявка не оформлена — в Telegram не шлём`);
        return;
      }
      const time = new Date().toLocaleString("ru-RU");
      const r = await deps.deliverLead(fields, { callId, time });
      console.log(
        `[${callId}] заявка → Telegram: ${r.ok ? "отправлена" : `не отправлена (${r.error || (r.skipped ? "нет настроек" : "?")})`}`,
      );
    } catch (e) {
      console.error(`[${callId}] ошибка доставки заявки:`, e.message || e);
    }
  }

  // Регистрируем сессию, чтобы грейсфул-шатдаун успел до-оформить её заявку перед выходом.
  const session = { callId, finalizeLead };
  sessions.add(session);

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
      finalizeLead();
    }
  });

  ws.on("close", () => {
    console.log(`[${callId}] отключился`);
    closed = true;                            // блокируем новые ходы (finalizeTurn/handleTurn/onPartial)
    try { currentTurn?.abort(); } catch {}    // и обрываем ход LLM, если он сейчас «в полёте»
    if (hb) clearInterval(hb);
    clearTimeout(endpointTimer);
    if (stt) stt.close();
    if (player) player.stop();
    finalizeLead();
    sessions.delete(session);
  });
  ws.on("error", (e) => console.error(`[${callId}] ws ошибка:`, e.message));
}

// Грейсфул-шатдаун: перестаём принимать соединения, закрываем активные WS и даём их
// сессиям до-оформить заявку (finalizeLead), затем выходим. Иначе перезапуск теряет лид.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${sig}: останавливаюсь, дренирую ${sessions.size} активных сессий…`);
  server.close();
  for (const ws of wss.clients) { try { ws.close(1001, "server shutdown"); } catch {} }
  try { await drainSessions(sessions); } catch {}
  process.exit(0);
}

// Старт сервера — только когда файл запущен напрямую (а не импортирован тестом, который берёт
// runSession). Здесь же fail-fast по ключам Yandex, чтобы импорт модуля в тестах не падал.
function start() {
  assertEnv(process.env, ["YANDEX_API_KEY", "YANDEX_FOLDER_ID"], "Yandex");
  if (missingKeys(process.env, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]).length) {
    console.warn("⚠ TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — заявки НЕ уйдут в Telegram");
  }
  server.listen(PORT, () => {
    console.log(`Стриминговый сервер слушает ws://localhost:${PORT}/media (health: http://localhost:${PORT}/health)`);
    if (!STREAM_SECRET) {
      console.warn("⚠ STREAM_SECRET не задан — /media открыт без авторизации. Для беты задайте секрет в .env и добавьте ?token=… в URL сценария Voximplant.");
    }
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isMain) start();
