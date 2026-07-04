// node --test stream-session.test.mjs
// Регрессия на «баг завершения звонка»: когда абонент кладёт трубку (ws "close"), сессия
// должна (1) оборвать текущий ход LLM и (2) не запускать новые ходы по запоздавшим событиям
// STT. Иначе Ева «думает и говорит» в уже закрытый сокет, впустую тратя вызовы Yandex
// (см. лог живого звонка: реплика синтезировалась через ~2с ПОСЛЕ отключения).
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { runSession, FILLER_TEXTS, IDLE_PROMPTS, prewarmPcmCache, evictOverflow } from "./stream-server.mjs";
import { PHONE_ASKS } from "./reply-clean.mjs";

class FakeWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(data); }
}

const startFrame = () =>
  JSON.stringify({ event: "start", start: { mediaFormat: { sampleRate: 8000 } } });

function makeDeps() {
  const cap = { askCalls: 0, signal: null, onFinal: null, onPartial: null, onChunk: null, synthed: [], messages: null };
  const deps = {
    // Эндпойнт по умолчанию короткий (60мс), чтобы тесты не ждали боевые ~1.2с тишины
    // на каждый ход; тесты, проверяющие сам эндпойнтинг, задают своё значение.
    endpointMs: 60,
    askStream: (messages, onChunk, { signal } = {}) => {
      cap.askCalls++;
      cap.signal = signal;
      cap.onChunk = onChunk;
      cap.messages = messages;
      return new Promise(() => {}); // ход «в полёте» — намеренно никогда не завершается
    },
    synthesizePcm: async (text) => { cap.synthed.push(text); return Buffer.alloc(320); }, // 1 кадр 20мс @ 8кГц
    openStt: ({ onFinal, onPartial }) => {
      cap.onFinal = onFinal;
      cap.onPartial = onPartial;
      return { write() {}, close() {} };
    },
    extractOrder: async () => ({ hasOrder: false, fields: {} }),
    deliverLead: async () => ({ ok: true }),
  };
  return { deps, cap };
}

// Догнать сессию до начала хода: дождаться LISTENING (приветствие доиграло) и
// финализировать реплику абонента, чтобы askStream был вызван.
async function startTurn(cap, text = "хочу визитки тысячу штук") {
  for (let i = 0; i < 100 && cap.askCalls === 0; i++) {
    cap.onFinal?.(text);
    if (cap.askCalls) break;
    await sleep(20);
  }
  assert.ok(cap.askCalls > 0, "ход должен стартовать (askStream вызван)");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("close обрывает текущий ход LLM (signal.aborted)", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  runSession(ws, deps);
  ws.emit("message", startFrame());

  // Дожидаемся LISTENING: пока играет приветствие, onFinal игнорируется (state !== LISTENING);
  // как только сессия слушает — финал запускает ход, и askStream вызывается.
  for (let i = 0; i < 100 && cap.askCalls === 0; i++) {
    cap.onFinal?.("хочу визитки тысячу штук");
    if (cap.askCalls) break;
    await sleep(20);
  }
  assert.equal(cap.askCalls, 1, "ход должен стартовать (askStream вызван)");
  assert.equal(cap.signal.aborted, false, "пока звонок жив — ход не оборван");

  ws.emit("close");
  assert.equal(cap.signal.aborted, true, "после close ход LLM должен быть оборван");
});

// Ответ-список без точек («* Визитки\n* Баннеры\n») не содержит [.!?…] — без разбиения
// по \n стриминговый путь молчал бы до конца генерации (худший случай нестриминга).
// Перенос строки должен резать на озвучиваемые куски ещё ВО ВРЕМЯ стрима LLM.
test("список с \\n озвучивается построчно, не дожидаясь конца стрима LLM", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await startTurn(cap);

    const before = cap.synthed.length; // приветствие уже синтезировано
    cap.onChunk("* Визитки\n* Баннеры\n");   // стрим ещё идёт (промис не резолвится)
    await sleep(30);
    assert.deepStrictEqual(cap.synthed.slice(before), ["Визитки", "Баннеры"]);
  } finally {
    ws.emit("close"); // иначе heartbeat-интервал сессии не даст тестам завершиться
  }
});

