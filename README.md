# Video Tutor Agent

Paste a YouTube link, then **talk** to a tutor that answers **only from that video**, in English, Hindi, Hinglish or other Indian languages. Answers cite timestamps you can click to jump to that moment in the video.

Built on **Sarvam AI** end to end: `saaras:v4` batch speech-to-text for transcripts, `saaras:v3-realtime` for the live conversation, `sarvam-105b` for answers, and `bulbul:v3` streaming text-to-speech.

One-page summary: [docs/Video_Tutor_Agent.pdf](docs/Video_Tutor_Agent.pdf)

---

## Features

**Transcripts from a YouTube link**
- `yt-dlp` fetches the audio and YouTube's captions, and Sarvam `saaras:v4` transcribes the audio in `codemix` mode, so English terms in Hindi speech stay in English.
- Key terms (channel name, tags) are passed to speech-to-text so names are spelled right.
- Timestamps are split to sentence level and sharpened with caption timing.
- A completeness check fills any stretch where speech-to-text looks thin with YouTube's captions.
- Results are cached, so each video is fetched and transcribed only once. About 40 s for a 9-minute video.

**Hands-free voice conversation**
- A spoken greeting when the session starts, then you just talk. No button to hold.
- A **turn analyzer** (a small, fast LLM call) decides what each utterance is:
  - a finished question → answer now
  - an unfinished thought → wait for the rest
  - "stop" / "ruko" → go quiet
  - "hmm" / "okay" → ignore
  - talking to someone else, or TV / music → ignore
- **Interruptions:** the tutor pauses as soon as you speak.
  - A real question: the old answer is dropped, and the new one opens with a short filler like "Sure.".
  - Background chatter: the tutor resumes from exactly where it paused.
- **Replies in the language of your latest question**, and remembers explicit requests like "talk in English".
- **Remembers only what you heard:** after an interruption, only the sentences you actually heard stay in the conversation history.
- **Latency:** about 1.2–1.5 s from you going quiet to hearing the tutor.

**Answers only from the video**
- No outside facts or definitions; "That isn't covered in this video" when the video doesn't cover something.
- A citation on every factual sentence. Each citation is snapped to a real transcript line, or dropped if it doesn't match one.
- The transcript line being discussed lights up while the tutor speaks.

**Web UI (plain HTML/CSS/JS)**
- A video library, the YouTube player and a searchable transcript that follows playback.
- A chat with clickable timestamp chips and a live transcript of what you're saying.
- A hold-to-talk fallback for noisy rooms, suggested automatically when there's a lot of background speech or sound.
- Light and dark themes, and a mobile layout.

## Architecture

```
YouTube link ─► yt-dlp (audio + captions) ─► Sarvam saaras:v4 batch STT ─► sentence timestamps + completeness check ─► transcript (cached)

Browser mic (16 kHz PCM) ─► WebSocket ─► Sarvam realtime STT ─► turn analyzer ─► sarvam-105b (full transcript in prompt, streamed)
                                                                                         │ sentence by sentence
Browser speaker (24 kHz PCM) ◄────────────── WebSocket ◄──────────── Sarvam streaming TTS ◄┘
```

- **Backend:** Node.js 20+, TypeScript, Express 5, `ws`, the official `sarvamai` SDK.
- **Frontend:** a single static page (`server/public/`), no build step.
- **No RAG, on purpose:** the whole transcript goes in the prompt. Measured time to the LLM's first word is 0.4 s for a 9-minute video and about 1 s for 1 hour. The plan is to switch to retrieval only for videos over ~45–60 min. See [CHALLENGES.md](CHALLENGES.md).

## Quick start

**Requirements:** Node.js 20.6+, a Sarvam API key ([dashboard.sarvam.ai](https://dashboard.sarvam.ai)), and `yt-dlp` if you want to add new videos.

```bash
cd server
npm install
cp .env.example .env        # then paste your SARVAM_API_KEY into .env
npm run dev                 # http://localhost:8787
```

Open **http://localhost:8787** in Chrome, pick a video from the library, click **Ask a question**, allow the microphone, and talk. Headphones give the best results.

Three videos come with the repo (`server/fixtures/`), so you can try it right away without transcribing anything:
- *Message Queues in System Design Interviews* (English, 27 min)
- *Agentic AI Explained with a Real-Life Example* (Gate Smashers, Hinglish, 9 min)
- *5 Fun Physics Phenomena* (5 min)

**Adding your own videos** needs `yt-dlp`. Download the standalone build for your OS from [its releases page](https://github.com/yt-dlp/yt-dlp/releases) to `server/bin/yt-dlp` (on macOS it's `yt-dlp_macos`), then `chmod +x` it. Paste any YouTube link (up to 60 min) on the home page. YouTube blocks downloads from most cloud servers, so this works best when run locally.

## Project layout

```
server/
  src/
    call/            voice session: realtime STT, turn analyzer, streaming TTS, call log
    services/        tutor prompt + citation checks, language detection, TTS helpers
    transcription/   YouTube link → transcript (yt-dlp, Sarvam batch STT, captions)
    routes/          REST API (videos, transcripts, calls, speech)
  public/            web UI (index.html, app.js, app.css)
  fixtures/          transcripts shipped with the repo
  scripts/           smoke test, voice scenario tests, turn-analyzer eval, importers
docs/                one-page PDF summary
```

The API and the voice WebSocket protocol are documented in [server/README.md](server/README.md).

## Tests

These run against the real Sarvam APIs and **use credits**, so run them sparingly:

```bash
npm run smoke              # LLM + TTS + STT round trip
npm run turn-eval          # turn analyzer on labelled utterances
npm run voice-scenarios    # end-to-end voice scenarios (needs `npm run dev`)
```

On the last full runs: turn analyzer **20/21** correct (~200 ms median), voice scenarios **8/8**.

Every session's events (what speech-to-text heard, turn decisions, interruptions, answers, timings) are kept in memory for debugging at `http://localhost:8787/api/calls/latest`.

## Docs
- [CHALLENGES.md](CHALLENGES.md): every problem hit while building and testing, its cause, the fix and the result, plus design trade-offs.
- [TESTING.md](TESTING.md): manual test checklist.
- [PRODUCT_FLOW.md](PRODUCT_FLOW.md): product flow and transcript strategy.
- [CLARIFICATIONS.md](CLARIFICATIONS.md): open questions and decisions.

## Known limitations
- **Videos up to 60 minutes.** Longer ones would need their audio split before transcription, and RAG for fast answers.
- **Only what's said, not what's shown.** On-screen content (slides, diagrams) isn't understood. The planned fix is keyframes plus a vision model.
- **Laptop speakers vs headphones.** Talking over the tutor on laptop speakers can clip the start of your words. Headphones avoid this.
- **Storage is in memory** (sessions, call logs); transcripts are cached on disk.
