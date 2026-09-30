# Clarification Questions — Sarvam Assignment (Video Tutor Agent)

Role: Growth Engineer
Option chosen: **Option 3 — Video Tutor Agent**

## To ask the interviewer

| # | Question | Why it matters | Answer |
|---|----------|----------------|--------|
| 1 | Is there a typical video length and type I should design for (e.g. talking-head lecture vs. slide- or code-heavy)? Are there sample videos you'll test with? And is it fine to use YouTube's existing captions where available, or should the transcript always be generated with speech-to-text? | Length decides whether sending the full transcript is enough or retrieval (RAG) is needed. Slide/code-heavy videos rely on on-screen content a transcript doesn't capture. Sample videos tell me what to demo with. The brief says "generates a transcript": captions are faster and free, but they may expect STT; this decides the main transcript path. | |
| 2 | For voice, do you expect a hands-free "phone call" mode (student can interrupt anytime, no button), or is push-to-talk fine? And in call mode, should the tutor cope with background chatter, TV or music, or can we assume a quiet room / headphones? | Call mode with background-noise handling is the most complex and least predictable part (a "who is this for?" check, ducking, a noisy-room fallback). Push-to-talk avoids most of it. | |
| 3 | How strict is "answer only from the video"? May the tutor add a short definition for a term the video uses but doesn't define? And how should it handle off-topic requests (exam tips, homework help, general questions)? | The model sometimes adds small outside facts (e.g. "the stroma is the fluid-filled space…", which the video never says), and students do ask off-topic things. Decides how hard to clamp down and what to say when declining. | |
| 4 | How long should explanations be: short spoken answers (2–4 sentences), or fuller explanations when the student asks for detail? | Longer answers take longer to speak and are more likely to be interrupted. Decides the prompt's length rules and whether to offer "want more detail?" follow-ups. | |

## Open decisions (ours)

Things to decide ourselves; noted here so they go into the write-up.

| # | Decision | Current state / leaning |
|---|----------|-------------------------|
| A | Where should the "is this speech for the tutor?" check live? | Currently a `<silent>` rule in the main prompt. Leaning: a separate small, fast check with only recent context (no transcript), run early on partial speech, before retrieval. |
| B | Barge-in: pause, or duck (lower volume)? | Currently pauses, which froze the tutor for about 18 s while a song played. Leaning: duck, and stop only when the speech is judged to be for the tutor. |
| C | Backchannels ("hmm", "haan", "ok") while the tutor is speaking | Currently can interrupt (inconsistently). Leaning: a fixed word list that never interrupts mid-answer, but counts as a reply if the tutor just asked a question. |
| D | What goes into history when an answer is interrupted? | Currently the full generated text. Leaning: only the text actually heard (the browser reports playback position). |
| E | Conversation memory | Currently the last 6 exchanges, no summary. Add a rolling summary only if sessions get long. With RAG, add a standalone-question rewrite step. |
| F | Grounding | Model occasionally adds outside facts. Options: stricter prompt, a check of claims against the transcript, or both. |
| G | Hindi transcribed in Roman script | Lock the call language, or pass the video's language to STT. |
| H | Noisy-room fallback | Show a hint and offer a hold-to-talk toggle after repeated ignored speech. |

## Resolved

| Question | Decision |
|----------|----------|
| Submission format? | GitHub repo + demo video (no deployed link needed). |
| Languages? | Indic and code-mixed (Hinglish etc.) videos and questions, with English at minimum. |
| Polish vs. technical depth? | Both. |
| Model choice? | Any model is fine; using Sarvam's. |
| Which APIs / credits? | Sarvam APIs (LLM + STT + TTS), using my own Sarvam account credits. |
| Backend language? | Node.js + TypeScript (official `sarvamai` npm SDK). |
| Frontend? | React. |
| RAG or not? | Start without RAG (full transcript in the prompt, which fits in `sarvam-105b`'s 128K context). Later go hybrid: full transcript under a token limit, top-k timestamped chunks over it. |
| Voice pipeline | Call mode: Sarvam realtime STT (`saaras:v3-realtime`) with its VAD for turn detection, streaming LLM, streaming TTS (`bulbul:v3`), all over WebSockets. |
| LLM reasoning | Off. Low reasoning took about 14 s and sometimes returned no answer; off gives about 0.5–1 s. |
| Turn detection | 600 ms of silence (Sarvam VAD), plus an extra wait based on how the words end (200 ms after "?", 500 ms after ".", 1.5 s when trailing off). Speech resumed before the tutor answers is merged into one question. |
| Debugging | In-memory call log at `/api/calls/latest` (last 20 calls). |