// VAD-гейт: если на момент срабатывания эндпойнта кадры ещё идут (абонент пыхтит/шумит,
// партиал застыл), финал откладывается. Раньше отсрочка заново взводила ПОЛНОЕ окно
// (до +1000мс лишней тишины) — теперь короткий ре-чек добивает финал, как только кадры
// высохли. Тайминги масштабированы: endpointMs 900 / recheck 100 / кадры 10мс.
test("VAD-отсрочка финализирует коротким ре-чеком, а не полным окном заново", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.endpointMs = 900;
  deps.vadRecheckMs = 100;
  runSession(ws, deps);
  const media = () => JSON.stringify({
    event: "media",
    media: { timestamp: 0, chunk: 0, payload: Buffer.alloc(320).toString("base64") },
  });
  let frames = null;
  try {
    ws.emit("message", startFrame());
    await sleep(400);                       // приветствие доиграло → LISTENING
    const t0 = Date.now();
    cap.onPartial("хочу визитки");          // партиал застыл — взводится эндпойнт (900мс)
    frames = setInterval(() => ws.emit("message", media()), 10); // «речь» идёт
    while (Date.now() - t0 < 950) await sleep(25); // кадры живут дольше окна эндпойнта
    clearInterval(frames); frames = null;          // тишина

    // Старое поведение: повторное полное окно → финал только к ~t0+1800. Новое: ре-чек
    // каждые 100мс добивает финал, как только кадры выпали из 300мс-окна (~t0+1200).
    while (Date.now() - t0 < 1500 && cap.askCalls === 0) await sleep(50);
    assert.equal(cap.askCalls, 1, "финал должен прийти коротким ре-чеком (без полного окна)");
  } finally {
    if (frames) clearInterval(frames);
    ws.emit("close");
  }
});

// Приветствие — константа, но синтезировалось живым TTS-вызовом на КАЖДОМ звонке
// (3 предложения × HTTPS). С PCM-кэшем второй звонок берёт готовые буферы: трубка
// снимается мгновенно, и первый ход не делит сеть с синтезом приветствия.
test("PCM-кэш: приветствие синтезируется один раз на процесс, не на каждый звонок", async () => {
  const { deps, cap } = makeDeps();
  deps.pcmCache = new Map();

  const ws1 = new FakeWs();
  runSession(ws1, deps);
  try {
    ws1.emit("message", startFrame());
    await sleep(300);
    assert.ok(cap.synthed.length >= 3, "первый звонок синтезирует приветствие");
  } finally { ws1.emit("close"); }
  const after1 = cap.synthed.length;

  const ws2 = new FakeWs();
  runSession(ws2, deps);
  try {
    ws2.emit("message", startFrame());
    await sleep(300);
    assert.equal(cap.synthed.length, after1, "второй звонок берёт приветствие из кэша");
    const media = ws2.sent.filter((s) => JSON.parse(s).event === "media");
    assert.ok(media.length >= 3, "кадры приветствия отданы абоненту из кэша");
  } finally { ws2.emit("close"); }
});

