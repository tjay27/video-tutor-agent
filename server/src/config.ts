import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SarvamAI } from "sarvamai";

const apiKey = process.env.SARVAM_API_KEY;
if (!apiKey) {
  console.error("Missing SARVAM_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

export const TTS_LANGUAGES: readonly SarvamAI.TextToSpeechLanguage[] = [
  "en-IN", "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
];

const serverRoot = fileURLToPath(new URL("..", import.meta.url));

const num = (v: string | undefined, fallback: number) => (v !== undefined && v !== "" ? Number(v) : fallback);
// Public deployment (e.g. Render): bundled demo videos only, no debug
// endpoints, and limits so visitors can't run up the Sarvam bill.
const hosted = process.env.HOSTED === "true" || process.env.NODE_ENV === "production";

export const config = {
  port: Number(process.env.PORT) || 8787,
  sarvamApiKey: apiKey,
  hosted,

  // Voice session limits. 0 = no limit. Defaults apply only when hosted.
  limits: {
    maxSessionSeconds: num(process.env.MAX_SESSION_SECONDS, hosted ? 300 : 0),
    idleSeconds: num(process.env.IDLE_SECONDS, hosted ? 90 : 0),
    maxConcurrentSessions: num(process.env.MAX_CONCURRENT_SESSIONS, hosted ? 3 : 0),
    maxSessionsPerIpPerDay: num(process.env.MAX_SESSIONS_PER_IP_PER_DAY, hosted ? 8 : 0),
  },

  transcription: {
    ytDlpPath: process.env.YT_DLP_PATH || join(serverRoot, "bin", "yt-dlp"),
    // Per-video cache: info, audio, captions, STT output, final transcript.
    dataDir: process.env.DATA_DIR || join(serverRoot, "data", "videos"),
    sttModel: (process.env.TRANSCRIPT_STT_MODEL || "saaras:v4") as SarvamAI.SpeechToTextBatchModel,
    // Keeps English words in English inside Hindi/Indic speech.
    sttMode: "codemix" as SarvamAI.Mode,
    // Sarvam batch accepts up to ~1 hour per file without splitting.
    maxDurationSeconds: Number(process.env.TRANSCRIPT_MAX_SECONDS) || 60 * 60,
    batchTimeoutSeconds: 30 * 60,
  },

  llm: {
    model: (process.env.LLM_MODEL || "sarvam-105b") as SarvamAI.SarvamModelIds,
    // sarvam-105b reasons by default. Measured on a short prompt: "off" ≈ 0.5 s,
    // "low" ≈ 14 s and it can spend the whole max_tokens budget thinking.
    // Grounded Q&A over a transcript doesn't need reasoning, so it's off.
    reasoningEffort: (process.env.LLM_REASONING_EFFORT || "off") as SarvamAI.ReasoningEffort | "off",
    maxTokens: 1024,
    // How many previous question/answer pairs to send with a new question.
    historyTurns: 6,
  },

  stt: {
    model: (process.env.STT_MODEL || "saaras:v3") as SarvamAI.SpeechToTextModel,
    mode: (process.env.STT_MODE || "transcribe") as SarvamAI.Mode,
    // REST STT accepts at most 30 s of audio. Longer audio needs the batch API.
    maxUploadBytes: 10 * 1024 * 1024,
  },

  // Phone-call mode: realtime STT (with Sarvam's VAD doing turn detection)
  // and streaming TTS, both over WebSockets.
  call: {
    sttModel: (process.env.CALL_STT_MODEL || "saaras:v3-realtime") as SarvamAI.SpeechToTextRealtimeStreamingModel,
    // Browser sends 16 kHz mono 16-bit PCM.
    inputSampleRate: 16000,
    // Silence before Sarvam's VAD calls end of speech.
    silenceMs: Number(process.env.CALL_SILENCE_MS) || 600,
    // Audio kept from just before VAD detected speech, so opening words
    // ("What all is…") aren't clipped, especially when talking over the tutor.
    prefixPaddingMs: Number(process.env.CALL_PREFIX_PADDING_MS) || 300,
    // After that, the turn analyzer decides if the thought is complete:
    holdCompleteMs: Number(process.env.CALL_HOLD_COMPLETE_MS) || 100, // complete → answer almost at once
    holdIncompleteMs: Number(process.env.CALL_HOLD_INCOMPLETE_MS) || 2000, // unfinished → wait for more
    // Fallback waits by punctuation, if the analyzer fails or times out.
    holdQuestionMs: Number(process.env.CALL_HOLD_QUESTION_MS) || 200, // ends with "?"
    holdSentenceMs: Number(process.env.CALL_HOLD_SENTENCE_MS) || 500, // ends with "." or "!"
    // Early barge-in decision once this many words of live transcript exist.
    earlyDecisionWords: 3,
    // Talking again within this long after the tutor starts answering means the
    // student is still mid-question: the answer is dropped and the words merged.
    continuationMs: Number(process.env.CALL_CONTINUATION_MS) || 1500,
    // Unfinished words older than this are dropped rather than merged.
    pendingMaxAgeMs: 12_000,
    // Suggest hold-to-talk after this many ignored utterances within 30 s.
    noisyThreshold: 3,
    // TTS output: raw 16-bit PCM, played directly with Web Audio.
    outputSampleRate: 24000,
  },

  tts: {
    model: (process.env.TTS_MODEL || "bulbul:v3") as SarvamAI.TextToSpeechModel,
    speaker: (process.env.TTS_SPEAKER || "shubh") as SarvamAI.TextToSpeechSpeaker,
    codec: "mp3" as SarvamAI.TextToSpeechOutputAudioCodec,
    // bulbul:v3 accepts up to 2500 characters per request.
    maxChars: 2500,
    fallbackLanguage: "en-IN" as SarvamAI.TextToSpeechLanguage,
  },
};
