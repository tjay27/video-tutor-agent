import type { SarvamAI } from "sarvamai";
import { sarvam } from "./sarvam.js";
import { config, TTS_LANGUAGES } from "../config.js";

export function toTtsLanguage(language?: string | null): SarvamAI.TextToSpeechLanguage {
  // Realtime STT reports Odia as "or-IN"; TTS calls it "od-IN".
  const code = language === "or-IN" ? "od-IN" : language;
  return TTS_LANGUAGES.find((l) => l === code) ?? config.tts.fallbackLanguage;
}

/** Strips things that sound bad when read aloud (timestamps, markdown). */
export function toSpeakableText(text: string): string {
  return text
    .replace(/\s*\[[\d:,;&\s–-]*\d:\d{2}[\d:,;&\s–-]*\]/g, "") // [4:12], [23:52, 24:41]
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits text into chunks under the TTS character limit, on sentence boundaries. */
function chunkText(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?।]+[.!?।]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      chunks.push(current.trim());
      current = "";
    }
    // A single sentence longer than the limit gets hard-split.
    for (let i = 0; i < sentence.length; i += maxChars) {
      const piece = sentence.slice(i, i + maxChars);
      if (current.length + piece.length > maxChars) {
        chunks.push(current.trim());
        current = "";
      }
      current += piece;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Returns MP3 audio for the given text. */
export async function synthesize(text: string, language?: string | null): Promise<Buffer> {
  const speakable = toSpeakableText(text);
  const language_code = toTtsLanguage(language);

  const buffers: Buffer[] = [];
  for (const chunk of chunkText(speakable, config.tts.maxChars)) {
    const res = await sarvam.textToSpeech.convert({
      text: chunk,
      language_code,
      model: config.tts.model,
      speaker: config.tts.speaker,
      output_audio_codec: config.tts.codec,
    });
    for (const b64 of res.audios) buffers.push(Buffer.from(b64, "base64"));
  }
  // MP3 frames can be concatenated directly.
  return Buffer.concat(buffers);
}