// Филлер «думания»: если через fillerMs после старта хода ни одного настоящего кадра ещё
// нет (LLM/TTS медленные), в плеер уходит готовый PCM из кэша — абонент слышит
// «Секундочку…» вместо мёртвой тишины. Байты различимы: филлер = 7, настоящий синтез = 1.
test("филлер играет на медленном ходе и НЕ играет на быстром", async () => {
  const fillerByte = 7, realByte = 1;
  const sentBytes = (ws) => ws.sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.event === "media")
    .map((m) => Buffer.from(m.media.payload, "base64")[0]);

  // --- Медленный ход: askStream висит вечно → филлер должен прозвучать, и сразу за ним —
  // пауза тишины (нулевые кадры), чтобы связка не склеивалась с подоспевшим ответом.
  {
    const ws = new FakeWs();
    const { deps, cap } = makeDeps();
    deps.synthesizePcm = async (text) => { cap.synthed.push(text); return Buffer.alloc(320, realByte); };
    deps.fillerMs = 40;
    deps.pcmCache = new Map(FILLER_TEXTS.map((t) => [`8000:${t}`, Buffer.alloc(320, fillerByte)]));
    runSession(ws, deps);
    try {
      ws.emit("message", startFrame());
      await startTurn(cap);
      await sleep(150); // > fillerMs, LLM всё ещё «думает»
      const bytes = sentBytes(ws);
      const at = bytes.indexOf(fillerByte);
      assert.ok(at >= 0, "филлер должен уйти в плеер на медленном ходе");
      assert.equal(bytes[at + 1], 0, "за филлером — пауза тишины, а не стык с ответом");
    } finally { ws.emit("close"); }
  }

  // --- Ответ уже в синтезе (LLM отдал предложение, TTS варится): филлер пропускается —
  // ответ в сотнях мс, связка прозвучала бы вплотную к нему и только оттянула бы его.
  {
    const ws = new FakeWs();
    const { deps, cap } = makeDeps();
    deps.synthesizePcm = (text) => new Promise((resolve) => {
      cap.synthed.push(text);
      setTimeout(() => resolve(Buffer.alloc(320, realByte)), 120); // медленный TTS
    });
    deps.askStream = (_m, onChunk) => {
      cap.askCalls++;
      onChunk("Готово.");            // первое предложение уже есть
      return new Promise(() => {});  // стрим ещё идёт
    };
    deps.fillerMs = 40;
    deps.pcmCache = new Map(FILLER_TEXTS.map((t) => [`8000:${t}`, Buffer.alloc(320, fillerByte)]));
    runSession(ws, deps);
    try {
      ws.emit("message", startFrame());
      await startTurn(cap);
      await sleep(250); // филлер-таймер (40мс) сработал, пока TTS ответа варился
      const bytes = sentBytes(ws);
      assert.ok(!bytes.includes(fillerByte), "ответ неминуем — филлер должен быть пропущен");
      assert.ok(bytes.includes(realByte), "сам ответ прозвучал");
    } finally { ws.emit("close"); }
  }

  // --- Быстрый ход: первое предложение готово сразу → филлер не нужен.
  {
    const ws = new FakeWs();
    const { deps, cap } = makeDeps();
    deps.synthesizePcm = async (text) => { cap.synthed.push(text); return Buffer.alloc(320, realByte); };
    deps.askStream = async (_m, onChunk) => { cap.askCalls++; onChunk("Готово."); return "Готово."; };
    deps.fillerMs = 40;
    deps.pcmCache = new Map(FILLER_TEXTS.map((t) => [`8000:${t}`, Buffer.alloc(320, fillerByte)]));
    runSession(ws, deps);
    try {
      ws.emit("message", startFrame());
      await startTurn(cap);
      await sleep(150);
      assert.ok(!sentBytes(ws).includes(fillerByte), "на быстром ходе филлер лишний");
      assert.ok(sentBytes(ws).includes(realByte), "настоящий ответ прозвучал");
    } finally { ws.emit("close"); }
  }
});

// Прогрев кэша обязан переживать сетевой сбой (живой случай: таймаут TTS на старте).
// Филлеры играются ТОЛЬКО из кэша — без ретрая один неудачный прогрев лишает весь
// процесс филлеров. Ретрай добивает недостающие фразы.
test("prewarmPcmCache: ретраит после сбоя и добивает кэш", async () => {
  const cache = new Map();
  let calls = 0;
  const synth = async (text) => {
    calls++;
    if (calls <= 2) throw new Error("timeout");   // первые попытки падают
    return Buffer.from(text);
  };
  await prewarmPcmCache({ synth, cache, attempts: 3, retryDelayMs: 1 });
  for (const t of FILLER_TEXTS) {
    assert.ok(cache.has(`8000:${t}`), `филлер «${t}» должен быть в кэше после ретрая`);
  }
});

