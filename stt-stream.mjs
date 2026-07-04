// Обёртка над Yandex SpeechKit v3 (gRPC, потоковое распознавание).
// openStt() возвращает { write(pcm), close() }. Колбэки: onPartial(text), onFinal(text), onError(err).
// Пакет в .proto называется speechkit.stt.v3 (НЕ yandex.cloud.ai.stt.v3).
//
// Устойчивость: gRPC-поток ПЕРЕОТКРЫВАЕТСЯ сам при ошибке или тихом end (нестабильная
// сеть, лимиты сессии Yandex). Раньше ошибка только логировалась — поток умирал, и Ева
// до конца звонка не слышала абонента. Кадры, попавшие в разрыв, осознанно теряются:
// это реальное время, буферизовать их некуда. onError по-прежнему зовётся (для лога),
// onReconnect(attempt) — после каждого успешного переоткрытия.
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

const API_KEY = process.env.YANDEX_API_KEY;
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = join(__dirname, "proto");

const pkgDef = protoLoader.loadSync("yandex/cloud/ai/stt/v3/stt_service.proto", {
  includeDirs: [PROTO_DIR],
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef);
const Recognizer = proto.speechkit.stt.v3.Recognizer;

// Первое сообщение каждой сессии — настройки: сырой PCM (LINEAR16), моно, частота из M0.
function sessionOptions(sampleRate) {
  return {
    session_options: {
      recognition_model: {
        model: "general",
        audio_format: {
          raw_audio: {
            audio_encoding: "LINEAR16_PCM",
            sample_rate_hertz: sampleRate,
            audio_channel_count: 1,
          },
        },
        text_normalization: { text_normalization: "TEXT_NORMALIZATION_ENABLED" },
        language_restriction: { restriction_type: "WHITELIST", language_code: ["ru-RU"] },
        audio_processing_type: "REAL_TIME",
      },
      // final приходит только по событию EOU (см. stt.proto). Без классификатора EOU
      // консервативен — финал ждёт долгую паузу, и Ева «не отвечает». HIGH + короткая
      // пауза-подсказка ускоряют завершение реплики ⇒ быстрый ход диалога.
      eou_classifier: {
        default_classifier: { type: "HIGH", max_pause_between_words_hint_ms: 700 },
      },
    },
  };
}

export function openStt({
  sampleRate = 8000,
  onPartial = () => {},
  onFinal = () => {},
  onError = () => {},
  onReconnect = () => {},
  connect = null,          // тестовый шов: фабрика дуплекс-потока вместо живого gRPC
  reconnectDelayMs = 300,  // базовая задержка переподключения (растёт экспоненциально до 5с)
} = {}) {
  let ownClient = null; // созданный нами gRPC-клиент — его канал надо закрыть в close()
  if (!connect) {
    const client = new Recognizer(
      "stt.api.cloud.yandex.net:443",
      grpc.credentials.createSsl(),
    );
    ownClient = client;
    const metadata = new grpc.Metadata();
    metadata.add("authorization", `Api-Key ${API_KEY}`);
    connect = () => client.RecognizeStreaming(metadata);
  }

  let closed = false;
  let stream = null;   // живой поток; null в разрыве (write тогда молча теряет кадр)
  let retries = 0;     // подряд неудачных подключений — для бэкоффа; сбрасывается на data
  let timer = null;

  function start() {
    const s = connect();
    stream = s;
    s.write(sessionOptions(sampleRate));
    // Все обработчики гейтятся «свой ли это поток»: запоздавшее событие уже заменённого
    // потока не должно ронять/перезапускать живую сессию.
    s.on("data", (res) => {
      if (s !== stream) return;
      retries = 0; // поток жив — бэкофф с нуля
      // События приходят в oneof "Event". Нас интересуют partial и final (AlternativeUpdate).
      if (res.partial?.alternatives?.length) {
        const text = res.partial.alternatives.map((a) => a.text).join(" ").trim();
        if (text) onPartial(text);
      }
      if (res.final?.alternatives?.length) {
        const text = res.final.alternatives.map((a) => a.text).join(" ").trim();
        if (text) onFinal(text);
      }
    });
    s.on("error", (e) => {
      if (s !== stream) return;
      stream = null;
      onError(e);
      scheduleRestart();
    });
    s.on("end", () => {
      if (s !== stream) return;
      stream = null;
      scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (closed || timer) return;
    const delay = Math.min(reconnectDelayMs * 2 ** Math.min(retries++, 4), 5000);
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      try { start(); onReconnect(retries); }
      catch (e) { onError(e); scheduleRestart(); }
    }, delay);
  }

  start();

  return {
    write(pcm) {
      if (closed || !stream) return; // разрыв: кадр осознанно теряем (реальное время)
      try { stream.write({ chunk: { data: pcm } }); }
      catch {} // умерший синхронно поток перезапустит его же error-обработчик
    },
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      try { stream?.end(); } catch {}
      stream = null;
      // Клиент создаётся на каждый звонок — без close() TLS-канал и его таймеры
      // копились бы процессом на каждый принятый звонок.
      try { ownClient?.close(); } catch {}
    },
  };
}
