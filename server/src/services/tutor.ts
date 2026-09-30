import type { SarvamAI } from "sarvamai";
import { sarvam } from "./sarvam.js";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import type { ChatTurn, Segment, Transcript, TutorAnswer } from "../types.js";
import { detectLanguage, languageNote, type ReplyLanguage } from "./language.js";

// No RAG yet: the whole transcript goes into the system prompt.
// sarvam-105b has a 128K context, which fits several hours of speech.

export function formatTimestamp(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function formatTranscript(segments: Segment[]): string {
  return segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text.trim()}`).join("\n");
}

// Speech-to-text has already filtered out chatter and decided the turn is
// complete (see call/turnAnalyzer.ts), so the voice rules only cover what's left.
const VOICE_RULES = `
VOICE CALL
- This is a live voice call; the question was transcribed from speech and may contain recognition errors. If you can't tell what was asked, ask one short clarifying question instead of guessing.
- Never repeat or re-answer an earlier question unless the student clearly asks for it again.`;

function buildSystemPrompt(transcript: Transcript, voice: boolean): string {
  const title = transcript.title ? ` titled "${transcript.title}"` : "";
  return `You are a friendly tutor helping a student understand a YouTube video${title}.

RULES
1. Use ONLY what the video says (the transcript below). Do not add facts, definitions, examples, analogies or explanations the video doesn't give, even well-known ones. If the video uses a term without explaining it, say the video doesn't explain it rather than explaining it yourself.
2. If the video does not cover the question, say so plainly (for example: "That isn't covered in this video.") and, if something related is covered, point to it with its timestamp.
3. Every factual sentence needs a citation: the timestamp of the transcript line it comes from, in square brackets at the end of that sentence, e.g. "...reflects green light [0:21]." Use only timestamps that appear in the transcript, and the one closest to where it is said. Never write "at 0:21".
4. Keep answers short and spoken-friendly: 2-4 sentences, plain text, no markdown, no bullet lists. The answer is read aloud, like a phone call.
5. Say "the video" (वीडियो), never "the transcript" (ट्रांसक्रिप्ट), in every language. The student doesn't see a transcript.
6. Reply in the language named in the "[Reply language: …]" note at the end of the student's message. It overrides the language of earlier messages. Without a note, reply in the language and style the student used.
${voice ? VOICE_RULES : ""}

TRANSCRIPT
${formatTranscript(transcript.segments)}`;
}

interface TutorQuestion {
  transcript: Transcript;
  question: string;
  history?: ChatTurn[];
  /** Call mode: adds rules for spoken, possibly mis-transcribed questions. */
  voice?: boolean;
  /** BCP-47 language detected by STT for this question, e.g. "hi-IN". */
  language?: string;
  /** Language to answer in, if already decided (e.g. the student asked for one). */
  replyLanguage?: ReplyLanguage | null;
}

export function buildRequest({ transcript, question, history = [], voice = false, language, replyLanguage }: TutorQuestion): SarvamAI.ChatCompletionsRequest {
  // Models keep the language of the earlier conversation even after the
  // student switches, so the reply language is stated on every message.
  const reply = replyLanguage ?? detectLanguage(question, language);
  const hint = reply ? languageNote(reply) : "";
  return {
    model: config.llm.model,
    messages: [
      { role: "system", content: buildSystemPrompt(transcript, voice) },
      ...history.slice(-config.llm.historyTurns * 2),
      { role: "user", content: question + hint },
    ],
    temperature: 0.2,
    // The API disables reasoning when reasoning_effort is explicitly null;
    // the SDK types don't allow null, hence the cast.
    reasoning_effort: (config.llm.reasoningEffort === "off" ? null : config.llm.reasoningEffort) as SarvamAI.ReasoningEffort,
    max_tokens: config.llm.maxTokens,
  };
}

/** Streams the answer as text deltas. Abort via `signal` (used for barge-in). */
export async function* streamTutor(args: TutorQuestion, signal?: AbortSignal): AsyncGenerator<string> {
  const stream = await sarvam.chat.completions({ ...buildRequest(args), stream: true }, { abortSignal: signal });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

export async function askTutor(args: TutorQuestion): Promise<TutorAnswer & { usage?: SarvamAI.CompletionUsage }> {
  const res = await sarvam.chat.completions({ ...buildRequest(args), stream: false });

  const answer = res.choices[0]?.message?.content?.trim();
  if (!answer) {
    // Reasoning models can spend the whole token budget thinking.
    throw new HttpError(502, `LLM returned an empty answer (finish_reason: ${res.choices[0]?.finish_reason})`);
  }

  const cleaned = cleanCitations(answer, args.transcript.segments);
  return { answer: cleaned.text, citations: cleaned.citations, usage: res.usage };
}

const CITATION = /\s*\[(\d{1,2}(?::\d{2}){1,2})\]/g;
const MULTI_CITATION = /\[((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[,;&]\s*(?:\d{1,2}:)?\d{1,2}:\d{2})+)\]/g;
/** "[23:52, 24:41]" → "[23:52] [24:41]" (the model sometimes groups them). */
const TS_LIST = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[,;&]\s*(?:\d{1,2}:)?\d{1,2}:\d{2})*`;
// "(23:46)" or "(23:46, 24:39)" → brackets.
const PAREN_CITATION = new RegExp(String.raw`\((${TS_LIST})\)`, "g");
// A trailing bare list, alone after the last sentence: "...patterns. 23:46, 24:39, 25:12"
const TRAILING_BARE = new RegExp(String.raw`(^|[.!?।]\s*)(${TS_LIST})\s*\.?\s*$`);

/**
 * Normalises how the model wrote its citations, so they can be checked,
 * shown as chips and kept out of the spoken audio:
 * "[23:52, 24:41]" / "(23:52)" / a bare trailing "23:46, 24:39" → "[23:52] [24:41]".
 */
export function splitCitations(text: string): string {
  const bracketed = text
    .replace(PAREN_CITATION, "[$1]")
    .replace(TRAILING_BARE, (_m, lead: string, list: string) => `${lead}[${list}]`);
  return bracketed.replace(MULTI_CITATION, (_m, inner: string) => inner.split(/\s*[,;&]\s*/).map((t) => `[${t}]`).join(" "));
}
const toSeconds = (ts: string) => ts.split(":").map(Number).reduce((acc, p) => acc * 60 + p, 0);

/** Turns [m:ss] / [h:mm:ss] citations in the answer into seconds. */
export function extractCitations(text: string): number[] {
  return [...new Set([...splitCitations(text).matchAll(CITATION)].map((m) => toSeconds(m[1])))];
}

// A cited time this far from any transcript line is treated as made up.
const MAX_CITATION_DRIFT_S = 15;

/**
 * Grounding check on citations: snaps each [m:ss] to the start of the nearest
 * transcript line, drops ones that don't match any line, and removes
 * duplicates within a sentence. Returns the cleaned text and cited seconds.
 */
export function cleanCitations(text: string, segments: Segment[]): { text: string; citations: number[] } {
  const starts = segments.map((s) => s.start);
  const cited = new Set<number>();
  let lastInSentence: number | null = null;
  const cleaned = splitCitations(text).replace(/\s*\[(\d{1,2}(?::\d{2}){1,2})\]|[.!?।]/g, (match, ts?: string) => {
    if (!ts) {
      lastInSentence = null; // sentence boundary
      return match;
    }
    const t = toSeconds(ts);
    let best: number | null = null;
    for (const s of starts) if (best === null || Math.abs(s - t) < Math.abs(best - t)) best = s;
    if (best === null || Math.abs(best - t) > MAX_CITATION_DRIFT_S || best === lastInSentence) return "";
    lastInSentence = best;
    cited.add(best);
    return ` [${formatTimestamp(best)}]`;
  });
  return { text: cleaned.replace(/\s+([.!?।,])/g, "$1").trim(), citations: [...cited] };
}
