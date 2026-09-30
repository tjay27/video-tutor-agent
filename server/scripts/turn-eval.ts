// Evaluates the turn analyzer on labelled utterances.
// Usage: npm run turn-eval
import { analyzeTurn, isBackchannel, type TurnContext, type TurnKind } from "../src/call/turnAnalyzer.js";

const title = "Photosynthesis Explained";
const tutorLast = "Photosynthesis happens mainly in the leaves, inside chloroplasts.";
type Case = [expected: TurnKind, ctx: Partial<TurnContext> & { text: string }];
const cases: Case[] = [
  ["question", { text: "Why are leaves green?" }],
  ["question", { text: "पत्तियाँ हरी क्यों होती हैं?" }],
  ["question", { text: "Calvin cycle kahan hota hai?" }],
  ["question", { text: "Hindi mein samjhao." }],
  ["question", { text: "and what about the second stage?" }],
  ["question", { text: "haan please", tutorLast: "Should I explain the Calvin cycle too?" }],
  ["question", { text: "where does it happen?", earlier: "So the Calvin cycle," }],
  ["incomplete", { text: "So the Calvin cycle is" }],
  ["incomplete", { text: "मुझे ये जानना था कि" }],
  ["incomplete", { text: "what about the" }],
  // Dangling "if" clause (seen in a real call).
  ["incomplete", { text: "um tell me this thing uh if there are already there is already Kafka" }],
  ["incomplete", { text: "then", earlier: "tell me this thing, if there is already Kafka" }],
  // First words lost while talking over the tutor (seen in a real call).
  ["incomplete", { text: "covered in this", tutorSpeaking: true, tutorLast: "This video is about message queues in system design interviews." }],
  // Said TO the tutor even though not about the video (seen in a real call).
  ["question", { text: "I'm the creator of this platform. It's okay. Go ahead and look it up.", tutorLast: "The video doesn't explain why the partition key works that way." }],
  ["question", { text: "No no, you tell me why, go out of the video's context.", tutorLast: "The video doesn't explain why." }],
  ["question", { text: "Thank you, bye.", tutorSpeaking: true }],
  ["stop", { text: "रुको, एक सेकंड।", tutorSpeaking: true }],
  ["stop", { text: "wait wait", tutorSpeaking: true }],
  ["stop", { text: "hold on", tutorSpeaking: true }],
  ["backchannel", { text: "hmm", tutorSpeaking: true }],
  ["backchannel", { text: "haan haan", tutorSpeaking: true }],
  ["other", { text: "हाँ मम्मी, मैं अभी आती हूँ, बस पाँच मिनट।" }],
  ["other", { text: "Mummy ek second idhar aana." }],
  ["other", { text: "निस्सी अंधियारी बिजुरी चमके, जिया रामुर तड़पे तड़पे।" }],
  ["other", { text: "इस कैमरा फ्रेंडली जनरेशन को दिए पॉकेट फ्रेंडली प्राइसेस, डाउनलोड द ऐप नाउ।" }],
  ["other", { text: "Can you close the door please? It's cold.", tutorSpeaking: true }],
  ["noise", { text: "आ" }],
];

let pass = 0;
const times: number[] = [];
for (const [expected, c] of cases) {
  const ctx: TurnContext = { tutorSpeaking: false, tutorLast, videoTitle: title, ...c };
  const t0 = Date.now();
  const got = isBackchannel(ctx.text) && ctx.tutorSpeaking ? "backchannel" : await analyzeTurn(ctx);
  times.push(Date.now() - t0);
  // "noise" vs "other" are handled the same way (ignored), so either counts.
  const ok = got === expected || (["noise", "other"].includes(expected) && ["noise", "other"].includes(got ?? ""));
  if (ok) pass++;
  console.log(`${ok ? "✅" : "❌"} ${expected.padEnd(11)} got ${String(got).padEnd(11)} ${String(times.at(-1)).padStart(4)}ms  ${ctx.text}`);
}
times.sort((a, b) => a - b);
console.log(`\n${pass}/${cases.length} correct · median ${times[Math.floor(times.length / 2)]} ms · max ${times.at(-1)} ms`);