// Раньше stt-eou финал Yandex НЕМЕДЛЕННО запускал ход — Ева отвечала на полуфразе, если
// абонент сделал паузу в середине мысли (или нестабильная сеть «порезала» реплику).
// Теперь финалы накапливаются сегментами, и ход стартует только после настоящей тишины
// окна эндпойнта — Ева говорит, лишь когда абонент реально замолчал.
test("stt-финал накапливается: ход стартует после тишины, сегменты склеиваются", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.endpointMs = 150;
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await sleep(400); // приветствие доиграло → LISTENING
    cap.onFinal("хочу заказать визитки");
    await sleep(50);
    assert.equal(cap.askCalls, 0, "сразу после финала Ева ещё ждёт тишину");
    cap.onFinal("сто штук на завтра"); // продолжение мысли после паузы, порезанной EOU
    await sleep(350);                  // тишина выдержана — ход стартует
    assert.equal(cap.askCalls, 1, "после тишины ход стартует один раз");
    const user = cap.messages.filter((m) => m.role === "user").at(-1);
    assert.equal(user.text, "хочу заказать визитки сто штук на завтра", "сегменты склеены в одну реплику");
  } finally { ws.emit("close"); }
});

// Голос-гейт эндпойнта: партиалы STT продолжают приходить (пусть и с тем же текстом) —
// абонент ещё говорит, финализировать нельзя. Раньше окно мерилось только от СМЕНЫ текста
// партиала: застывший партиал при продолжающейся речи финализировался на полуслове.
test("эндпойнт не срабатывает, пока партиалы продолжают приходить", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.endpointMs = 120;
  deps.vadRecheckMs = 30;
  runSession(ws, deps);
  let talk = null;
  try {
    ws.emit("message", startFrame());
    await sleep(400); // приветствие доиграло → LISTENING
    talk = setInterval(() => cap.onPartial("алло алло"), 40); // текст застыл, но голос идёт
    await sleep(400);
    assert.equal(cap.askCalls, 0, "пока партиалы идут — Ева молчит");
    clearInterval(talk); talk = null; // абонент замолчал
    await sleep(300);
    assert.equal(cap.askCalls, 1, "после настоящей тишины ход стартует");
  } finally {
    if (talk) clearInterval(talk);
    ws.emit("close");
  }
});

// Хвостовое эхо: на громкой связи конец реплики Евы возвращается с микрофона уже ПОСЛЕ
// перехода в LISTENING и без гейта становился «ходом абонента» — Ева отвечала сама себе.
test("эхо собственной речи Евы после приветствия не становится ходом", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.endpointMs = 100;
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await sleep(400); // приветствие доиграло → LISTENING
    cap.onPartial("это типография альфа принт чем могу помочь"); // эхо в трубке
    await sleep(300);
    assert.equal(cap.askCalls, 0, "эхо-хвост отброшен, ход не стартует");
    cap.onPartial("мне нужны листовки быстро"); // настоящая речь абонента
    await sleep(300);
    assert.equal(cap.askCalls, 1, "настоящая речь после эха обрабатывается");
  } finally { ws.emit("close"); }
});

