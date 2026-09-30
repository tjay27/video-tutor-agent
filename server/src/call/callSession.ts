import type { WebSocket } from "ws";
import type { SarvamAI } from "sarvamai";
import { sarvam } from "../services/sarvam.js";
import { config } from "../config.js";
import { getTranscript } from "../services/transcriptStore.js";
import { streamTutor, cleanCitations } from "../services/tutor.js";
import { toSpeakableText, toTtsLanguage } from "../services/tts.js";
import { TtsPool, TtsStream } from "./ttsStream.js";
import { createCallLog } from "./callLog.js";
import { analyzeTurn, isBackchannel, isEcho, type TurnKind } from "./turnAnalyzer.js";
import type { ChatTurn, Transcript } from "../types.js";
import { userMessage } from "../userErrors.js";
import { detectLanguage, requestedLanguage, ttsLanguageFor, type ReplyLanguage } from "../services/language.js";

type SttSocket = Awaited<ReturnType<typeof sarvam.speechToTextRealtimeStreaming.connect>>;

/*
 * Phone-call mode, one instance per browser WebSocket.
 *
 *   mic (16 kHz PCM) ─► Sarvam realtime STT ─► turn analyzer ─► sarvam-105b (streaming)
 *                        (VAD: speech ended)   (for the tutor?    │ sentences
 *                                               finished?)        ▼
 *   speaker (24 kHz PCM) ◄──────────────────────────────── Sarvam streaming TTS
 *
 * Turn-taking
 *  - Sarvam's VAD reports end of speech after a short silence. The turn
 *    analyzer (a small, fast LLM call) then labels the utterance: a complete
 *    question → answer now; unfinished → wait up to ~2 s for more; "stop" →
 *    go quiet; backchannel / talking to someone else / noise → ignore.
 *  - Only speech meant for the tutor is merged into the question, so song
 *    lyrics or a chat with someone else never get mixed in.
 *
 * Barge-in (user talks while the tutor is speaking)
 *  1. The tutor keeps talking normally while the first few words come in.
 *  2. After 3 words the analyzer decides early: for the tutor or "stop" →
 *     INTERRUPT (the browser stops the audio cleanly); anything else → the
 *     tutor just carries on.
 *  3. The answer to the new question opens with a short filler ("Sure.",
 *     "हाँ, बिल्कुल।"); "stop" gets a short "Okay." and silence.
 *  4. Backchannels ("hmm", "haan") and echo of the tutor's own voice never
 *     interrupt.
 *  After an interrupt the browser reports how much it played, and only the
 *  sentences the user actually heard stay in the history.
 *
 * Messages to the browser (JSON): ready, partial, interrupt,
 * audio_start, cue {at, offset} (move the video to `at` when this turn's audio
 * reaches `offset` s), user, assistant_delta, assistant_done, ignored, stopped,
 * noisy, error. Tutor audio is sent as binary frames after audio_start.
 * From the browser: start, mode {ptt}, playback {playing}, heard {turn, seconds},
 * hangup, and mic audio as binary frames.
 */

interface Turn {
  id: number;
  question: string;
  abort: AbortController;
  tts?: TtsStream;
  text: string;
  /** Sentences passed to TTS, in order (to work out what was heard). */
  spoken: string[];
  cancelled: boolean;
  audioStarted: boolean;
  /** Cancelled because the user was still mid-question; words go to the next turn. */
  merged: boolean;
  /** The answer's entry in the history, once added. */
  answerMsg?: ChatTurn;
  /** How many of `spoken` are fillers ("Sure."), not part of the answer. */
  fillers?: number;
  /** Video timestamp (s) each spoken sentence cites, by index into `spoken`. */
  cues?: Map<number, number>;
  /** When the first audio of the answer was sent (ms epoch). */
  firstAudioAt?: number;
}

interface Utterance {
  /** Early decision made from partial text while the tutor was speaking. */
  early?: TurnKind | "echo";
  analyzing: boolean;
}

type IgnoreReason = "other" | "noise" | "backchannel" | "echo";

// Words that suggest the speaker paused mid-thought. Only used as a fallback
// when the turn analyzer fails.
const TRAILING_WORDS = new Set([
  "and", "or", "but", "so", "because", "like", "um", "uh", "hmm", "the", "a", "an", "to", "of", "in",
  "with", "then", "also", "what", "which", "if", "is", "about",
  "aur", "ki", "toh", "matlab", "jaise", "ya", "और", "कि", "तो", "मतलब", "जैसे", "या",
]);

