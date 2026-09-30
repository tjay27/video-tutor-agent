// End-to-end voice scenarios against a running server (`npm run dev`).
// Each scenario opens a real call, plays TTS-generated speech into it like a
// microphone would, and checks what the tutor did.
//
// Usage: npm run voice-scenarios            (all)
//        npm run voice-scenarios -- chatter  (names containing "chatter")
import WebSocket from "ws";
import { SarvamAIClient } from "sarvamai";

const sarvam = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY! });
const URL = `ws://localhost:${process.env.PORT || 8787}/ws/call`;
const VIDEO = process.env.VIDEO_ID || "sample-photosynthesis";
const MIC_RATE = 16000;
const TUTOR_BYTES_PER_S = 24000 * 2;

const speechCache = new Map<string, Promise<Buffer>>();
function say(text: string, lang = "en-IN"): Promise<Buffer> {
  const key = `${lang}|${text}`;
  if (!speechCache.has(key)) {
    speechCache.set(key, (async () => {
      const s = await sarvam.textToSpeechStreaming.connect({ model: "bulbul:v3", send_completion_event: "true" });
      const parts: Buffer[] = [];
      const done = new Promise<void>((r) => s.on("message", (m) => (m.type === "audio" ? parts.push(Buffer.from(m.data.audio, "base64")) : r())));
      await s.waitForOpen();
      s.configureConnection({ type: "config", data: { language_code: lang as "en-IN", speaker: "ritu", output_audio_codec: "linear16", speech_sample_rate: MIC_RATE } });
      s.convert(text);
      s.flush();
      await done;
      s.close();
      return Buffer.concat(parts);
    })());
  }
  return speechCache.get(key)!;
}
const silence = (s: number) => Buffer.alloc(Math.round(MIC_RATE * s) * 2);

interface Event { t: number; type: string; [k: string]: unknown }

class Call {
  events: Event[] = [];
  tutorAudioBytes = 0;
  private ws!: WebSocket;
  private t0 = Date.now();

  async open() {
    this.ws = new WebSocket(URL);
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return void (this.tutorAudioBytes += (data as Buffer).length);
      const m = JSON.parse(data.toString());
      if (m.type !== "partial" && m.type !== "assistant_delta") this.events.push({ t: Date.now() - this.t0, ...m });
    });
    await new Promise((r) => this.ws.on("open", r));
    this.ws.send(JSON.stringify({ type: "start", videoId: VIDEO }));
    await this.waitFor("ready");
    // Pretend to be a browser that plays tutor audio as it arrives.
    this.ws.send(JSON.stringify({ type: "playback", playing: false }));
  }
  async play(pcm: Buffer) {
    for (let i = 0; i < pcm.length; i += 1600) {
      this.ws.send(pcm.subarray(i, i + 1600));
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  /** Like the browser: after an interrupt, report how much of the answer was heard. */
  reportHeard(seconds: number) {
    const turn = this.events.find((e) => e.type === "audio_start")?.turn;
    this.ws.send(JSON.stringify({ type: "heard", turn, seconds }));
  }
  setPlaying(playing: boolean) {
    this.ws.send(JSON.stringify({ type: "playback", playing }));
  }
  async waitFor(type: string, pred: (e: Event) => boolean = () => true, timeoutMs = 20000): Promise<Event | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const e = this.events.find((x) => x.type === type && pred(x));
      if (e) return e;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }
  /** Keeps streaming silence (like an open mic) until tutor audio arrives. */
  async untilTutorSpeaks(timeoutMs = 15000) {
    const start = Date.now();
    while (this.tutorAudioBytes === 0 && Date.now() - start < timeoutMs) await this.play(silence(0.1));
    this.setPlaying(true);
  }
  count(type: string) {
    return this.events.filter((e) => e.type === type).length;
  }
  answers() {
    return this.events.filter((e) => e.type === "assistant_done" && !e.retracted);
  }
  close() {
    this.ws.send(JSON.stringify({ type: "hangup" }));
    this.ws.close();
  }
}

type Check = [description: string, ok: boolean];
interface Scenario { name: string; run: (c: Call) => Promise<Check[]> }

