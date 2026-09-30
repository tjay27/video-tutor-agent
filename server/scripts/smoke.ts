// Quick check that LLM, TTS and STT all work with your key.
// Usage: npm run smoke
import { readFile, writeFile } from "node:fs/promises";
import { askTutor } from "../src/services/tutor.js";
import { synthesize } from "../src/services/tts.js";
import { transcribeClip } from "../src/services/stt.js";
import type { Transcript } from "../src/types.js";

const transcript: Transcript = JSON.parse(
  await readFile(new URL("../fixtures/sample-transcript.json", import.meta.url), "utf8"),
);

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  console.log(`\n[${label}] ${Date.now() - t0} ms`);
  return result;
}

const inScope = await timed("LLM, in-scope question", () =>
  askTutor({ transcript, question: "Why are leaves green?" }),
);
console.log(inScope.answer, "\ncitations (s):", inScope.citations);

const outOfScope = await timed("LLM, out-of-scope question", () =>
  askTutor({ transcript, question: "Who discovered photosynthesis?" }),
);
console.log(outOfScope.answer);

const hindi = await timed("LLM, Hindi question", () =>
  askTutor({ transcript, question: "पत्तियाँ हरी क्यों होती हैं?" }),
);
console.log(hindi.answer);

const audio = await timed("TTS", () => synthesize(inScope.answer, "en-IN"));
await writeFile("smoke-answer.mp3", audio);
console.log(`wrote smoke-answer.mp3 (${audio.length} bytes)`);

// Round-trip: feed the TTS output back into STT.
const heard = await timed("STT (round-trip of TTS audio)", () =>
  transcribeClip({ audio, filename: "smoke-answer.mp3", contentType: "audio/mpeg" }),
);
console.log(heard);
