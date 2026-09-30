# Manual test checklist

**Before you start**
- Sarvam credits topped up (calls and new transcripts need them).
- Server running: `cd ~/Desktop/video-tutor/server && npm run dev`
- Open **http://localhost:8787/** in **Chrome**. Use **headphones** for barge-in tests unless the test says otherwise.
- After any test, you can open http://localhost:8787/api/calls/latest, or just ask Claude to "check the last call".

---

## A. Link → transcript

| # | Do this | Expect |
|---|---|---|
| A1 | Paste a new YouTube link (try an English video) → **Prepare video** | A 4-step progress tracker (info → download → Sarvam transcription → build) with a timer; ready in ~40 s for a ~10 min video; the video opens and appears in the library |
| A2 | Paste the same link again | Ready instantly (cached) |
| A3 | Try `youtu.be/…`, `/shorts/…` and a bare 11-character video ID | All accepted |
| A4 | Paste a non-YouTube link, or a private video | A short, clear error; no raw codes |
| A5 | Open the Gate Smashers video's transcript | Hinglish with English terms in English ("Agentic AI", "prompt"), "Gate Smashers" spelled right |
| A6 | Search the transcript box (e.g. "goal") | Matching lines filtered and highlighted |
| A7 | Click a transcript timestamp | The video jumps there and plays; the highlight follows playback |

## B. Call basics

| # | Do this | Expect |
|---|---|---|
| B0 | Look at the call panel | Compact bar on top (small orb, status, buttons); the conversation fills the panel below as a chat |
| B1 | Click **Ask a question**, allow the mic | The tutor greets you out loud ("Hi! I'm your tutor for this video…", or in Hindi for Hindi videos); then "Listening"; the orb reacts to your voice level |
| B1a | Start talking over the greeting | The greeting stops and your question is answered |
| B2 | Ask "What is agentic AI?" | The tutor speaks; its text streams into the chat; the line under the answer shows ~1.2–1.5 s (no live caption of your speech) |
| B3 | Ask something the video covers and just listen | As the tutor starts each sentence that cites a moment, that transcript line lights up (the video player isn't moved) |
| B3a | Click a timestamp chip in the answer | The video seeks there and plays (call goes on hold) |
| B6 | Click **I'm done**, then **Ask a question** again | New greeting and answers appear at the bottom of the chat; earlier messages stay above |
| B4 | Play the video during the call | "On hold · video playing": tutor pauses, mic ignored. Pause the video, and the call resumes |
| B5 | Press **Esc**, or click **I'm done** | Session ends |

## C. Turn-taking (when does the tutor answer?)

| # | Do this | Expect |
|---|---|---|
| C1 | "So the agent is…" (pause 1–2 s) "…how does it book the flight?" | One question, one answer (not two) |
| C2 | "Tell me about the…" and then stay silent | The tutor waits ~2 s, then answers or asks what you meant |
| C3 | After an answer, say "hmm" or "okay" | Greyed "Ignored" line; no reply |
| C4 | Say "So the…", then chat with someone else for 15+ s, then stay quiet | The fragment is **not** answered (`pending_expired` in the call log) |

## D. Interrupting the tutor (barge-in)

| # | Do this | Expect |
|---|---|---|
| D1 | While the tutor is answering (laptop speakers), ask a new question at normal volume | The tutor goes quiet almost immediately (no fade); after you finish it says something like "Sure." and answers your full question; old answer tagged "Interrupted" |
| D2 | While it's answering, say "ruko" / "wait" / "ek second" | It stops, says a short "Okay." / "ठीक है।", shows a "stopped" line, and waits |
| D3 | While it's answering, say "hmm" / "haan" | It keeps talking (no interruption) |
| D4 | While it's answering, have someone else talk (or talk to someone) | The tutor pauses briefly (~1 s), then continues from exactly where it stopped; "Ignored · talking to someone else" line |
| D7 | Ask about names in the video (e.g. "Kafka", "RabbitMQ", "MakeMyTrip") | The names are transcribed correctly |
| D5 | Interrupt early, then ask "what were you saying?" | It refers only to the part you actually heard |
| D6 | (No headphones) Let it answer through laptop speakers | It shouldn't interrupt itself (echo check) |

## E. Background noise

| # | Do this | Expect |
|---|---|---|
| E1 | With the tutor idle, chat with someone nearby (any language) | "Ignored" lines; no answers |
| E2 | Play a song or TV nearby for ~30 s | Ignored; after 3 ignored clips, a banner suggests **Hold to talk** |
| E3 | Turn on **Hold to talk**, then hold Space (or the button) and ask | Only speech while holding is heard; it answers after you release |
| E4 | In hold-to-talk mode, talk without holding | Nothing is heard |

## F. Language

| # | Do this | Expect |
|---|---|---|
| F1 | Ask in English | English answer |
| F2 | After a few English questions, ask in Hindi | **Hindi answer** (this was the bug) |
| F3 | Ask in Hinglish ("Agentic AI aur traditional AI mein kya difference hai?") | Hinglish answer |
| F4 | Ask in Telugu or another Indian language | Answer in that language |
| F5 | After a few Telugu questions, ask in English (or say "Talk in English") | English answer; your English is shown in English letters |

## G. Answers only from the video

| # | Do this | Expect |
|---|---|---|
| G1 | Ask something not in the video ("What is MCP?") | "That isn't covered in this video", possibly pointing to something related |
| G2 | Ask for a definition the video doesn't give | Says the video doesn't explain it, rather than explaining from general knowledge |
| G3 | Check any answer's wording, in any language | Says "the video" / "वीडियो", never "the transcript" |
| G4 | Click every timestamp in a few answers | Each one lands on a real, relevant moment |

## H. Errors and polish

| # | Do this | Expect |
|---|---|---|
| H1 | Block mic permission, then start a call | A friendly message; the call panel resets |
| H2 | With credits at zero, start a call | "Sarvam credits have run out…" (no raw error JSON) |
| H3 | Browser back button from a video | Back to the library |
| H4 | Switch the OS to dark mode; narrow the window to phone width | Dark theme; stacked mobile layout, no sideways scrolling |

---

## Automated checks (use sparingly; they use Sarvam credits)
- `npm run turn-eval`: turn analyzer on 21 labelled utterances (last run: 20/21)
- `npm run voice-scenarios`: 8 end-to-end voice scenarios (last run: 8/8)
- `npm run call-test "your question"`: one spoken question, printed with timings
