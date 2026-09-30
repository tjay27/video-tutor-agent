# Product Flow — Video Tutor Agent

Paste a YouTube link, then ask questions about the video by voice or text. Answers come **only** from the video and include clickable timestamps.

## Stack

| Layer | Choice |
|-------|--------|
| Frontend | React (Vite) |
| Backend | Node.js + TypeScript (Express 5) |
| STT | Sarvam Saaras. Batch API for the video transcript (up to 2 hrs/file, chunk-level timestamps); REST API for voice questions (≤30 s) |
| LLM | Sarvam chat completions |
| TTS | Sarvam Bulbul (streamed, so playback starts sooner) |
| SDK | `sarvamai` (npm) |
| YouTube audio | `yt-dlp` via `youtube-dl-exec` |

## Workstreams

The pieces connect through two contracts: the `Transcript` shape ([server/src/types.ts](server/src/types.ts)) and the HTTP API ([server/README.md](server/README.md)). With those fixed, each piece can be built and tested on its own.

| # | Workstream | Input → Output | Test on its own with |
|---|---|---|---|
| 1 | **Transcription** | YouTube URL → `Transcript` (captions, falling back to Sarvam batch STT) | A few real URLs, checking the output JSON |
| 2 | **Tutor brain** (LLM + prompt, later RAG) | `Transcript` + question → answer + citations | `fixtures/sample-transcript.json` + `npm run smoke` |
| 3 | **Voice I/O** (STT + TTS) | Audio ↔ text | `/api/stt`, `/api/tts` |
| 4 | **Frontend** (React) | Calls the API | Mocked API responses |

## Transcript strategy

Built by `POST /api/videos { url }` as a background job (see `server/src/transcription/builder.ts`):

1. **Video info** (`yt-dlp`): title, channel, duration, language, tags, caption tracks.
2. **Download** (one `yt-dlp` call): audio plus captions (human-made if available, otherwise YouTube's auto captions).
3. **Sarvam `saaras:v4` batch STT** in `codemix` mode, with key terms from the channel name and tags. Much better than YouTube's captions for Hinglish/Indic speech: English terms stay in English, names are spelled right.
4. **Build:** split into sentences (max ~20 s each), estimate timestamps within Sarvam's chunks and snap them to caption timings, and run a completeness check (minutes where STT is much thinner than the captions are filled from the captions).
5. **Fallbacks:** if STT fails, use captions with a warning; `source: "captions"` skips STT entirely.
6. **Cache:** everything is kept in `server/data/videos/<id>/`, so each video is fetched and transcribed once.

## Answering strategy (hybrid RAG)

- If the transcript is under ~15–20k tokens, send the full transcript to the LLM. This is simpler and more accurate.
- If it's over, embed the timestamped chunks, retrieve the top-k, and send only those.
- System prompt: answer only from the transcript, cite timestamps, and if the answer isn't there, say so and point to the closest related moment.

## Screens

### 1. Landing
```
┌──────────────────────────────────────────────┐
│  🎓 Video Tutor                              │
│  Ask anything about a YouTube video.         │
│                                              │
│  [ https://youtube.com/watch?v=...     ]     │
│  Language: [English ▾]   [ Start → ]         │
│                                              │
│  Try: [sample video 1] [sample video 2]      │
└──────────────────────────────────────────────┘
```

### 2. Processing (show real progress, not just a spinner)
```
┌──────────────────────────────────────────────┐
│  [thumbnail]  "Video title" · 18 min         │
│                                              │
│  ✓ Fetched video info                        │
│  ✓ Got transcript (captions / Sarvam STT)    │
│  ● Preparing tutor...                        │
└──────────────────────────────────────────────┘
```

### 3. Tutor
```
┌──────────────────────────┬───────────────────────────────┐
│  ▶ Embedded YT player    │  Chat                         │
│                          │  Suggested:                   │
│                          │  [What is X?] [Explain Y]     │
│                          │  [Summarize the video]        │
│ ──────────────────────── │                               │
│  Transcript (collapsible)│  You: What is backprop?       │
│  04:12 ...highlighted... │  Tutor: ... [▶ 04:12] 🔊      │
│                          │                               │
│                          │  [🎤 Hold to talk] [ type… ]  │
└──────────────────────────┴───────────────────────────────┘
```

## Interactions

- **Clickable timestamps:** jump the player to the cited moment and highlight that part of the transcript.
- **Suggested questions:** generated from the transcript once it's ready, so the user never faces an empty chat.
- **Voice loop:** hold the mic → Sarvam STT → LLM → Sarvam TTS auto-plays the answer. The text is shown alongside.
- **Out-of-scope questions:** reply "That isn't covered in this video", plus the closest timestamp.
- **Language:** the question and answer language follows the selector (or auto-detect).

## Growth extras (optional)

Log funnel events and mention them in the write-up:
`url_submitted → transcript_ready → first_question → voice_used → timestamp_clicked`

Also track time to transcript and time to the first TTS audio, since speed decides whether people keep using a voice product.

## Known challenges (for the write-up)

- YouTube blocks caption and audio fetches from cloud IPs, so run locally for the demo or add a fallback.
- Sarvam's REST STT only takes ≤30 s of audio, so long videos need the batch API, which is asynchronous and needs polling.
- Some videos have no captions, and auto-captions for Indic languages are often poor.
- Keeping answers strictly from the video (prompt rules, citations, refusal behavior).
- Voice speed from end to end (STT + LLM + TTS).
