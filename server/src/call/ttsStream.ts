import type { SarvamAI } from "sarvamai";
import { sarvam } from "../services/sarvam.js";
import { config } from "../config.js";

type Socket = Awaited<ReturnType<typeof sarvam.textToSpeechStreaming.connect>>;

/**
 * One spoken answer over Sarvam's streaming TTS WebSocket.
 *
 * Sarvam's TTS socket has no "cancel" message, so barge-in closes the socket.
 * To avoid paying the ~150 ms connect cost on every turn, the next socket is
 * opened ahead of time (see TtsPool).
 */
export class TtsStream {
  private closed = false;
  // Sarvam sends one "final" event per flush, i.e. per sentence, so the
  // stream is only done once every flushed sentence has been answered.
  private pendingSentences = 0;
  private ending = false;
  /** Audio bytes received for each spoken sentence, in order. */
  private sentenceBytes: number[] = [0];
  private finished!: () => void;
  /** Resolves once the last audio chunk has arrived (or the stream was cancelled). */
  readonly done = new Promise<void>((resolve) => (this.finished = resolve));

  private constructor(
    private socket: Socket,
    onAudio: (pcm: Buffer) => void,
    onError: (message: string) => void,
  ) {
    // 16-bit PCM: keep chunks at an even byte length so the browser can
    // read them as Int16Array.
    let carry = Buffer.alloc(0);
    socket.on("message", (msg) => {
      if (this.closed) return;
      if (msg.type === "audio") {
        const bytes = Buffer.concat([carry, Buffer.from(msg.data.audio, "base64")]);
        const even = bytes.length & ~1;
        carry = bytes.subarray(even);
        if (even) {
          this.sentenceBytes[this.sentenceBytes.length - 1] += even;
          onAudio(bytes.subarray(0, even));
        }
      }
      else if (msg.type === "event" && msg.data.event_type === "final") {
        this.pendingSentences--;
        this.sentenceBytes.push(0);
        this.finishIfDone();
      }
      else if (msg.type === "error") {
        // One sentence failed (e.g. Sarvam rejects text with no letters).
        // Count it as done and keep playing the rest, rather than ending the
        // whole answer.
        onError(msg.data.message);
        this.pendingSentences--;
        this.sentenceBytes.push(0);
        this.finishIfDone();
      }
    });
    socket.on("close", () => this.finished());
  }

  static async open(): Promise<Socket> {
    const socket = await sarvam.textToSpeechStreaming.connect({
      model: config.tts.model as SarvamAI.TextToSpeechStreamingModel,
      send_completion_event: "true",
      reconnectAttempts: 0,
    });
    await socket.waitForOpen();
    return socket;
  }

  static start(
    socket: Socket,
    language: SarvamAI.TextToSpeechLanguage,
    onAudio: (pcm: Buffer) => void,
    onError: (message: string) => void,
  ): TtsStream {
    const stream = new TtsStream(socket, onAudio, onError);
    socket.configureConnection({
      type: "config",
      data: {
        language_code: language,
        speaker: config.tts.speaker,
        output_audio_codec: "linear16",
        speech_sample_rate: config.call.outputSampleRate,
      },
    });
    return stream;
  }

  /** Queue a sentence and ask Sarvam to synthesize it right away. */
  speak(text: string) {
    if (this.closed || !text) return;
    this.pendingSentences++;
    this.socket.convert(text);
    this.socket.flush();
  }

  private finishIfDone() {
    if (this.ending && this.pendingSentences <= 0) this.finished();
  }

  /** Index (into the speak() calls) of the sentence whose audio is arriving now. */
  currentSentence(): number {
    return this.sentenceBytes.length - 1;
  }

  /** Seconds of audio produced for each sentence passed to speak(), in order. */
  sentenceSeconds(): number[] {
    const bytesPerSecond = config.call.outputSampleRate * 2;
    return this.sentenceBytes.map((b) => b / bytesPerSecond);
  }

  cancel() {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    this.finished();
  }

  /** Call after the last speak(); closes the socket once all audio is out. */
  async end() {
    this.ending = true;
    this.finishIfDone();
    await this.done;
    this.cancel();
  }
}

/** Keeps one TTS socket connected in advance so a new answer can start immediately. */
export class TtsPool {
  private next: Promise<Socket> | null = null;

  warm() {
    if (this.next) return;
    const pending = TtsStream.open();
    // A failed warm-up isn't fatal; take() opens a fresh socket instead.
    pending.catch(() => {
      if (this.next === pending) this.next = null;
    });
    this.next = pending;
  }

  async take(): Promise<Socket> {
    const pending = this.next;
    this.next = null;
    try {
      const socket = pending ? await pending.catch(() => null) : null;
      // The server may have closed a socket that sat idle.
      return socket?.readyState === 1 ? socket : await TtsStream.open();
    } finally {
      this.warm();
    }
  }

  close() {
    this.next?.then((s) => s.close()).catch(() => {});
    this.next = null;
  }
}
