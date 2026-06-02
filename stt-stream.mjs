// Обёртка над Yandex SpeechKit v3 (gRPC, потоковое распознавание).
// openStt() возвращает { write(pcm), close() }. Колбэки: onPartial(text), onFinal(text), onError(err).
// Пакет в .proto называется speechkit.stt.v3 (НЕ yandex.cloud.ai.stt.v3).
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

export function openStt({ sampleRate = 8000, onPartial = () => {}, onFinal = () => {}, onError = () => {} }) {
  const client = new Recognizer(
    "stt.api.cloud.yandex.net:443",
    grpc.credentials.createSsl(),
  );
  const metadata = new grpc.Metadata();
  metadata.add("authorization", `Api-Key ${API_KEY}`);

  const stream = client.RecognizeStreaming(metadata);

  // Первое сообщение — настройки сессии: сырой PCM (LINEAR16), моно, частота из M0.
  stream.write({
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
    },
  });

  stream.on("data", (res) => {
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
  stream.on("error", onError);

  return {
    write(pcm) { stream.write({ chunk: { data: pcm } }); },
    close() { try { stream.end(); } catch {} },
  };
}