// Sustain-гейт barge-in: одиночный всплеск STT (шум линии, чужой разговор в комнате)
// больше не обрывает речь Евы — перебивание требует УСТОЙЧИВОЙ речи (второй партиал
// спустя bargeSustainMs). Раньше один партиал на ≥2 слова глушил её мгновенно.
test("barge-in: одиночный всплеск не перебивает, устойчивая речь перебивает", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.synthesizePcm = async () => Buffer.alloc(320 * 250); // 5с звука: Ева говорит долго
  deps.bargeSustainMs = 80;
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await sleep(600); // приветствие ещё играет (SPEAKING), грейс-окно (500мс) прошло
    cap.onPartial("подождите мне нужен баннер"); // одиночный всплеск — лишь кандидат
    await sleep(300); // дольше эндпойнта: перебивание запустило бы ход
    assert.equal(cap.askCalls, 0, "одиночный всплеск не перебивает Еву");
    cap.onPartial("подождите мне нужен баннер срочно"); // речь продолжается ≥ sustain
    for (let i = 0; i < 50 && cap.askCalls === 0; i++) await sleep(20);
    assert.equal(cap.askCalls, 1, "устойчивая речь перебивает: реплика становится ходом");
  } finally { ws.emit("close"); }
});

// Кулдаун филлера: «Секундочку…» на КАЖДОМ медленном ходе звучит как заевшая пластинка
// (живой фидбэк: «says filler words way too much»). Внутри кулдауна филлер пропускается.
test("филлер не повторяется на каждом медленном ходе (кулдаун)", async () => {
  const fillerByte = 7, realByte = 1;
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.fillerMs = 30;
  deps.fillerCooldownMs = 60_000;
  deps.pcmCache = new Map(FILLER_TEXTS.map((t) => [`8000:${t}`, Buffer.alloc(320, fillerByte)]));
  deps.synthesizePcm = async () => Buffer.alloc(320, realByte);
  // Каждый ход медленный (первое предложение через 120мс > fillerMs), но завершается.
  deps.askStream = (_m, onChunk) => {
    cap.askCalls++;
    return new Promise((resolve) => setTimeout(() => { onChunk("Готово."); resolve("Готово."); }, 120));
  };
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await startTurn(cap);                    // ход 1 — филлер должен прозвучать
    await sleep(500);                        // ход 1 договорил, Ева снова слушает
    cap.onFinal("а сколько стоит баннер");   // ход 2 — тоже медленный
    await sleep(500);
    assert.equal(cap.askCalls, 2, "оба хода состоялись");
    const fillers = ws.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.event === "media")
      .map((m) => Buffer.from(m.media.payload, "base64")[0])
      .filter((b) => b === fillerByte).length;
    assert.ok(fillers > 0, "первый медленный ход — с филлером");
    assert.equal(fillers, 1, "второй медленный ход внутри кулдауна — без филлера");
  } finally { ws.emit("close"); }
});

// Гигиена стримингового пути (паритет с turn-based cleanReply): женский род, срез
// ролеплея ещё в стриме, серверный гейт телефона. Раньше «Понял» и «Клиент: …»
// уходили в TTS как есть — мгновенный слуховой признак бота.
test("стриминг: женский род чинится пофразово («Понял» → «Поняла»)", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.askStream = async (_m, onChunk) => {
    cap.askCalls++;
    onChunk("Понял, записал вашу заявку.");
    return "Понял, записал вашу заявку.";
  };
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await startTurn(cap);
    await sleep(100);
    assert.ok(cap.synthed.includes("Поняла, записала вашу заявку."),
      `ожидалась феминизированная фраза, синтезировано: ${JSON.stringify(cap.synthed)}`);
  } finally { ws.emit("close"); }
});

test("стриминг: фальшивый ролеплей обрезается ещё в стриме и не озвучивается", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.askStream = async (_m, onChunk) => {
    cap.askCalls++;
    const full = "Тираж какой думаете? Клиент: штук триста. Ева: Отлично, записала.";
    onChunk(full);
    return full;
  };
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await startTurn(cap);
    await sleep(100);
    assert.ok(cap.synthed.includes("Тираж какой думаете?"), "настоящая реплика звучит");
    assert.ok(!cap.synthed.some((t) => /штук триста|Отлично, записала/.test(t)),
      `выдуманный диалог за клиента не должен звучать: ${JSON.stringify(cap.synthed)}`);
  } finally { ws.emit("close"); }
});

