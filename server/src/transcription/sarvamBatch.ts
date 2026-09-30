import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SarvamAI } from "sarvamai";
import { sarvam } from "../services/sarvam.js";
import { config } from "../config.js";
import type { Segment } from "../types.js";

/** Output file of a Sarvam batch STT job run with `with_timestamps: true`. */
export interface SarvamBatchOutput {
  transcript: string;
  language_code?: string;
  timestamps?: {
    words: string[];
    start_time_seconds: number[];
    end_time_seconds: number[];
  };
}

/** YouTube caption file in yt-dlp's `json3` format. */
export interface Json3Captions {
  events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[];
}

// Sarvam's batch chunks average ~20 s and can run to 2 minutes, which makes a
// cited timestamp nearly useless. Split them into sentences instead.
const SENTENCE = /[^.!?।\n]+(?:[.!?।]+|\n|$)/g;
// Very short "sentences" ("ok.", "जी।") get folded into the next one.
const MIN_SENTENCE_CHARS = 25;
// Long unpunctuated runs get split too (~300 chars is ~20 s of speech).
const MAX_SENTENCE_CHARS = 300;

/** Splits text longer than `max` at the last comma (or else space) before the limit. */
function capLength(text: string, max = MAX_SENTENCE_CHARS): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("، ")) > max / 2
      ? Math.max(window.lastIndexOf(", "), window.lastIndexOf("، ")) + 1
      : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
// How far an estimated sentence start may move to line up with a caption.
const SNAP_WINDOW_S = 2.5;

export function splitSentences(text: string): string[] {
  const raw = (text.match(SENTENCE) ?? [text]).map((s) => s.trim()).filter(Boolean).flatMap((s) => capLength(s));
  const merged: string[] = [];
  let carry = "";
  for (const s of raw) {
    carry = carry ? `${carry} ${s}` : s;
    if (carry.length >= MIN_SENTENCE_CHARS) {
      merged.push(carry);
      carry = "";
    }
  }
  if (carry) merged.length ? (merged[merged.length - 1] += ` ${carry}`) : merged.push(carry);
  return merged;
}

export function captionStartTimes(captions: Json3Captions): number[] {
  return (captions.events ?? [])
    .filter((e) => e.segs?.some((s) => s.utf8?.trim()) && typeof e.tStartMs === "number")
    .map((e) => e.tStartMs! / 1000);
}

function snap(t: number, anchors: number[]): number {
  let best = t;
  let bestDist = SNAP_WINDOW_S;
  for (const a of anchors) {
    const d = Math.abs(a - t);
    if (d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Converts a Sarvam batch STT output into sentence-level segments.
 *
 * Batch STT has no word-level timestamps, so each sentence's start is
 * estimated from its position (by characters) within its chunk. If YouTube
 * captions are available, estimates are snapped to the nearest caption line
 * start, since caption timing is accurate even when caption text isn't.
 */
export function segmentsFromSarvamBatch(output: SarvamBatchOutput, captions?: Json3Captions): Segment[] {
  const ts = output.timestamps;
  if (!ts?.words?.length) return [{ start: 0, text: output.transcript.trim() }];

  const anchors = captions ? captionStartTimes(captions) : [];
  const segments: Segment[] = [];

  ts.words.forEach((chunk, i) => {
    const chunkStart = ts.start_time_seconds[i];
    const chunkEnd = ts.end_time_seconds[i];
    const sentences = splitSentences(chunk);
    const totalChars = sentences.reduce((n, s) => n + s.length, 0) || 1;

    let charsBefore = 0;
    sentences.forEach((text, j) => {
      const estimate = chunkStart + ((chunkEnd - chunkStart) * charsBefore) / totalChars;
      // The chunk's own start is exact; only estimated starts get snapped.
      const start = j === 0 ? chunkStart : snap(estimate, anchors);
      segments.push({ start: Math.round(start * 10) / 10, text });
      charsBefore += text.length;
    });
  });

  // Keep starts increasing after snapping, and fill in ends.
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].start) segments[i].start = segments[i - 1].start;
  }
  segments.forEach((s, i) => {
    s.end = segments[i + 1]?.start ?? ts.end_time_seconds.at(-1);
  });
  return segments;
}

/**
 * Runs one audio file through Sarvam batch STT and returns its output.
 * Takes ~20 s for a 9-minute video.
 */
export async function runSarvamBatch(
  audioPath: string,
  outputDir: string,
  opts: { language: SarvamAI.SpeechToTextLanguage; keyterms: string[] },
): Promise<SarvamBatchOutput> {
  const { sttModel, sttMode, batchTimeoutSeconds } = config.transcription;
  const job = await sarvam.speechToTextJob.createJob({
    model: sttModel,
    mode: sttMode,
    languageCode: opts.language,
    withTimestamps: true,
    // Key terms are only supported by saaras:v4.
    ...(sttModel === "saaras:v4" && opts.keyterms.length ? { keyterms: opts.keyterms } : {}),
  });
  await job.uploadFiles([audioPath], 300);
  await job.start();
  const status = await job.waitUntilComplete(3, batchTimeoutSeconds);
  if (status.job_state !== "Completed") {
    const detail = status.job_details?.find((d) => d.error_message)?.error_message ?? status.error_message;
    throw new Error(`Sarvam STT job ${status.job_state}${detail ? `: ${detail}` : ""}`);
  }
  await job.downloadOutputs(outputDir);
  const out = (await readdir(outputDir)).find((f) => f.endsWith(".json"));
  if (!out) throw new Error("Sarvam STT finished but produced no output file.");
  return JSON.parse(await readFile(join(outputDir, out), "utf8"));
}
