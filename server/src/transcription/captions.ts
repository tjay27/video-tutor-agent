import type { Segment } from "../types.js";
import type { Json3Captions } from "./sarvamBatch.js";

interface CaptionLine {
  start: number;
  end: number;
  text: string;
}

function captionLines(captions: Json3Captions): CaptionLine[] {
  const lines: CaptionLine[] = [];
  for (const e of captions.events ?? []) {
    const text = (e.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text || typeof e.tStartMs !== "number") continue;
    const start = e.tStartMs / 1000;
    lines.push({ start, end: start + (e.dDurationMs ?? 0) / 1000, text });
  }
  return lines;
}

// Caption lines are 2–5 s fragments that break mid-sentence. Join them into
// sentence-sized segments, capped so a run-on without punctuation still splits.
const MAX_SEGMENT_S = 20;
const MIN_SEGMENT_CHARS = 25;

/** Turns YouTube captions into sentence-level segments. */
export function segmentsFromCaptions(captions: Json3Captions): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  for (const line of captionLines(captions)) {
    if (!current) current = { start: line.start, text: "" };
    current.text = current.text ? `${current.text} ${line.text}` : line.text;
    current.end = line.end;
    const endsSentence = /[.!?।]$/.test(current.text) && current.text.length >= MIN_SEGMENT_CHARS;
    if (endsSentence || line.end - current.start >= MAX_SEGMENT_S) {
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);
  return segments;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/**
 * Completeness check. saaras:v3 once silently dropped 2 minutes of a video;
 * compare STT against captions minute by minute, and where STT has far fewer
 * words, use the captions for that stretch instead.
 */
export function fillThinStretches(
  stt: Segment[],
  captions: Json3Captions,
  windowS = 60,
): { segments: Segment[]; filled: { from: number; to: number }[] } {
  const fromCaptions = segmentsFromCaptions(captions);
  const end = Math.max(stt.at(-1)?.end ?? 0, fromCaptions.at(-1)?.end ?? 0);
  const filled: { from: number; to: number }[] = [];

  for (let from = 0; from < end; from += windowS) {
    const to = from + windowS;
    const inWindow = (s: Segment) => s.start >= from && s.start < to;
    const sttWords = stt.filter(inWindow).reduce((n, s) => n + words(s.text), 0);
    const captionWords = fromCaptions.filter(inWindow).reduce((n, s) => n + words(s.text), 0);
    if (captionWords >= 40 && sttWords < 0.4 * captionWords) filled.push({ from, to });
  }
  if (!filled.length) return { segments: stt, filled };

  const isFilled = (s: Segment) => filled.some((w) => s.start >= w.from && s.start < w.to);
  const segments = [...stt.filter((s) => !isFilled(s)), ...fromCaptions.filter(isFilled)].sort((a, b) => a.start - b.start);
  return { segments, filled };
}

export function describeFilled(filled: { from: number; to: number }[]): string {
  const ranges = filled.map((w) => `${mmss(w.from)}–${mmss(w.to)}`).join(", ");
  return `Speech-to-text looked incomplete at ${ranges}; YouTube captions were used there instead.`;
}

