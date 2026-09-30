import type { SarvamAI } from "sarvamai";
import { sarvam } from "../services/sarvam.js";
import { config } from "../config.js";

/*
 * Turn analyzer: a small, fast LLM call (~110 prompt tokens, ~250–450 ms)
 * that runs BEFORE the main answer. It replaces two fragile heuristics:
 *  - "semantic VAD": is the student's thought finished, or are they pausing?
 *  - addressee detection: is this speech for the tutor at all?
 * It never sees the transcript, so it stays fast as videos get longer and
 * can be tested on its own.
 */

export type TurnKind =
  | "question" // a complete question/request/reply for the tutor → answer it
  | "incomplete" // meant for the tutor but unfinished → wait for more
  | "stop" // "wait", "stop", "ruko", "ek second" → tutor goes quiet
  | "backchannel" // "hmm", "ok", "haan" → ignore
  | "other" // talking to someone else, TV, song, ads → ignore
  | "noise"; // garbled fragments → ignore

export interface TurnContext {
  /** Earlier unfinished part of the same question, if any. */
  earlier?: string;
  /** The new utterance to classify. */
  text: string;
  tutorSpeaking: boolean;
  /** Last thing the tutor said (to tell a reply like "haan" from a backchannel). */
  tutorLast?: string;
  videoTitle?: string;
}

const SYSTEM = `You are the turn-taking module of a voice tutor on a live call about a video. The microphone hears everything in the room, in any Indian language or English. Classify the student's NEW utterance into exactly one kind:

- "question": anything complete that is said TO the tutor, whether or not it is about the video. Includes questions and follow-ups ("and the second one?"), requests and instructions ("explain again", "Hindi mein batao", "go ahead and look it up"), disagreement or pushback ("no, you tell me why"), comments on the tutor's answer ("that's not what I asked"), thanks and goodbyes ("thank you, bye"), talk about the app or the tutor itself ("I built this app"), and replies to a question the tutor just asked ("haan", "yes please"). The tutor decides how to respond; your job is only to tell whether it was said to the tutor.
- "incomplete": meant for the tutor but the thought is unfinished; the student is pausing mid-sentence ("So the Calvin cycle is", "मुझे ये जानना था कि", "what about the"). Also use this for a short FRAGMENT that relates to the video's topic or to what the tutor just said ("covered in this", "the second one", "queues are"): speech recognition often loses the first words when the student talks over the tutor. Clauses that set up something still to come are incomplete too: a dangling "if…" / "when…" / "since…" without its main part ("tell me this thing, if there is already Kafka", "agar Kafka already hai toh"), or a lead-in with no question yet ("so basically", "tell me this thing", "I wanted to ask").
- "stop": asks the tutor to stop, wait or pause ("wait", "stop", "hold on", "one second", "रुको", "एक सेकंड", "ruko ruko").
- "backchannel": only an acknowledgement while listening, not a request ("hmm", "ok", "haan haan", "achha", "right", "हम्म").
- "other": speech clearly aimed at SOMEONE ELSE, or not speech from the student at all: talking to another person in the room ("मम्मी, आ रही हूँ", "close the door", "I'll call you back"), TV, song lyrics, ads, announcements. Being off-topic or not about the video does NOT make it "other". Speech that uses "you" / "tell me" or responds to what the tutor just said is almost always for the tutor. When unsure, prefer "question" or "incomplete" over "other".
- "noise": garbled or meaningless fragments.

Reply with JSON only: {"kind": "..."}`;

function userMessage(c: TurnContext): string {
  return [
    c.videoTitle && `Video: "${c.videoTitle}"`,
    `Tutor is currently speaking: ${c.tutorSpeaking ? "yes" : "no"}`,
    c.tutorLast && `Tutor's last words: "${c.tutorLast.slice(-200)}"`,
    c.earlier && `Student's earlier unfinished words: "${c.earlier}"`,
    `NEW utterance: "${c.text}"`,
  ]
    .filter(Boolean)
    .join("\n");
}

const KINDS = new Set<TurnKind>(["question", "incomplete", "stop", "backchannel", "other", "noise"]);

/**
 * Classifies an utterance. Returns null on error or timeout, so the caller can
 * fall back to punctuation heuristics instead of blocking the call.
 */
export async function analyzeTurn(c: TurnContext, timeoutMs = 1200): Promise<TurnKind | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await sarvam.chat.completions(
      {
        model: config.llm.model,
        stream: false,
        temperature: 0,
        max_tokens: 20,
        // Same as the main tutor call: reasoning off for speed (see tutor.ts).
        reasoning_effort: null as unknown as SarvamAI.ReasoningEffort,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userMessage(c) },
        ],
      },
      { abortSignal: abort.signal },
    );
    const raw = res.choices[0]?.message?.content ?? "";
    const kind = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)).kind;
    return KINDS.has(kind) ? kind : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Acknowledgements that should never interrupt the tutor mid-answer.
// Checked before the analyzer so they're consistent and free.
const BACKCHANNELS = new Set([
  "hmm", "hm", "mm", "mhm", "uh huh", "ok", "okay", "right", "yes", "yeah", "yep", "sure", "i see", "got it",
  "haan", "han", "ha", "haa", "achha", "acha", "accha", "theek", "theek hai", "thik hai", "ji", "haan ji",
  "हम्म", "हम", "हाँ", "हां", "हाँ हाँ", "हां हां", "अच्छा", "ठीक", "ठीक है", "जी", "हाँ जी", "ओके",
]);

export function isBackchannel(text: string): boolean {
  const t = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (BACKCHANNELS.has(t)) return true;
  // Repeated acknowledgements: "ok ok", "haan haan haan".
  const words = t.split(" ");
  return words.length <= 3 && words.every((w) => BACKCHANNELS.has(w));
}

/**
 * Echo check: when the tutor plays through speakers, the mic can pick it up.
 *
 * Real echo is the tutor's own sentence coming back word for word, in order.
 * A student asking about the topic reuses the tutor's vocabulary ("message
 * queues", "what", "are") but not long runs of its exact wording, so this
 * looks for the longest run of consecutive words that also appears,
 * consecutively, in what the tutor said.
 */
export function isEcho(text: string, tutorText: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const heard = norm(text);
  const tutor = norm(tutorText);
  if (heard.length < 4 || !tutor.length) return false;

  // Longest common run of consecutive words (dynamic programming over words).
  let longest = 0;
  let prev = new Array<number>(tutor.length + 1).fill(0);
  for (let i = 1; i <= heard.length; i++) {
    const row = new Array<number>(tutor.length + 1).fill(0);
    for (let j = 1; j <= tutor.length; j++) {
      if (heard[i - 1] === tutor[j - 1]) {
        row[j] = prev[j - 1] + 1;
        if (row[j] > longest) longest = row[j];
      }
    }
    prev = row;
  }
  return longest >= 4 && longest / heard.length >= 0.7;
}
