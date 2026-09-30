// Shared contract between the transcription module, the tutor, and the frontend.

export interface Segment {
  /** Seconds from the start of the video. */
  start: number;
  end?: number;
  text: string;
}

export type TranscriptSource = "captions" | "sarvam-stt" | "manual";

export interface Transcript {
  videoId: string;
  title?: string;
  channel?: string;
  durationSeconds?: number;
  /** BCP-47 code, e.g. "en-IN", "hi-IN". */
  language?: string;
  source: TranscriptSource;
  segments: Segment[];
  /** Names and topic terms from the video (channel, tags). Used to bias STT. */
  keyterms?: string[];
  /** Anything the user should know about transcript quality. */
  warnings?: string[];
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface TutorAnswer {
  answer: string;
  /** Cited timestamps in seconds, so the frontend can seek the player. */
  citations: number[];
}
