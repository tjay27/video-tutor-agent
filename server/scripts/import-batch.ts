// Turns a Sarvam batch STT output (plus optional YouTube captions) into a
// transcript fixture that the dev server loads on startup.
//
// Usage:
//   npm run import-batch -- <batch-output.json> <videoId> "<title>" [captions.json3] [language]
import { readFile, writeFile } from "node:fs/promises";
import { segmentsFromSarvamBatch } from "../src/transcription/sarvamBatch.js";
import type { Transcript } from "../src/types.js";

const [batchPath, videoId, title, captionsPath, language] = process.argv.slice(2);
if (!batchPath || !videoId || !title) {
  console.error('Usage: npm run import-batch -- <batch-output.json> <videoId> "<title>" [captions.json3] [language]');
  process.exit(1);
}

const output = JSON.parse(await readFile(batchPath, "utf8"));
const captions = captionsPath ? JSON.parse(await readFile(captionsPath, "utf8")) : undefined;

const transcript: Transcript = {
  videoId,
  title,
  language: language ?? output.language_code,
  source: "sarvam-stt",
  segments: segmentsFromSarvamBatch(output, captions),
};

const outPath = new URL(`../fixtures/${videoId}.json`, import.meta.url);
await writeFile(outPath, JSON.stringify(transcript, null, 2) + "\n");

const durations = transcript.segments.map((s) => (s.end ?? s.start) - s.start);
console.log(`wrote fixtures/${videoId}.json`);
console.log(`${transcript.segments.length} segments, avg ${(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)} s, longest ${Math.max(...durations).toFixed(1)} s`);