test("стриминг: обещание звонка без номера подменяется просьбой телефона", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.askStream = async (_m, onChunk) => {
    cap.askCalls++;
    const full = "Отлично, менеджер перезвонит с расчётом. Хорошего дня!";
    onChunk(full);
    return full;
  };
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await startTurn(cap); // в истории нет телефона
    await sleep(100);
    assert.ok(cap.synthed.some((t) => /продиктуйте/i.test(t)),
      `ожидалась просьба номера, синтезировано: ${JSON.stringify(cap.synthed)}`);
    assert.ok(!cap.synthed.some((t) => /Хорошего дня/.test(t)),
      "прощание после подмены не должно звучать");
  } finally { ws.emit("close"); }
});

// Лукахед гейта: если просьба номера уже есть дальше в сгенерированном ответе,
// валидную связку «обещание → просьба» НЕ клоббим канонической фразой.
test("стриминг: «перезвонит + на какой номер записать?» проходит без подмены", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.askStream = async (_m, onChunk) => {
    cap.askCalls++;
    const full = "Менеджер перезвонит с расчётом. На какой номер записать?";
    onChunk(full);
    return full;
  };
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await startTurn(cap);
    await sleep(100);
    assert.ok(cap.synthed.includes("Менеджер перезвонит с расчётом."), "обещание звучит как есть");
    assert.ok(cap.synthed.includes("На какой номер записать?"), "своя просьба номера сохранена");
    assert.ok(!cap.synthed.some((t) => /продиктуйте|Остался только телефон/i.test(t)),
      "каноническая подмена не должна была сработать");
  } finally { ws.emit("close"); }
});

// Вымещение кэша щадит закреплённые (прогретые) записи: раньше FIFO выкидывал
// приветствие и филлеры первыми, и после ~200 уникальных реплик филлеры умирали
// до рестарта процесса.
test("evictOverflow: закреплённые записи переживают переполнение кэша", () => {
  const cache = new Map();
  const pinned = new Set(["8000:греетинг", "8000:филлер"]);
  cache.set("8000:греетинг", Buffer.alloc(1));
  cache.set("8000:филлер", Buffer.alloc(1));
  for (let i = 0; i < 10; i++) cache.set(`8000:реплика-${i}`, Buffer.alloc(1));
  evictOverflow(cache, 5, pinned);
  assert.equal(cache.size, 5);
  assert.ok(cache.has("8000:греетинг") && cache.has("8000:филлер"), "прогретое не вымещается");
  assert.ok(!cache.has("8000:реплика-0"), "вымещается самая старая НЕзакреплённая");
});

// Молчание абонента: вместо бесконечной мёртвой тишины Ева переспрашивает «алло?» —
// максимум два раза, дальше молчит (не изводит абонента).
test("тишина в LISTENING → переспрос «алло?», не больше двух", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  deps.idlePromptMs = 60;
  runSession(ws, deps);
  try {
    ws.emit("message", startFrame());
    await sleep(700); // приветствие доиграло, дальше тишина — оба переспроса успевают
    const prompts = cap.synthed.filter((t) => IDLE_PROMPTS.includes(t));
    assert.ok(prompts.length >= 1, "первый переспрос должен прозвучать");
    assert.ok(prompts.length <= 2, `не больше двух переспросов, было: ${prompts.length}`);
  } finally { ws.emit("close"); }
});

test("close блокирует новый ход по запоздавшему STT-финалу", async () => {
  const ws = new FakeWs();
  const { deps, cap } = makeDeps();
  runSession(ws, deps);
  ws.emit("message", startFrame());

  await sleep(400);                 // приветствие доиграло → LISTENING, ход не начат
  ws.emit("close");
  cap.onFinal?.("перезвоните мне"); // запоздавший STT-финал уже после трубки
  await sleep(30);
  assert.equal(cap.askCalls, 0, "после close новый ход не должен стартовать");
});
