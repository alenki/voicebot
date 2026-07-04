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
import { splitSentences, chunkForTts } from "./sentences.mjs";
import { PacedPlayer } from "./playback.mjs";
import { openStt } from "./stt-stream.mjs";
import {
  stripLeadingGreeting, stripMarkup, stripRolePlay, stripWrappingQuotes, feminize,
  spellOutPhoneRuns, needsPhoneAsk, asksForPhone, phoneAsk, hasBotLeak, BOT_DEFLECT, PHONE_ASKS,
} from "./reply-clean.mjs";
import { windowForLlm } from "./history.mjs";
import { Speaker } from "./speaker.mjs";
import { shouldInterrupt, isSubstantive, isEchoOf } from "./bargein.mjs";
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
// pcmCache: общий на процесс кэш синтеза (ключ `${rate}:${text}`) — константные фразы
// (приветствие, извинения, филлеры) и повторяющиеся короткие реплики не платят HTTPS-TTS
// на каждом звонке. Прогревается на старте сервера (prewarmPcmCache).
const DEFAULT_DEPS = { askStream, synthesizePcm, openStt, extractOrder, deliverLead, pcmCache: new Map() };
const PCM_CACHE_MAX = 200; // потолок кэша: уникальные реплики диалога не раздувают память

// Прогретые константы (приветствие/извинения/филлеры/подсказки) закреплены: раньше
// вымещение шло в порядке вставки (FIFO), прогретые записи были самыми старыми и после
// ~200 уникальных реплик вылетали ПЕРВЫМИ — процесс оставался без филлеров до рестарта.
const PINNED_PCM_KEYS = new Set();
export function evictOverflow(cache, max = PCM_CACHE_MAX, pinned = PINNED_PCM_KEYS) {
  while (cache.size > max) {
    let evicted = false;
    for (const k of cache.keys()) {
      if (!pinned.has(k)) { cache.delete(k); evicted = true; break; }
    }
    if (!evicted) break; // остались только закреплённые — дальше не чистим
  }
}

