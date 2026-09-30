// End-to-end check of call mode without a microphone: speaks a question into
// /ws/call using TTS audio, and reports how much answer audio comes back.
// Usage (with `npm run dev` running):
//   npm run call-test
//   npm run call-test "Your question"
//   VIDEO_ID=e2UOjvIq5No npm run call-test "..."                      (another loaded video)
//   LANG_CODE=hi-IN npm run call-test "हाँ मम्मी, आती हूँ"      (speak in another language)
//   npm run call-test "So the Calvin cycle, um|where does it happen?"   ("|" = thinking pause, 1.2 s or PAUSE_S)
import WebSocket from "ws";
import { SarvamAIClient } from "sarvamai";

const QUESTION = process.argv[2] ?? "Where does photosynthesis happen and what does the plant need for it?";
const sarvam = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY! });
const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(5)}ms`;

async function say(text: string): Promise<Buffer> {
  const s = await sarvam.textToSpeechStreaming.connect({ model: "bulbul:v3", send_completion_event: "true" });
  const parts: Buffer[] = [];
  const done = new Promise<void>((r) =>
    s.on("message", (m) => (m.type === "audio" ? parts.push(Buffer.from(m.data.audio, "base64")) : r())),
  );
  await s.waitForOpen();
  s.configureConnection({ type: "config", data: { language_code: (process.env.LANG_CODE || "en-IN") as "en-IN", speaker: "ritu", output_audio_codec: "linear16", speech_sample_rate: 16000 } });
  s.convert(text);
  s.flush();
  await done;
  s.close();
  return Buffer.concat(parts);
}

const PAUSE = Buffer.alloc(Math.round(16000 * (Number(process.env.PAUSE_S) || 1.2)) * 2);
const parts = await Promise.all(QUESTION.split("|").map((p) => say(p.trim())));
const question = Buffer.concat(parts.flatMap((p, i) => (i ? [PAUSE, p] : [p])));
const ws = new WebSocket(`ws://localhost:${process.env.PORT || 8787}/ws/call`);
let answerBytes = 0;
const finished = new Promise<void>((resolve) => {
  ws.on("message", (data, isBinary) => {
    if (isBinary) return void (answerBytes += (data as Buffer).length);
    const m = JSON.parse(data.toString());
    if (m.type === "ready") streamQuestion();
    if (m.type === "user") console.log(ms(), "heard:", m.text);
    if (["duck", "unduck", "interrupt"].includes(m.type)) console.log(ms(), `[${m.type}]`);
    if (m.type === "stopped") console.log(ms(), "STOPPED:", m.text);
    if (m.type === "ignored") {
      console.log(ms(), `IGNORED (${m.reason}):`, m.text);
      setTimeout(resolve, 1500);
    }
    if (m.type === "error") console.log(ms(), "ERROR:", m.message);
    if (m.type === "assistant_done" && m.retracted) console.log(ms(), "(merged into next question):", JSON.stringify(m.text));
    if (m.type === "assistant_done" && !m.retracted) {
      console.log(ms(), "answer:", m.text);
      console.log(ms(), "timings:", m.timings);
      // Audio can still be arriving after the text is done.
      setTimeout(resolve, 1500);
    }
  });
});
ws.on("open", () => ws.send(JSON.stringify({ type: "start", videoId: process.env.VIDEO_ID || "sample-photosynthesis" })));

async function streamQuestion() {
  const pcm = Buffer.concat([question, Buffer.alloc(32000 * 2)]); // + 2 s silence to end the turn
  for (let i = 0; i < pcm.length; i += 1600) {
    ws.send(pcm.subarray(i, i + 1600));
    await new Promise((r) => setTimeout(r, 50));
  }
}

await finished;
const seconds = answerBytes / (24000 * 2);
console.log(ms(), `answer audio received: ${seconds.toFixed(1)} s (${answerBytes} bytes)`);
ws.send(JSON.stringify({ type: "hangup" }));
setTimeout(() => process.exit(0), 300);
