import { HttpError } from "../errors.js";
import type { Transcript } from "../types.js";

// In-memory store. This is the handoff point between the transcription module
// (writes) and the tutor (reads). Swap for Redis/SQLite later if needed.
const transcripts = new Map<string, Transcript>();

export function saveTranscript(transcript: Transcript): Transcript {
  validateTranscript(transcript);
  transcripts.set(transcript.videoId, transcript);
  return transcript;
}

export function getTranscript(videoId: string): Transcript | null {
  return transcripts.get(videoId) ?? null;
}

export function listTranscripts() {
  return [...transcripts.values()].map(({ videoId, title, language, source, segments }) => ({
    videoId,
    title,
    language,
    source,
    segmentCount: segments.length,
  }));
}

function validateTranscript(t: Transcript) {
  if (!t || typeof t.videoId !== "string" || !t.videoId) {
    throw new HttpError(400, "transcript.videoId is required");
  }
  if (!Array.isArray(t.segments) || t.segments.length === 0) {
    throw new HttpError(400, "transcript.segments must be a non-empty array");
  }
  for (const s of t.segments) {
    if (typeof s.start !== "number" || typeof s.text !== "string") {
      throw new HttpError(400, "each segment needs a numeric start and a text string");
    }
  }
}