const PORT = 3001;
const GREETING = "Здравствуйте! Это типография Альфа Принт, меня зовут Ева. Чем могу помочь?";
// Константные фразы вне LLM — кандидаты на прогрев PCM-кэша при старте сервера.
const APOLOGY_ERROR = "Извините, техническая ошибка, повторите пожалуйста.";
const APOLOGY_UNHEARD = "Извините, не расслышала, повторите пожалуйста.";
// Числовой env-параметр с дефолтом. НЕ `Number(env) || dflt`: оно молча превращало
// явный "0" обратно в дефолт — документированное «FILLER_MS=0 отключает» не работало.
const envNum = (name, dflt) => {
  const raw = process.env[name];
  const v = Number(raw);
  return raw != null && raw !== "" && Number.isFinite(v) ? v : dflt;
};
// Филлеры «думания»: если через FILLER_MS после старта хода настоящего аудио ещё нет,
// абонент слышит короткую связку вместо мёртвой тишины (классика телефонных ботов —
// тишина >1с читается как обрыв связи). Играются ТОЛЬКО из прогретого PCM-кэша: живой
// синтез филлера отнял бы сеть у первого настоящего предложения ровно на медленном ходе.
// 4 варианта: филлер играется байт-в-байт из кэша, и два клипа на длинном звонке уже
// звучали «заевшей пластинкой» — одинаковая интонация подряд читается как бот.
export const FILLER_TEXTS = ["Секундочку…", "Так, сейчас подскажу…", "Сейчас гляну…", "Ага, минутку…"];
// 1200мс: филлер — только для ДЕЙСТВИТЕЛЬНО медленных ходов. Прежний дефолт 350мс был
// меньше типичного времени первого предложения LLM, и связка звучала почти на каждом
// ходе (живой фидбэк: «says filler words way too much»). От «впритык к ответу» защищает
// гейт spoken.length: если ответ уже в синтезе, филлер пропускается.
const FILLER_MS_DEFAULT = envNum("FILLER_MS", 1200);
// Кулдаун между филлерами: даже на череде медленных ходов Ева не «секундочкает» каждый
// раз подряд — внутри окна филлер пропускается (медленный ход остаётся тихим, как у
// живого оператора, который просто думает).
const FILLER_COOLDOWN_MS_DEFAULT = envNum("FILLER_COOLDOWN_MS", 10_000);
const FILLER_PAUSE_MS = 250; // тишина после связки — чтобы не склеивалась с ответом встык
// Окно тишины эндпойнта (мс): ни новых партиалов, ни речевых кадров столько — реплика
// закончена. Это главная постоянная цена каждого хода («абонент замолчал → Ева думает»).
// Дефолт 1200 — по живому фидбэку «отвечай, только когда абонент реально замолчал»;
// тюнить на живых звонках через .env.
const ENDPOINT_MS_DEFAULT = envNum("ENDPOINT_MS", 1200);
// Sustain-гейт barge-in: перебиваем, только если содержательная речь ДЕРЖИТСЯ столько мс
// (второй+ партиал той же попытки). Одиночный всплеск (шум линии, обрывок чужого
// разговора, глюк STT) Еву больше не глушит — живой симптом «любая помеха её ломает».
const BARGE_SUSTAIN_MS_DEFAULT = envNum("BARGE_SUSTAIN_MS", 300);
// Пауза между содержательными партиалами, после которой попытка перебивания считается
// новой (одиночный всплеск десятисекундной давности не «доращивает» свежую попытку).
const BARGE_RETRY_RESET_MS = 1000;
// Окно хвостового эха: реплика, начавшаяся в первые столько мс после конца речи Евы и
// почти целиком состоящая из её же слов, — это эхо её голоса с громкой связи, не абонент.
const ECHO_TAIL_MS_DEFAULT = 1500;
// Ре-чек VAD-отсрочки: если эндпойнт отложен из-за идущих кадров, проверяем тишину снова
// через столько мс (а не через полное окно заново — это стоило до +1000мс тишины).
const VAD_RECHECK_MS_DEFAULT = 250;
// Бюджет кадровых отсрочек эндпойнта: на линии без DTX (кадры комфорт-шума идут
// постоянно) кадровый гейт иначе откладывал финал БЕСКОНЕЧНО — Ева переставала отвечать
// до конца звонка. 12 × 250мс = максимум +3с; партиальный гейт (точный признак речи)
// бюджетом не ограничен.
const MAX_VAD_DEFERRALS = 12;
// Молчание абонента в LISTENING: живой оператор через ~15с переспросил бы «алло?».
// Максимум два переспроса подряд (счётчик сбрасывается настоящим ходом), 0 — отключено.
export const IDLE_PROMPTS = ["Алло, вы меня слышите?", "Похоже, связь шалит. Вы ещё тут?"];
const IDLE_PROMPT_MS_DEFAULT = envNum("IDLE_PROMPT_MS", 15_000);
// Стриминг-онли добавка к промпту: в голосовом диалоге длинные ответы тормозят и труднее
// перебиваются. Просим отвечать очень коротко. Общий prompt.mjs (его делит turn-based
// сервер) не трогаем — это касается только потокового пути.
const BREVITY =
`ВАЖНО для голосового разговора: отвечай очень коротко — одно-два коротких предложения. Не перечисляй услуги списком и не выкладывай всё сразу. Веди диалог по шагам: не больше одного встречного вопроса за реплику; в прощании и в подтверждении заявки вопрос не нужен.`;

// Активные сессии звонков — для грейсфул-дренажа заявок при остановке сервера.
const sessions = new Set();