/** Fallback wait by punctuation, if the turn analyzer is unavailable. */
function fallbackHold(text: string): number {
  const t = text.trim();
  const lastWord = t.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, "").split(/\s+/).pop() ?? "";
  if (TRAILING_WORDS.has(lastWord)) return config.call.holdIncompleteMs;
  if (t.endsWith("?")) return config.call.holdQuestionMs;
  if (/[.!।]$/.test(t)) return config.call.holdSentenceMs;
  return config.call.holdIncompleteMs;
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const COMMON = new Set([
  "the", "a", "an", "and", "or", "but", "so", "if", "then", "this", "that", "these", "those", "it", "its", "is", "are",
  "was", "were", "be", "to", "of", "in", "on", "for", "with", "as", "at", "by", "from", "we", "you", "i", "they", "he",
  "she", "my", "our", "your", "their", "what", "when", "where", "why", "how", "which", "who", "now", "here", "there",
  "okay", "ok", "yes", "no", "not", "just", "also", "like", "let", "lets", "let's", "dear", "students", "welcome",
]);

/**
 * Names and technical terms from the transcript (e.g. "Kafka", "RabbitMQ",
 * "SQS", "Agentic AI"): capitalised, ALL-CAPS or CamelCase Latin words that
 * recur, plus runs of them ("Amazon SQS"). Used as an STT hint.
 */