const scenarios: Scenario[] = [
  {
    name: "clear question is answered fast",
    run: async (c) => {
      await c.play(Buffer.concat([await say("Why are leaves green?"), silence(1.5)]));
      const a = await c.waitFor("assistant_done");
      const v2v = (a?.timings as { voiceToVoiceMs?: number })?.voiceToVoiceMs ?? 99999;
      return [
        ["answered", !!a?.text],
        [`voice-to-voice < 1.6 s (${v2v} ms)`, v2v < 1600],
      ];
    },
  },
  {
    name: "thinking pause is merged into one question",
    run: async (c) => {
      await c.play(Buffer.concat([await say("So the Calvin cycle is"), silence(1.4), await say("where does it happen?"), silence(2)]));
      const users = await c.waitFor("assistant_done").then(() => c.events.filter((e) => e.type === "user" && !isRetracted(c, e)));
      return [
        [`one question asked (${users.map((u) => u.text).join(" | ")})`, users.length === 1],
        ["it contains both parts", /calvin/i.test(String(users[0]?.text)) && /where/i.test(String(users[0]?.text))],
      ];
    },
  },
  {
    name: "side chat to mom while idle is ignored",
    run: async (c) => {
      await c.play(Buffer.concat([await say("हाँ मम्मी, मैं अभी आती हूँ, बस पाँच मिनट।", "hi-IN"), silence(3)]));
      await c.waitFor("ignored", () => true, 6000);
      return [
        ["ignored", c.count("ignored") >= 1],
        ["no answer", c.count("user") === 0],
      ];
    },
  },
  {
    name: "chatter while tutor speaks: tutor carries on",
    run: async (c) => {
      await c.play(Buffer.concat([await say("Explain the two stages of photosynthesis."), silence(1)]));
      await c.untilTutorSpeaks();
      await c.play(Buffer.concat([await say("हाँ मम्मी, बस दो मिनट, आ रही हूँ।", "hi-IN"), silence(3)]));
      return [
        ["never interrupted", c.count("interrupt") === 0],
        ["chatter ignored", c.count("ignored") >= 1],
        ["only one answer", c.answers().length === 1],
      ];
    },
  },
  {
    name: '"hmm" while tutor speaks does not interrupt',
    run: async (c) => {
      await c.play(Buffer.concat([await say("Explain the two stages of photosynthesis."), silence(1)]));
      await c.untilTutorSpeaks();
      await c.play(Buffer.concat([await say("hmm"), silence(2.5)]));
      return [
        ["never interrupted", c.count("interrupt") === 0],
        ["only one answer", c.answers().length === 1],
      ];
    },
  },
  {
    name: '"ruko" while tutor speaks stops it',
    run: async (c) => {
      await c.play(Buffer.concat([await say("Explain the two stages of photosynthesis."), silence(1)]));
      await c.untilTutorSpeaks();
      await c.play(Buffer.concat([await say("रुको रुको, एक सेकंड।", "hi-IN"), silence(3)]));
      return [
        ["interrupted", c.count("interrupt") >= 1],
        ["stopped event", c.count("stopped") >= 1],
        ["no new answer", c.answers().length <= 1],
      ];
    },
  },
  {
    name: "real barge-in question replaces the answer",
    run: async (c) => {
      await c.play(Buffer.concat([await say("Explain the two stages of photosynthesis."), silence(1)]));
      await c.untilTutorSpeaks();
      await c.play(Buffer.concat([await say("Wait, what gas do plants release?"), silence(2)]));
      await c.waitFor("interrupt");
      c.reportHeard(2);
      const second = await c.waitFor("assistant_done", (e) => /release|oxygen/i.test(String(c.events.find((u) => u.type === "user" && u.turn === e.turn)?.text)));
      const log = await (await fetch(`http://localhost:${process.env.PORT || 8787}/api/calls/latest`)).json();
      const heard = log.events.find((e: Event) => e.type === "heard");
      return [
        ["interrupted", c.count("interrupt") >= 1],
        [`history keeps only what was heard (${heard ? `${heard.sentencesHeard}/${heard.sentencesTotal} sentences` : "no heard record"})`, !!heard && heard.sentencesHeard < heard.sentencesTotal],
        [`answered the new question (${String(second?.text).slice(0, 60)})`, /oxygen/i.test(String(second?.text))],
      ];
    },
  },
  {
    name: "grounding: no outside facts about the stroma",
    run: async (c) => {
      await c.play(Buffer.concat([await say("Where does the Calvin cycle happen?"), silence(1.5)]));
      const a = await c.waitFor("assistant_done");
      const text = String(a?.text);
      return [
        [`mentions the stroma (${text.slice(0, 80)})`, /stroma/i.test(text)],
        ['no "fluid-filled" or other outside definition', !/fluid|liquid|jelly|matrix/i.test(text)],
        ["has a citation", ((a?.citations as number[]) ?? []).length > 0],
      ];
    },
  },
];

function isRetracted(c: Call, userEvent: Event) {
  return c.events.some((e) => e.type === "assistant_done" && e.turn === userEvent.turn && e.retracted);
}

const filter = process.argv[2];
let passed = 0;
let total = 0;
for (const s of scenarios.filter((x) => !filter || x.name.includes(filter))) {
  const call = new Call();
  await call.open();
  let checks: Check[];
  try {
    checks = await s.run(call);
  } catch (e) {
    checks = [[`crashed: ${e instanceof Error ? e.message : e}`, false]];
  }
  await new Promise((r) => setTimeout(r, 500));
  call.close();
  const ok = checks.every(([, v]) => v);
  total++;
  if (ok) passed++;
  console.log(`${ok ? "✅" : "❌"} ${s.name}`);
  for (const [d, v] of checks) console.log(`     ${v ? "·" : "✗"} ${d}`);
  if (!ok) console.log("     events:", call.events.map((e) => e.type + (e.reason ? `(${e.reason})` : "")).join(" → "));
}
console.log(`\n${passed}/${total} scenarios passed`);
process.exit(0);
