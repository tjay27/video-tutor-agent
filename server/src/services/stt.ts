import type { SarvamAI } from "sarvamai";
import { sarvam } from "./sarvam.js";
import { config } from "../config.js";

// Short clips only (user's spoken question, max 30 s).
// Full-video transcription uses the batch API in the transcription module.

export interface SpokenQuestion {
  text: string;
  /** Detected language, e.g. "hi-IN". Null if Sarvam couldn't tell. */
  language: string | null;
}

export async function transcribeClip(args: {
  audio: Buffer;
  filename: string;
  contentType: string;
  language?: SarvamAI.SpeechToTextLanguage;
}): Promise<SpokenQuestion> {
  const res = await sarvam.speechToText.transcribe({
    file: { data: args.audio, filename: args.filename, contentType: args.contentType },
    model: config.stt.model,
    mode: config.stt.mode,
    language_code: args.language ?? "unknown",
  });

  return { text: res.transcript.trim(), language: res.language_code ?? null };
}