// HTTP-сервер: health-проба (убедиться, что бэкенд жив перед вставкой ngrok-URL в сценарий)
// + апгрейд до WS только на /media и только с верным token.
const server = http.createServer((req, res) => {
  if (healthHandler(req, res)) return;
  res.writeHead(404);
  res.end();
});
// maxPayload: медиакадр Voximplant — сотни байт; дефолтные 100 МиБ на публичном ngrok —
// подарок для флуда, блокирующего event loop.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
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
  let evaSpokenText = "";    // что Ева говорит в текущем/последнем ходе (эхо-гейты)
  let speechEndAt = 0;       // когда Ева закончила говорить — окно хвостового эха
  let lastFillerAt = 0;      // когда филлер звучал в последний раз (кулдаун)
  let bargeFirstAt = 0;      // начало текущей попытки перебивания (sustain-гейт)
  let bargeLastAt = 0;       // последний содержательный партиал попытки (сброс по паузе)
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
  // Тайминги переопределяются через deps (тесты) и .env (живой тюнинг, см. константы выше).
  const ENDPOINT_MS = deps.endpointMs ?? ENDPOINT_MS_DEFAULT;
  const VAD_RECHECK_MS = deps.vadRecheckMs ?? VAD_RECHECK_MS_DEFAULT;
  const FILLER_MS = deps.fillerMs ?? FILLER_MS_DEFAULT;
  const FILLER_COOLDOWN_MS = deps.fillerCooldownMs ?? FILLER_COOLDOWN_MS_DEFAULT;
  const BARGE_SUSTAIN_MS = deps.bargeSustainMs ?? BARGE_SUSTAIN_MS_DEFAULT;
  const ECHO_TAIL_MS = deps.echoTailMs ?? ECHO_TAIL_MS_DEFAULT;
  const IDLE_PROMPT_MS = deps.idlePromptMs ?? IDLE_PROMPT_MS_DEFAULT;
  let idleTimer = null;      // «алло, вы меня слышите?» при долгом молчании в LISTENING
  let idlePromptCount = 0;   // не больше двух переспросов подряд; сбрасывается настоящим ходом
  let vadDeferrals = 0;      // бюджет кадровых отсрочек эндпойнта (см. MAX_VAD_DEFERRALS)
  let fillerIdx = 0; // ротация филлеров, чтобы Ева не «секундочкала» одинаково подряд
  let pendingPartial = "";      // последний партиал текущей реплики абонента
  let segments = [];            // stt-eou финалы ТЕКУЩЕЙ реплики: копятся до тишины эндпойнта
  let turnVoiceFirstAt = 0;     // первый партиал/финал текущей реплики (окно хвостового эха)
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
  // и Ева «проглатывает» кусок реплики. Перед сетью — PCM-кэш (см. DEFAULT_DEPS.pcmCache).
  // Предложение длиннее лимита SpeechKit v1 (~250 симв.) режется chunkForTts и
  // синтезируется кусками — раньше такое предложение молча пропадало целиком.
  async function synthPcm(text) {
    const cache = deps.pcmCache;
    const key = `${sampleRate}:${text}`;
    if (cache?.has(key)) {
      const hit = cache.get(key);
      cache.delete(key); cache.set(key, hit); // LRU-освежение: живые фразы не вымываются
      return hit;
    }
    for (let i = 0; ; i++) {
      try {
        const parts = [];
        for (const chunk of chunkForTts(text)) parts.push(await deps.synthesizePcm(chunk, sampleRate));
        const pcm = parts.length === 1 ? parts[0] : Buffer.concat(parts);
        if (cache) {
          cache.set(key, pcm);
          evictOverflow(cache); // прогретые константы закреплены и не вымещаются
        }
        return pcm;
      }
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
    evaSpokenText = text;             // эхо-гейты сверяются с тем, что она сейчас произносит
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
    speechEndAt = Date.now(); // сюда приходим только после речи Евы — отсчёт окна эха
    turnHandled = false;
    bargeFirstAt = 0;
    bargeLastAt = 0;
    resetUtterance();
    armIdlePrompt();
  }

  // Долгое молчание абонента в LISTENING: живой оператор переспросил бы «алло?» вместо
  // бесконечной мёртвой тишины. Максимум два переспроса подряд; любой настоящий ход
  // сбрасывает счётчик (handleTurn), любой партиал/финал абонента откладывает таймер.
  function armIdlePrompt() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!IDLE_PROMPT_MS || idlePromptCount >= 2 || closed) return;
    idleTimer = setTimeout(() => {
      if (closed || state !== "LISTENING" || turnText()) return;
      idlePromptCount++;
      console.log(`[${callId}] ${ts()} тишина ${IDLE_PROMPT_MS}мс — переспрос ${idlePromptCount}/2`);
      speak(IDLE_PROMPTS[(idlePromptCount - 1) % IDLE_PROMPTS.length]);
    }, IDLE_PROMPT_MS);
  }

  // Сброс накопленной реплики абонента (партиал + сегменты + таймер эндпойнта).
  function resetUtterance() {
    pendingPartial = "";
    segments = [];
    turnVoiceFirstAt = 0;
    clearTimeout(endpointTimer);
    endpointTimer = null;
  }

  // Полный текст текущей реплики: завершённые Yandex'ом сегменты + растущий партиал.
  const turnText = () => [...segments, pendingPartial].filter(Boolean).join(" ").trim();

  // Нормализация для дедупа: запоздавший stt-eou дубль может отличаться от уже
  // финализированного текста регистром/пунктуацией нормализации Yandex.
  const sameText = (a, b) => {
    const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
    return norm(a) === norm(b);
  };

  function armEndpoint() {
    clearTimeout(endpointTimer);
    vadDeferrals = 0;
    endpointTimer = setTimeout(onEndpointFire, ENDPOINT_MS);
  }

  // Живой ли это голос — или запоздавший stt-eou дубль. У настоящего повтора («да» на
  // два вопроса подряд) в ЭТОМ окне прослушивания уже был свежий партиал
  // (turnVoiceFirstAt); дубль прилетает одиноким финалом в пустое окно. Кадры сюда
  // НЕ смотрим: Voximplant шлёт ~50 кадров/с непрерывно (без DTX, подтверждено живым
  // звонком) — кадровый признак был бы всегда истинным и убил бы дедуп целиком.
  const freshVoice = () => turnVoiceFirstAt > 0;

  // Гейты эндпойнта: окно ENDPOINT_MS выдержано от ПОСЛЕДНЕЙ смены партиала, но реплику
  // завершаем только при настоящей тишине — иначе короткий ре-чек.
  //  • голос-гейт: партиалы STT приходили недавно (пусть и с тем же текстом) — абонент
  //    ещё говорит; раньше застывший партиал финализировался на полуслове;
  //  • VAD-гейт: кадры идут с речевой частотой — пауза внутри фразы, не конец.
  function onEndpointFire() {
    const now = Date.now();
    const recent = recentFrames.filter((t) => t >= now - 300).length; // кадров за 300мс
    // Активная речь ≈ 50 кадров/с (≈15 за 300мс). Затухающий «хвост» после речи ≈ 5-7.
    // Порог 11 (≈37 кадров/с): откладываем финал только при ЯВНОЙ речи, хвост не задерживаем.
    // Отсрочка — коротким ре-чеком, не полным окном: пауза уже выдержана, осталось лишь
    // дождаться, когда кадры высохнут. Изменившийся партиал всё равно перевзведёт полное окно.
    // Кадровый гейт ограничен бюджетом MAX_VAD_DEFERRALS: линия без DTX шлёт кадры
    // непрерывно, и без бюджета финал откладывался бы бесконечно (Ева замолкала навсегда).
    const partialsFresh = lastVoiceAt && now - lastVoiceAt < ENDPOINT_MS;
    if (partialsFresh || (recent >= 11 && vadDeferrals < MAX_VAD_DEFERRALS)) {
      if (!partialsFresh) vadDeferrals++;
      clearTimeout(endpointTimer);
      endpointTimer = setTimeout(onEndpointFire, VAD_RECHECK_MS);
      return;
    }
    finalizeTurn(turnText(), `endpoint ${ENDPOINT_MS}мс`);
  }

  // Единая точка финализации реплики абонента (наш эндпойнтинг по тишине).
  // turnHandled защищает от двойного срабатывания.
  function finalizeTurn(text, src) {
    if (closed) return;                       // звонок завершён — не заводим новый ход
    if (turnHandled || state !== "LISTENING" || !text) return;
    // Дедуп: наш эндпойнт финализирует реплику за ~1с, а Yandex stt-eou той же реплики
    // приходит на несколько секунд позже (audio-time лаг при сжатой тишине) и иначе
    // обработался бы как ВТОРОЙ ход — Ева отвечает дважды. Гасим повтор в окне, НО
    // только в тишине: живой повтор той же короткой фразы («да» на два вопроса подряд)
    // приходит со свежим голосом (freshVoice) и должен стать нормальным ходом.
    if (sameText(text, lastFinalText) && Date.now() - lastFinalAt < DEDUP_MS && !freshVoice()) {
      console.log(`[${callId}] ${ts()} дубль реплики [${src}] пропущен: ${text}`);
      resetUtterance();
      return;
    }
    // Хвостовое эхо: реплика началась сразу после конца речи Евы и почти целиком состоит
    // из её же слов — это её голос вернулся с громкой связи, а не обращение абонента.
    // Без гейта Ева отвечала бы сама себе (живой симптом «ломается без причины»).
    if (turnVoiceFirstAt && turnVoiceFirstAt - speechEndAt < ECHO_TAIL_MS && isEchoOf(text, evaSpokenText)) {
      console.log(`[${callId}] ${ts()} эхо-хвост речи Евы отброшен [${src}]: ${text}`);
      resetUtterance();
      return;
    }
    turnHandled = true;
    lastFinalText = text;            // эхо-защита barge-in + дедуп следующего дубля
    lastFinalAt = Date.now();
    resetUtterance();                // реплика поглощена ходом
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
    idlePromptCount = 0;                // настоящий ход — счётчик «алло?» с нуля
    clearTimeout(idleTimer);
    const eouGap = lastVoiceAt ? t0 - lastVoiceAt : 0; // пауза от последней речи до финализации
    const audioRecvSec = (inCount * 0.02).toFixed(1);               // сколько секунд аудио ПРИНЯТО от Voximplant
    const wallSec = inFirstAt ? ((t0 - inFirstAt) / 1000).toFixed(1) : "0"; // сколько прошло по часам
    console.log(`[${callId}] ${ts()} клиент [${src}]: ${text}  ⏱пауза≈${eouGap}ms | аудио принято ${audioRecvSec}s за ${wallSec}s`);
    history.push({ role: "user", text });
    state = "THINKING";
    evaSpokenText = ""; // наполнится тем, что Ева скажет в этом ходе (эхо-гейты)

    const ac = new AbortController();
    currentTurn = ac;
    const token = speaker.begin();

    // Потоковый LLM: достаём ЗАВЕРШЁННЫЕ предложения по мере генерации и озвучиваем их
    // по очереди через speaker, не дожидаясь полного ответа — Ева заговорит раньше.
    let consumed = 0;          // индекс в raw, уже превращённый в речь
    let raw = "";              // последний накопленный текст модели
    let isFirst = true;
    const spoken = [];         // озвученные (очищенные) предложения — для истории/лога

    // Филлер: через FILLER_MS, если настоящего аудио ещё нет, играем готовый PCM из кэша
    // + хвост тишины (не встык с ответом). Гейты: ход жив (не barge-in/close), токен
    // актуален (sayPcm проверит), кулдаун выдержан (Ева не «секундочкает» каждый ход)
    // и — важно — ни одно предложение ещё НЕ в синтезе (spoken.length): если ответ уже
    // варится в TTS, он в сотнях мс, филлер прозвучал бы вплотную и только оттянул бы его.
    // spokeThisTurn остаётся false — «ход без озвучки» при упавшем TTS всё ещё сработает.
    let fillerTimer = null;
    if (FILLER_MS > 0) {
      const fillerText = FILLER_TEXTS[fillerIdx++ % FILLER_TEXTS.length];
      const fillerPcm = deps.pcmCache?.get(`${sampleRate}:${fillerText}`);
      if (fillerPcm) {
        const pause = Buffer.alloc(Math.round(sampleRate * (FILLER_PAUSE_MS / 1000)) * 2);
        fillerTimer = setTimeout(() => {
          if (closed || ac.signal.aborted || speaker.spokeThisTurn || spoken.length) return;
          if (Date.now() - lastFillerAt < FILLER_COOLDOWN_MS) {
            console.log(`[${callId}] ${ts()} филлер пропущен (кулдаун ${FILLER_COOLDOWN_MS}мс)`);
            return;
          }
          lastFillerAt = Date.now();
          evaSpokenText += " " + fillerText; // филлер — тоже её голос: эхо-гейт должен его знать
          console.log(`[${callId}] ${ts()} филлер «${fillerText}» (ответ дольше ${FILLER_MS}мс)`);
          speaker.sayPcm(token, Buffer.concat([fillerPcm, pause]));
        }, FILLER_MS);
      }
    }

    // Гигиена как на turn-based пути (промпт слабую модель до конца не держит):
    // женский род, кавычки-обёртки, слитный номер по цифрам — пофразово; бот-утечка
    // («как языковая модель…») и обещание звонка без номера подменяются целиком, и
    // остаток стрима этого хода не озвучивается (он противоречил бы подмене).
    let stopSpeaking = false;
    const enqueueSpeak = (sentence) => {
      if (stopSpeaking) return;
      let cleaned = spellOutPhoneRuns(feminize(stripWrappingQuotes(stripMarkup(sentence)))).trim();
      if (isFirst) {
        cleaned = stripLeadingGreeting(cleaned).trim();
        if (!cleaned) {
          // Предложение было только приветствием — выбрасываем, isFirst оставляем. Лог
          // обязателен: иначе «⏱ до 1го кадра» молча растёт на целое предложение, и по
          // логам это неотличимо от медленного LLM.
          console.log(`[${callId}] ${ts()} первое предложение — только приветствие, выброшено: "${sentence.trim()}"`);
          return;
        }
        isFirst = false;
      }
      if (!cleaned) return;
      if (hasBotLeak(cleaned)) {
        console.log(`[${callId}] ${ts()} бот-утечка перехвачена: "${cleaned}"`);
        cleaned = BOT_DEFLECT;
        stopSpeaking = true;
      } else if (needsPhoneAsk(history, cleaned) && !asksForPhone(raw.slice(consumed))) {
        // Лукахед по уже сгенерированному хвосту: если просьба номера ещё придёт из
        // стрима («Менеджер перезвонит. На какой номер записать?») — не клоббим валидный
        // ответ; пропущенный случай добьёт пост-стримовая проверка ниже.
        console.log(`[${callId}] ${ts()} обещание звонка без номера — подменяю просьбой телефона: "${cleaned}"`);
        cleaned = phoneAsk(history);
        stopSpeaking = true;
      }
      state = "SPEAKING";
      spoken.push(cleaned);
      evaSpokenText += " " + cleaned; // эхо-гейты сверяются с тем, что она сейчас произносит
      // По предложениям: кэш (в т.ч. прогретые PHONE_ASKS) ключуется пофразово.
      for (const part of splitSentences(cleaned)) speaker.say(token, part);
    };

    const drainComplete = () => {
      // Завершённые куски: до знака конца предложения ИЛИ до переноса строки. Без \n
      // ответ-список («* Визитки\n* Баннеры») не содержит [.!?…] и молчал бы до конца
      // стрима; stripMarkup в enqueueSpeak потом срежет маркеры и схлопнет переносы.
      const matches = raw.slice(consumed).match(/[^.!?…\n]*(?:[.!?…]+|\n+)/gu);
      if (!matches) return;
      for (const m of matches) { consumed += m.length; enqueueSpeak(m.trim()); }
    };

    // Фальшивый ролеплей («Клиент: …») обрезается ЕЩЁ В СТРИМЕ: на turn-based пути это
    // делает cleanReply, а здесь предложения уходят в TTS по мере генерации — без среза
    // Ева зачитывала бы выдуманный диалог вслух.
    const clipRolePlay = (cum) => stripRolePlay(cum);

    try {
      // В модель — окно истории (см. history.mjs); полная history остаётся для extractOrder.
      raw = clipRolePlay(await deps.askStream(windowForLlm(history), (cum) => { raw = clipRolePlay(cum); drainComplete(); }, { signal: ac.signal }));
    } catch (e) {
      clearTimeout(fillerTimer);
      if (ac.signal.aborted) {           // barge-in во время THINKING — тихо выходим
        if (spoken.length) history.push({ role: "assistant", text: spoken.join(" ") });
        return;                          // LISTENING уже выставлен interrupt()
      }
      console.error(`[${callId}] LLM ошибка:`, e.message);
      await speak(APOLOGY_ERROR);
      return;                            // speak() сам вернул сессию в LISTENING
    }
    drainComplete();                            // добиваем завершённые предложения
    const tail = raw.slice(consumed).trim();
    if (tail) enqueueSpeak(tail);               // последний «хвост» без терминатора
    // Гейт телефона по ПОЛНОМУ ответу: пофразовая проверка с лукахедом могла пропустить
    // обещание звонка, чью просьбу номера стрим так и не прислал — добиваем просьбу.
    if (!stopSpeaking && spoken.length && needsPhoneAsk(history, spoken.join(" "))) {
      const ask = phoneAsk(history);
      console.log(`[${callId}] ${ts()} ответ обещает звонок без просьбы номера — добавляю: "${ask}"`);
      spoken.push(ask);
      evaSpokenText += " " + ask;
      for (const part of splitSentences(ask)) speaker.say(token, part);
    }
    await speaker.drain();                      // ждём, пока всё синтезировано и поставлено в очередь
    clearTimeout(fillerTimer);                  // дальше маскировать нечего (гейты прикрыли бы и так)

    if (ac.signal.aborted) {             // barge-in во время SPEAKING
      if (spoken.length) history.push({ role: "assistant", text: spoken.join(" ") });
      return;                            // LISTENING уже выставлен interrupt()
    }

    // Ход не перебили, но Ева не произнесла ни звука: синтез упал на всех предложениях (TTS
    // недоступен) или модель вернула пустой/только-приветственный ответ. Не оставляем «мёртвую
    // тишину» перед владельцем — коротко извиняемся и снова слушаем.
    if (!speaker.spokeThisTurn) {
      console.warn(`[${callId}] ${ts()} ход без озвучки — извиняемся вместо тишины`);
      await speak(APOLOGY_UNHEARD);
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
        clearTimeout(idleTimer);              // голос в линии — «алло?» не нужен
        // Пока слово у Евы (приветствие/размышление/речь) — проверяем партиал на barge-in.
        // Политика — в shouldInterrupt(): слово у Евы + окно прогрева GRACE_MS (от floorAt)
        // + содержательность + эхо-гейты (≠ последней финализации lastFinalText и не эхо
        // собственной речи Евы evaSpokenText). Поверх политики — sustain-гейт: перебиваем
        // только УСТОЙЧИВУЮ речь (потребуется второй+ партиал той же попытки спустя
        // BARGE_SUSTAIN_MS) — одиночный всплеск шума/чужого разговора Еву не глушит.
        // ⚠️ Эвристика «первого приближения», тюнится на реальных звонках (см. spec):
        //   1) эхо-гейт строгий (==): дословный повтор той же фразы абонентом не перебьёт —
        //      на практике редко, т.к. партиалы растут пословно и перебивают раньше полного
        //      совпадения; floorAt задаётся в начале THINKING, и при медленном LLM грейс может
        //      истечь, пока Ева ещё молчит. Уточнить пороги по логам живых звонков.
        if (state === "SPEAKING" || state === "THINKING") {
          const now = Date.now();
          const sinceFloor = now - floorAt;
          if (shouldInterrupt(state, t, sinceFloor, GRACE_MS, lastFinalText, evaSpokenText)) {
            if (!bargeFirstAt || now - bargeLastAt > BARGE_RETRY_RESET_MS) bargeFirstAt = now;
            bargeLastAt = now;
            if (now - bargeFirstAt >= BARGE_SUSTAIN_MS) {
              interrupt(t);
            } else {
              console.log(`[${callId}] ${ts()} barge-in кандидат (${now - bargeFirstAt}/${BARGE_SUSTAIN_MS}мс): "${t}"`);
            }
          } else if (isSubstantive(t)) {
            // «Почти-перебивание»: содержательная речь, пока слово у Евы, но barge-in не сработал.
            // Логируем причину и тайминг — ровно те данные, по которым на живых звонках тюнятся
            // GRACE_MS и эхо-гейты (см. spec, отложенный tuning pass). Только лог, без влияния на
            // поведение.
            const why = sinceFloor < GRACE_MS ? `грейс ${sinceFloor}/${GRACE_MS}мс`
              : t === lastFinalText ? "эхо последней реплики"
              : isEchoOf(t, evaSpokenText) ? "эхо речи Евы"
              : "иное";
            console.log(`[${callId}] ${ts()} barge-in подавлен [${why}] @${state}: "${t}"`);
          }
          return;
        }
        // LISTENING: обычный эндпойнтинг.
        console.log(`[${callId}] ${ts()} …${t}`);
        // Партиал изменился — речь продолжается, сбрасываем таймер конца фразы. Реплика
        // завершается, когда ни партиалов, ни речевых кадров нет ENDPOINT_MS подряд
        // (по стенным часам, не по audio-time) — см. гейты в onEndpointFire.
        if (t && t !== pendingPartial) {
          if (!turnVoiceFirstAt) turnVoiceFirstAt = Date.now();
          pendingPartial = t;
          armEndpoint();
        }
      },
      // Финал Yandex (stt-eou) НЕ запускает ход немедленно: Yandex режет реплику по своим
      // коротким паузам (и по «дырам» нестабильной сети), и Ева отвечала на полуфразе.
      // Финалы копятся сегментами; ход стартует только по нашей тишине ENDPOINT_MS.
      onFinal: (t) => {
        if (closed) return;
        clearTimeout(idleTimer);              // голос в линии — «алло?» не нужен
        if (state !== "LISTENING") return;    // финал, пока слово у Евы (поддакивание/эхо) — игнор
        // Дедуп запоздавшего повтора: Yandex stt-eou дублирует уже обработанную реплику
        // спустя ~5с (audio-time лаг) — не даём дублю стать сегментом следующего хода.
        // freshVoice-исключение: живое «да» на следующий вопрос дублем не считается.
        if (sameText(t, lastFinalText) && Date.now() - lastFinalAt < DEDUP_MS && !freshVoice()) {
          console.log(`[${callId}] ${ts()} дубль сегмента [stt-eou] пропущен: ${t}`);
          return;
        }
        if (segments.length && sameText(segments[segments.length - 1], t)) return; // повтор подряд
        if (!turnVoiceFirstAt) turnVoiceFirstAt = Date.now();
        segments.push(t);
        pendingPartial = "";                  // партиал поглощён финалом
        armEndpoint();
      },
      onError: (e) => console.error(`[${callId}] STT ошибка:`, e.message || e),
      onReconnect: (n) => console.warn(`[${callId}] ${ts()} STT-поток переподключён (попытка ${n})`),
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
  // Один раз за звонок (stop и close могут прийти оба) — промис МЕМОИЗИРУЕТСЯ, чтобы
  // SIGTERM-дренаж дождался уже летящей доставки, а не получил мгновенный no-op (раньше
  // рестарт сразу после трубки убивал доставку на полпути). Любой сбой — только лог.
  let leadPromise = null;
  function finalizeLead() {
    if (!leadPromise) leadPromise = deliverLeadOnce();
    return leadPromise;
  }
  async function deliverLeadOnce() {
    try {
      const { hasOrder, fields } = await deps.extractOrder(history);
      // Телефон без «оформленной заявки» — всё равно лид: клиент оставил контакт для
      // расчёта. Раньше такой звонок молча пропадал.
      if (!hasOrder && !(fields?.phone || "").trim()) {
        console.log(`[${callId}] заявка не оформлена и телефона нет — в Telegram не шлём`);
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
      if (player) { // повторный start-кадр пересоздал бы STT/плеер, потеряв текущие
        console.warn(`[${callId}] повторный start-кадр — игнорирую`);
        return;
      }
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
    clearTimeout(idleTimer);
    try { speaker?.abort(); } catch {}        // очередь синтеза не должна жечь TTS-вызовы после трубки
    if (stt) stt.close();
    if (player) player.stop();
    // Сессию из дренажа убираем ТОЛЬКО когда заявка доставлена/провалена: иначе рестарт
    // сразу после трубки не ждал летящую доставку и терял лид.
    finalizeLead().finally(() => sessions.delete(session));
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
  // Дедлайн на дренаж: зависший вызов Yandex/Telegram не должен держать процесс вечно.
  // 45с > худшего бюджета доставки (extractOrder 2×15с + повтор Telegram 2×10с) — иначе
  // дедлайн убивал доставку раньше, чем лид успевал упасть в leads.ndjson.
  try { await Promise.race([drainSessions(sessions), new Promise((r) => setTimeout(r, 45_000))]); } catch {}
  process.exit(0);
}

// Прогрев PCM-кэша константными фразами (8кГц — телефонный формат Voximplant): первый
// звонок снимает трубку мгновенно, а не после трёх HTTPS-вызовов TTS. Заодно прогревается
// keep-alive-соединение к tts.api. Сбой РЕТРАИТСЯ (живой случай: таймаут TTS на старте):
// приветствие/извинения кэш добрал бы лениво по ходу звонков, но филлеры играются ТОЛЬКО
// из кэша — без ретрая один неудачный прогрев оставил бы весь процесс без филлеров.
// Параметры инжектируются ради тестов; боевой вызов — без аргументов.
export async function prewarmPcmCache({
  synth = synthesizePcm,
  cache = DEFAULT_DEPS.pcmCache,
  attempts = 3,
  retryDelayMs = 10_000,
} = {}) {
  const texts = [GREETING, APOLOGY_ERROR, APOLOGY_UNHEARD, BOT_DEFLECT, ...FILLER_TEXTS, ...IDLE_PROMPTS, ...PHONE_ASKS]
    .flatMap(splitSentences);
  for (const text of texts) PINNED_PCM_KEYS.add(`8000:${text}`); // прогретое не вымещается
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      for (const text of texts) {
        const key = `8000:${text}`;
        if (cache.has(key)) continue;
        cache.set(key, await synth(text, 8000));
      }
      console.log(`TTS-кэш прогрет: ${texts.length} фраз`);
      return;
    } catch (e) {
      const last = attempt === attempts;
      console.warn(`⚠ прогрев TTS-кэша не удался (${e.message})${last
        ? " — попытки исчерпаны, синтез пойдёт лениво (филлеры будут недоступны)"
        : ` — повтор через ${retryDelayMs / 1000}с`}`);
      if (!last) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}

// Старт сервера — только когда файл запущен напрямую (а не импортирован тестом, который берёт
// runSession). Здесь же fail-fast по ключам Yandex, чтобы импорт модуля в тестах не падал.
function start() {
  assertEnv(process.env, ["YANDEX_API_KEY", "YANDEX_FOLDER_ID"], "Yandex");
  if (missingKeys(process.env, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]).length) {
    console.warn("⚠ TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — заявки НЕ уйдут в Telegram");
  }
  prewarmPcmCache(); // не ждём: сервер слушает сразу, кэш догревается в фоне
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