export function transcriptTerms(transcript: Transcript, max = 25): string[] {
  const counts = new Map<string, number>();
  const add = (t: string) => counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const seg of transcript.segments) {
    const words = seg.text.match(/[A-Za-z][A-Za-z0-9+#.\-]*[A-Za-z0-9+#]|[A-Za-z]/g) ?? [];
    let run: string[] = [];
    const flush = () => {
      if (run.length > 1) add(run.join(" "));
      run = [];
    };
    words.forEach((w, i) => {
      const special = /[A-Z].*[A-Z]/.test(w) || /[a-z][A-Z]/.test(w); // SQS, RabbitMQ, ChatGPT
      const capitalised = /^[A-Z]/.test(w) && i > 0; // not just the first word of a line
      if ((special || capitalised) && !COMMON.has(w.toLowerCase()) && w.length > 1) {
        add(w);
        run.push(w);
      } else flush();
    });
    flush();
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

/** Realtime STT context hint: title, channel/tags, and the transcript's own terms. */
function sttPrompt(t: Transcript): string {
  const seen = new Set<string>();
  const terms = [t.title, ...(t.keyterms ?? []).slice(0, 10), ...transcriptTerms(t)].filter((x): x is string => {
    if (!x || seen.has(x.toLowerCase())) return false;
    seen.add(x.toLowerCase());
    return true;
  });
  return terms.join(", ").slice(0, 500);
}

// Short, natural openers after the student cuts the tutor off. The TTS voice
// ("shubh") is male, hence "बताता हूँ".
const FILLERS = {
  en: ["Sure.", "Oh, sure.", "Okay, sure.", "Good question.", "Right, so."],
  hi: ["हाँ, बिल्कुल।", "अच्छा, ठीक है।", "हाँ, बताता हूँ।", "हम्म, अच्छा सवाल है।"],
};
const STOP_ACKS = { en: ["Okay.", "Sure."], hi: ["ठीक है।", "हाँ, ठीक है।"] };
let lastFiller = "";

/** Picks a filler in Hindi or English (by language code or the question's script), never the same twice in a row. */
function pickFiller(set: { en: string[]; hi: string[] }, languageOrText?: string): string {
  const hindi = !!languageOrText && (languageOrText.startsWith("hi") || /[\u0900-\u097F]/.test(languageOrText));
  const options = (hindi ? set.hi : set.en).filter((f) => f !== lastFiller);
  lastFiller = options[Math.floor(Math.random() * options.length)];
  return lastFiller;
}

export class CallSession {
  private transcript: Transcript | null = null;
  private stt: SttSocket | null = null;
  private tts = new TtsPool();
  private history: ChatTurn[] = [];
  /** The answer being generated (its audio goes to the browser). */
  private active: Turn | null = null;
  /** Recent turns by id, to apply "heard" reports that arrive after they end. */
  private turns = new Map<number, Turn>();
  private turnCount = 0;
  /** Whether the browser is currently playing tutor audio. */
  private browserPlaying = false;
  private playbackEndedAt = 0;
  /** What the tutor said most recently (echo check and analyzer context). */
  private tutorLast = "";
  private tutorLastAt = 0;
  private utterances = new Map<number, Utterance>();
  private speechEndedAt = 0;
  // Finished utterances meant for the tutor, waiting to become one question.
  private pending: string[] = [];
  private pendingLanguage: string | undefined;
  private pendingSince = 0;
  /** The pending words were last judged unfinished (vs. a complete question). */
  private pendingIncomplete = false;
  private commitTimer: NodeJS.Timeout | null = null;
  /** Language the student explicitly asked for ("talk in English"), for the rest of the session. */
  private preferredLanguage: ReplyLanguage | null = null;
  /** The student cut the tutor off; the next answer opens with a filler. */
  private cutOffTutor = false;
  /** Hold-to-talk mode: everything heard is for the tutor, answer on release. */
  private ptt = false;
  private ignoredAt: number[] = [];
  private noisySentAt = 0;
  private log = createCallLog();

  private limitTimers: NodeJS.Timeout[] = [];
  private lastActivityAt = Date.now();

  constructor(private ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) this.onMicAudio(data as Buffer);
      else this.onControl(data.toString());
    });
    ws.on("close", () => this.close());
    this.startLimits();
  }

  /**
   * Hosted demo limits: a maximum session length, and ending the session
   * after a stretch of silence (realtime STT bills for as long as the mic
   * stream is open, even when nobody is talking).
   */
  private startLimits() {
    const { maxSessionSeconds, idleSeconds } = config.limits;
    if (maxSessionSeconds) {
      this.limitTimers.push(
        setTimeout(() => this.endForLimit(`Demo sessions are limited to ${Math.round(maxSessionSeconds / 60)} minutes. Start a new one any time.`), maxSessionSeconds * 1000),
      );
    }
    if (idleSeconds) {
      this.limitTimers.push(
        setInterval(() => {
          const busy = this.active || this.browserPlaying || this.pending.length;
          if (!busy && Date.now() - this.lastActivityAt > idleSeconds * 1000) {
            this.endForLimit("Session ended after a quiet stretch. Tap “Ask a question” to start again.");
          }
        }, 5000),
      );
    }
  }

  private endForLimit(message: string) {
    this.record("limit", { message });
    this.send({ type: "limit", message });
    this.ws.close(1000, "limit");
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private record(type: string, data?: Record<string, unknown>) {
    this.log.record(type, data);
  }

  /**
   * Echo can only happen while the tutor's audio is actually playing (plus a
   * short tail for room reverb and STT delay), not seconds after it stopped.
   */
  private echoPossible(): boolean {
    return this.browserPlaying || Date.now() - this.playbackEndedAt < 800;
  }

  /** The tutor's voice is (or is about to be) coming out of the speaker. */
  private tutorSpeaking(): boolean {
    return this.browserPlaying || !!this.active?.audioStarted;
  }

  // ---------------------------------------------------------------- control

  private onControl(raw: string) {
    let msg: { type?: string; videoId?: string; ptt?: boolean; playing?: boolean; turn?: number; seconds?: number };
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send({ type: "error", message: "Invalid JSON" });
    }
    switch (msg.type) {
      case "start":
        this.start(msg.videoId).catch((e) => this.fail(e));
        break;
      case "mode":
        this.ptt = !!msg.ptt;
        this.record("mode", { ptt: this.ptt });
        break;
      case "playback":
        if (this.browserPlaying && !msg.playing) this.playbackEndedAt = Date.now();
        this.browserPlaying = !!msg.playing;
        break;
      case "heard":
        if (typeof msg.turn === "number" && typeof msg.seconds === "number") this.onHeard(msg.turn, msg.seconds);
        break;
      case "client_event": {
        // Browser-side events (talk-over pause/resume, mic levels) for the call log.
        const { type: _t, ...data } = msg as Record<string, unknown>;
        this.record("client", data);
        // The tutor paused for a sound but no words came: music or other
        // background noise that speech-to-text doesn't transcribe. It counts
        // towards the "noisy room, try hold-to-talk" suggestion.
        if (data.name === "talkover_resume" && data.reason === "timeout") this.noteIgnored();
        break;
      }
      case "hangup":
        this.ws.close();
        break;
    }
  }

  private async start(videoId?: string) {
    if (this.stt) return;
    this.log.log.videoId = videoId;
    this.record("call_start", { videoId });
    this.transcript = videoId ? getTranscript(videoId) : null;
    if (!this.transcript) return this.fail(new Error(`No transcript loaded for video ${videoId}`));

    this.tts.warm();
    const stt = await sarvam.speechToTextRealtimeStreaming.connect({
      "Api-Subscription-Key": config.sarvamApiKey,
      model: config.call.sttModel,
      language_code: "auto",
      encoding: "linear16",
      sample_rate: String(config.call.inputSampleRate),
      endpointing: "vad",
      stream_type: "fast",
      silence_duration_ms: String(config.call.silenceMs),
      prefix_padding_ms: String(config.call.prefixPaddingMs),
      // Context hint: helps STT recognise topic words and names ("Kafka",
      // "RabbitMQ", "Agentic AI") that it would otherwise mishear.
      prompt: sttPrompt(this.transcript),
      reconnectAttempts: 0,
    });
    stt.on("message", (m) => this.onSttEvent(m));
    stt.on("error", (e) => console.error("[call] STT socket error", e));
    stt.on("close", (e) => {
      if (this.ws.readyState === this.ws.OPEN) this.fail(new Error(`Speech recognition disconnected (${e.code})`));
    });
    await stt.waitForOpen();
    this.stt = stt;
    this.send({ type: "ready" });
    this.greet().catch((e) => this.fail(e));
  }

  /** Opens the session with a short spoken greeting, like picking up a call. */
  private async greet() {
    const hindi = this.transcript?.language?.startsWith("hi");
    const text = hindi
      ? "नमस्ते! मैं इस video के लिए आपका tutor हूँ। आप क्या जानना चाहेंगे?"
      : "Hi! I'm your tutor for this video. What would you like to know?";
    this.record("greeting", { text });
    await this.speakScripted(text, hindi ? "hi-IN" : "en-IN", { show: true });
  }

  /**
   * Speaks fixed text (no LLM call): the greeting, or "Okay." after "ruko".
   * It's a normal turn, so the student can talk over it. `show` also puts it
   * in the chat and the history.
   */
  private async speakScripted(text: string, language: string | undefined, { show }: { show: boolean }) {
    if (this.active) this.cancelTurn(this.active, { merge: false });
    const turn: Turn = {
      id: ++this.turnCount,
      question: "",
      abort: new AbortController(),
      text,
      spoken: [],
      cancelled: false,
      audioStarted: false,
      merged: false,
    };
    this.active = turn;
    this.turns.set(turn.id, turn);
    if (show) this.send({ type: "assistant_delta", turn: turn.id, text });

    try {
      const socket = await this.tts.take();
      if (turn.cancelled) return socket.close();
      turn.tts = TtsStream.start(
        socket,
        toTtsLanguage(language),
        (pcm) => {
          if (turn.cancelled || this.active !== turn) return;
          if (!turn.audioStarted) {
            turn.audioStarted = true;
            this.send({ type: "audio_start", turn: turn.id });
          }
          this.ws.send(pcm, { binary: true });
        },
        (message) => this.record("tts_error", { turn: turn.id, message }),
      );
      turn.spoken.push(text);
      turn.tts.speak(text);
      this.tutorLast = text;
      this.tutorLastAt = Date.now();
      await turn.tts.end();
    } finally {
      if (this.active === turn) this.active = null;
      turn.tts?.cancel();
      if (show) {
        // So the tutor knows what it already said (e.g. doesn't greet twice).
        turn.answerMsg = { role: "assistant", content: text };
        this.history.push(turn.answerMsg);
        this.send({ type: "assistant_done", turn: turn.id, text, citations: [], retracted: false, interrupted: turn.cancelled, timings: {} });
      }
    }
  }

  private onMicAudio(pcm: Buffer) {
    if (this.stt?.readyState !== 1) return;
    this.stt.sendRealtimeAudioInput({ event: "audio_input", audio: pcm.toString("base64") });
  }

  // ------------------------------------------------------------ STT events

  private onSttEvent(m: { event: string }) {
    switch (m.event) {
      case "transcript.partial": {
        const { text, utterance_idx } = m as SarvamAI.RealtimeTranscriptPartial;
        if (text.trim()) this.onPartial(utterance_idx, text.trim());
        return;
      }
      case "vad.speech_start":
        this.cancelCommit();
        return;
      case "vad.speech_end":
        this.speechEndedAt = Date.now();
        return;
      case "transcript.final": {
        const { text, language, utterance_idx } = m as SarvamAI.RealtimeTranscriptFinal;
        this.record("stt_final", { utterance: utterance_idx, text, language });
        if (text.trim()) this.lastActivityAt = Date.now();
        // Sarvam's auto language detection is "sticky": after a few Telugu
        // utterances it writes English in Telugu script. Re-arm detection so
        // every utterance is detected fresh (applies from the next utterance).
        try {
          this.stt?.sendRealtimeConfigUpdate({ event: "config.update", language_code: "auto" });
        } catch {}
        this.onFinal(utterance_idx, text.trim(), language).catch((e) => this.fail(e));
        return;
      }
      case "error": {
        const err = m as SarvamAI.RealtimeError;
        console.error("[call] STT error", err);
        this.record("stt_error", { ...err });
        if (err.is_fatal) this.fail(new Error(`${err.code}: ${err.message}`));
        return;
      }
    }
  }

  private onPartial(idx: number, text: string) {
    // Still talking: don't answer yet.
    this.cancelCommit();
    let u = this.utterances.get(idx);
    if (!u) {
      u = { analyzing: false };
      this.utterances.set(idx, u);
      this.onUtteranceStart(u, idx, text);
    }
    this.send({ type: "partial", text });
    if (this.tutorSpeaking() && !this.ptt) this.decideEarly(u, idx, text);
  }

  private onUtteranceStart(u: Utterance, idx: number, text: string) {
    // The student started talking again before, or just after, the tutor began
    // answering: they're still finishing their question ("…if there is already
    // Kafka" … "then why do I need another one?"). Drop that answer and fold
    // its words into what comes next. No "Sure." filler: it's the same question.
    const a = this.active;
    if (a && !a.cancelled && a.question) {
      const justStarted = !a.audioStarted || Date.now() - (a.firstAudioAt ?? 0) < config.call.continuationMs;
      if (justStarted && !isEcho(text, a.text)) {
        const wasPlaying = a.audioStarted;
        this.cancelTurn(a, { merge: true });
        if (wasPlaying) this.send({ type: "interrupt" });
        this.cutOffTutor = false;
      }
    }
    // The tutor keeps talking at normal volume until the first few words show
    // whether this is for it (see decideEarly).
    this.record("user_speaking", { utterance: idx, tutorSpeaking: this.tutorSpeaking() });
  }

  /**
   * While the tutor is speaking, decide from the first few words whether to
   * interrupt, instead of waiting for the end of the utterance (a song can go
   * on for 20 s).
   */
  private decideEarly(u: Utterance, idx: number, text: string) {
    if (u.early || u.analyzing || wordCount(text) < config.call.earlyDecisionWords) return;
    if (this.echoPossible() && isEcho(text, this.tutorLast)) {
      u.early = "echo";
      this.send({ type: "carry_on" });
      return;
    }
    if (isBackchannel(text)) return; // wait: "ok ok so why..." may still become a question
    u.analyzing = true;
    analyzeTurn({ text, tutorSpeaking: true, tutorLast: this.tutorLast, videoTitle: this.transcript?.title }).then((kind) => {
      u.analyzing = false;
      if (!kind || u.early) return;
      u.early = kind;
      this.record("early_decision", { utterance: idx, text, kind });
      // A clear question or "stop": drop the answer now. "incomplete" after only
      // a few words is too uncertain (it could be the start of a chat with
      // someone else), so the tutor stays paused (the browser keeps it paused
      // while words arrive) and the full utterance decides. Anything else: the
      // browser resumes the tutor from where it paused.
      if (kind === "question" || kind === "stop") this.interrupt();
      else if (kind !== "incomplete") this.send({ type: "carry_on" });
    });
  }

  private async onFinal(idx: number, text: string, language?: string) {
    const u = this.utterances.get(idx) ?? { analyzing: false };
    this.utterances.delete(idx);

    if (!text) {
      if (this.pending.length) this.scheduleCommit(fallbackHold(this.pending.join(" ")));
      return;
    }

    // Hold-to-talk: everything is for the tutor, and releasing ends the turn.
    if (this.ptt) {
      this.addPending(text, language);
      return this.scheduleCommit(config.call.holdCompleteMs);
    }

    if (u.early === "echo" || (this.echoPossible() && isEcho(text, this.tutorLast))) return this.ignore(u, text, "echo");
    const tutorAsked = this.tutorLast.trim().endsWith("?");
    if (isBackchannel(text) && !tutorAsked) return this.ignore(u, text, "backchannel");

    const kind = await analyzeTurn({
      text,
      earlier: this.pending.join(" ") || undefined,
      tutorSpeaking: this.tutorSpeaking(),
      tutorLast: this.tutorLast,
      videoTitle: this.transcript?.title,
    });
    this.record("turn_kind", { utterance: idx, text, kind: kind ?? "fallback" });

    switch (kind) {
      case "question":
      case "incomplete":
        if (this.tutorSpeaking()) this.interrupt();
        this.addPending(text, language);
        this.pendingIncomplete = kind === "incomplete";
        this.scheduleCommit(kind === "question" ? config.call.holdCompleteMs : config.call.holdIncompleteMs);
        return;
      case "stop":
        this.interrupt();
        this.send({ type: "stopped", text });
        this.record("stopped", { text });
        // A short spoken "Okay." so the student knows it heard them.
        this.speakScripted(pickFiller(STOP_ACKS, language ?? this.transcript?.language), language, { show: false }).catch((e) => this.fail(e));
        return;
      case "backchannel":
      case "other":
      case "noise":
        return this.ignore(u, text, kind);
      default:
        // Analyzer unavailable: treat as a question, wait by punctuation.
        if (this.tutorSpeaking()) this.interrupt();
        this.addPending(text, language);
        this.pendingIncomplete = false;
        this.scheduleCommit(fallbackHold(this.pending.join(" ")));
    }
  }

  /**
   * An unfinished question left hanging while other talk went on. Its age is
   * measured from its latest part, so a slow but continuous question is fine.
   */
  private pendingIsStale(): boolean {
    return this.pending.length > 0 && Date.now() - this.pendingSince > config.call.pendingMaxAgeMs;
  }

  private addPending(text: string, language?: string) {
    // An unfinished question left hanging while other talk went on is stale:
    // don't glue it onto an unrelated question a minute later.
    if (this.pendingIsStale()) {
      this.record("pending_expired", { text: this.pending.join(" ") });
      this.pending = [];
    }
    this.pendingSince = Date.now();
    this.pending.push(text);
    // The latest words decide the language (the user may switch mid-call).
    this.pendingLanguage = language ?? this.pendingLanguage;
  }

  private ignore(_u: Utterance, text: string, reason: IgnoreReason) {
    this.send({ type: "ignored", text, reason });
    this.record("ignored", { text, reason });
    // Keep waiting for an unfinished question the user had started.
    if (this.pending.length && !this.commitTimer) this.scheduleCommit(config.call.holdIncompleteMs);
    if (reason === "other" || reason === "noise") this.noteIgnored();
  }

  /** Lots of background speech: suggest hold-to-talk (at most once a minute). */
  private noteIgnored() {
    const now = Date.now();
    this.ignoredAt = [...this.ignoredAt.filter((t) => now - t < 30_000), now];
    if (this.ignoredAt.length >= config.call.noisyThreshold && now - this.noisySentAt > 60_000) {
      this.noisySentAt = now;
      this.send({ type: "noisy" });
      this.record("noisy");
    }
  }

  /** Real barge-in: stop the tutor and drop its queued audio. */
  private interrupt() {
    // Remember it, so the answer to this question opens with a filler.
    if (this.tutorSpeaking()) this.cutOffTutor = true;
    if (this.active) this.cancelTurn(this.active, { merge: false });
    // Sent even with no active turn: TTS runs faster than real time, so audio
    // may still be queued in the browser after generation finished.
    this.send({ type: "interrupt" });
  }

  // ---------------------------------------------------------------- turns

  private scheduleCommit(delayMs: number) {
    this.cancelCommit();
    this.record("hold", { text: this.pending.join(" "), holdMs: delayMs });
    this.commitTimer = setTimeout(() => this.commit(), delayMs);
  }

  private cancelCommit() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
  }

  /** The user has finished: turn everything they said to the tutor into one question. */
  private commit() {
    this.commitTimer = null;
    if (this.pendingIsStale()) {
      // e.g. "So the..." then a long side conversation, then silence.
      this.record("pending_expired", { text: this.pending.join(" ") });
      this.pending = [];
      return;
    }
    const question = this.pending.join(" ");
    // A 1–2 word fragment that never got finished ("I", "so the"): nothing to
    // answer. Drop it quietly instead of guessing.
    if (this.pendingIncomplete && wordCount(question) <= 2) {
      this.record("fragment_dropped", { text: question });
      this.pending = [];
      this.pendingIncomplete = false;
      return;
    }
    this.pendingIncomplete = false;
    const language = this.pendingLanguage;
    const filler = this.cutOffTutor;
    this.pending = [];
    this.pendingLanguage = undefined;
    this.cutOffTutor = false;
    if (question) this.runTurn(question, language, { filler }).catch((e) => this.fail(e));
  }

  private cancelTurn(turn: Turn, { merge }: { merge: boolean }) {
    if (turn.cancelled) return;
    turn.cancelled = true;
    turn.abort.abort();
    turn.tts?.cancel();
    if (merge) {
      turn.merged = true;
      this.pending.unshift(turn.question);
      this.record("merge", { turn: turn.id, question: turn.question });
    }
    if (this.active === turn) this.active = null;
  }

  private async runTurn(question: string, language?: string, opts: { filler?: boolean } = {}) {
    if (this.active) this.cancelTurn(this.active, { merge: false });
    if (this.browserPlaying) this.send({ type: "interrupt" });

    const turn: Turn = {
      id: ++this.turnCount,
      question,
      abort: new AbortController(),
      text: "",
      spoken: [],
      cancelled: false,
      audioStarted: false,
      merged: false,
    };
    this.active = turn;
    this.turns.set(turn.id, turn);
    if (this.turns.size > 20) this.turns.delete(Math.min(...this.turns.keys()));

    // Reply language: an explicit request sticks for the session; otherwise the
    // language of this question (from its words, STT's tag only as a hint).
    const asked = requestedLanguage(question);
    if (asked) this.preferredLanguage = asked;
    const reply = this.preferredLanguage ?? detectLanguage(question, language);
    const ttsLanguage = ttsLanguageFor(reply) ?? toTtsLanguage(language);
    this.record("turn", { turn: turn.id, question, language, reply, preferred: this.preferredLanguage });

    const finalAt = Date.now();
    const speechEndedAt = this.speechEndedAt || finalAt;
    const timings: Record<string, number> = { sttFinalMs: finalAt - speechEndedAt };

    this.send({ type: "user", turn: turn.id, text: question, language: language ?? null });
    const historyBefore = [...this.history];
    const userMsg: ChatTurn = { role: "user", content: question };
    this.history.push(userMsg);

    try {
      const socket = await this.tts.take();
      if (turn.cancelled) return socket.close();

      // Moves the video to the moment each sentence talks about, exactly when
      // that sentence starts playing (offset = seconds into this turn's audio).
      let audioBytes = 0;
      let lastCueSentence = -1;
      turn.cues = new Map();
      turn.tts = TtsStream.start(
        socket,
        ttsLanguage,
        (pcm) => {
          if (turn.cancelled || this.active !== turn) return;
          if (!turn.audioStarted) {
            turn.audioStarted = true;
            turn.firstAudioAt = Date.now();
            timings.firstAudioMs = Date.now() - finalAt;
            // What the user actually feels: stopped talking → hears the tutor.
            timings.voiceToVoiceMs = Date.now() - speechEndedAt;
            this.send({ type: "audio_start", turn: turn.id });
          }
          const sentence = turn.tts?.currentSentence() ?? 0;
          if (sentence !== lastCueSentence) {
            lastCueSentence = sentence;
            const at = turn.cues?.get(sentence);
            if (at !== undefined) {
              this.send({ type: "cue", turn: turn.id, at, offset: audioBytes / (config.call.outputSampleRate * 2) });
            }
          }
          audioBytes += pcm.length;
          this.ws.send(pcm, { binary: true });
        },
        (message) => {
          console.error("[call] TTS error", message);
          this.record("tts_error", { turn: turn.id, message });
        },
      );

      // After an interruption: "Sure." / "हाँ, बिल्कुल।" first, like a person
      // would, which also covers the ~1 s before the answer starts.
      if (opts.filler) {
        const filler = pickFiller(FILLERS, ttsLanguage);
        turn.spoken.push(filler);
        turn.fillers = 1;
        turn.tts.speak(filler);
      }

      let unspoken = "";
      const speak = (sentence: string) => {
        const speakable = toSpeakableText(sentence);
        // Nothing to say (e.g. a leftover list of timestamps): TTS rejects
        // text without letters, so don't send it.
        if (!/\p{L}/u.test(speakable)) return;
        // The first timestamp this sentence cites, snapped to a real transcript line.
        const cited = cleanCitations(sentence, this.transcript?.segments ?? []).citations[0];
        if (cited !== undefined) turn.cues?.set(turn.spoken.length, cited);
        turn.spoken.push(sentence);
        turn.tts!.speak(speakable);
      };

      for await (const delta of streamTutor(
        { transcript: this.transcript!, question, history: historyBefore, voice: true, language, replyLanguage: reply },
        turn.abort.signal,
      )) {
        if (turn.cancelled) break;
        timings.llmFirstTokenMs ??= Date.now() - finalAt;
        turn.text += delta;
        unspoken += delta;
        this.send({ type: "assistant_delta", turn: turn.id, text: delta });
        // Hand complete sentences to TTS as soon as they're ready.
        let match: RegExpMatchArray | null;
        while ((match = unspoken.match(/^([\s\S]*?[.!?।])\s+/))) {
          speak(match[1]);
          unspoken = unspoken.slice(match[0].length);
        }
      }

      if (!turn.cancelled) {
        speak(unspoken);
        this.tutorLast = turn.text;
        this.tutorLastAt = Date.now();
        await turn.tts.end();
      }
    } catch (e) {
      if (!turn.abort.signal.aborted) throw e;
    } finally {
      this.finishTurn(turn, userMsg, timings, finalAt);
    }
  }

  private finishTurn(turn: Turn, userMsg: ChatTurn, timings: Record<string, number>, finalAt: number) {
    if (this.active === turn) this.active = null;
    turn.tts?.cancel();

    const { text: answer, citations } = cleanCitations(turn.text.trim(), this.transcript?.segments ?? []);
    const interrupted = turn.cancelled && !turn.merged;
    if (answer) {
      this.tutorLast = answer;
      this.tutorLastAt = Date.now();
    }

    const i = this.history.indexOf(userMsg);
    if (i >= 0) {
      if (turn.merged) {
        // Its words live on in the next question; drop the half-question.
        this.history.splice(i, 1);
      } else if (answer) {
        // Placed right after its own question, since turns can overlap.
        turn.answerMsg = { role: "assistant", content: interrupted ? `${answer} …(interrupted)` : answer };
        this.history.splice(i + 1, 0, turn.answerMsg);
      }
    }

    const outcome = {
      turn: turn.id,
      text: answer,
      citations,
      retracted: turn.merged,
      interrupted,
      timings: { ...timings, totalMs: Date.now() - finalAt },
    };
    this.record("answer", { question: turn.question, ...outcome });
    this.send({ type: "assistant_done", ...outcome });
  }

  /**
   * The browser reports how many seconds of an interrupted answer were played.
   * Keep only the sentences the user heard, so the tutor doesn't think it
   * explained something the user never heard.
   */
  private onHeard(turnId: number, seconds: number) {
    const turn = this.turns.get(turnId);
    if (!turn?.answerMsg || !turn.tts) return;
    const durations = turn.tts.sentenceSeconds();
    const fillers = turn.fillers ?? 0;
    let elapsed = 0;
    const heard: string[] = [];
    for (let i = 0; i < turn.spoken.length; i++) {
      const d = durations[i] ?? 0;
      if (elapsed + d * 0.5 > seconds) break; // count a sentence once half of it played
      if (i >= fillers) heard.push(turn.spoken[i]);
      elapsed += d;
    }
    if (heard.length === turn.spoken.length - fillers) return;
    turn.answerMsg.content = heard.length
      ? `${heard.join(" ")} …(interrupted here; the student didn't hear the rest)`
      : "(interrupted before the student heard anything)";
    this.record("heard", { turn: turnId, seconds, sentencesHeard: heard.length, sentencesTotal: turn.spoken.length - fillers });
  }

  private fail(e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    console.error("[call]", raw);
    const message = userMessage(e);
    this.record("error", { message, raw });
    this.send({ type: "error", message });
  }

  private close() {
    for (const t of this.limitTimers) clearTimeout(t);
    this.limitTimers = [];
    this.cancelCommit();
    if (this.active) this.cancelTurn(this.active, { merge: false });
    this.tts.close();
    if (this.stt) {
      try {
        this.stt.sendRealtimeEnd({ event: "end" });
      } catch {}
      this.stt.close();
      this.stt = null;
    }
    this.record("call_end");
    this.log.log.endedAt = new Date().toISOString();
  }
}
