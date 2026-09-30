# Video Tutor — Backend

Node.js + TypeScript + Express 5, using Sarvam for the LLM (`sarvam-105b`), STT (`saaras:v3-realtime` for calls, `saaras:v3` for clips) and TTS (`bulbul:v3`).

There's no RAG yet: the full transcript goes into the prompt (sarvam-105b has a 128K context).

## Setup

```bash
cd server
npm install
cp .env.example .env   # then paste your SARVAM_API_KEY into .env
npm run smoke          # checks LLM, TTS and STT against the sample transcript
npm run dev            # http://localhost:8787
```

Then open http://localhost:8787/ in Chrome. Headphones work best.

Requires Node 20.6+ and [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) for YouTube links. Download the standalone build for your OS from its releases page to `server/bin/yt-dlp` (or set `YT_DLP_PATH`), then `chmod +x` it. On macOS that's `yt-dlp_macos`.

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, models }` |
| POST | `/api/videos` | `{ url, source?: "auto" \| "captions" }` | transcription job (202); poll the next route |
| GET | `/api/videos/:videoId` | — | job: `stage` (`fetching_info` → `downloading` → `transcribing` → `building` → `ready` / `failed`), `message`, `error`, `warnings` |
| GET | `/api/videos` | — | all jobs this run |
| POST | `/api/transcripts` | `Transcript` (JSON) | saved transcript |
| GET | `/api/transcripts` | — | list of loaded transcripts |
| GET | `/api/transcripts/:videoId` | — | `Transcript` |
| POST | `/api/ask` | `{ videoId, question, history? }` | `{ answer, citations, timings }` |
| GET | `/api/calls` | — | recent calls (in memory, last 20) |
| GET | `/api/calls/:id` | — | full event log of a call; use `latest` for the most recent |
| POST | `/api/stt` | multipart: `audio` (≤30 s) | `{ text, language }` |
| POST | `/api/tts` | `{ text, language? }` | `audio/mpeg` |

- `citations` are timestamps in seconds, so the player can seek to them.
- `history` is `[{ role: "user" | "assistant", content }]`; the server keeps the last 6 turns.

The `Transcript` shape is in [src/types.ts](src/types.ts). It's the contract the transcription module has to produce.

## Call mode: `ws://localhost:8787/ws/call`

A phone-style voice session with no push-to-talk: the user just talks, and can interrupt (barge in) at any time.

```
mic (16 kHz PCM) ─► Sarvam realtime STT (VAD) ─► turn analyzer ─► sarvam-105b (streaming) ─► sentences ─► Sarvam streaming TTS ─► speaker (24 kHz PCM)
```

**Browser → server**
- `{"type":"start","videoId":"..."}` to begin
- binary frames: mono 16-bit PCM at 16 kHz, ~50 ms each. Send silence (zeros) while on hold or when hold-to-talk isn't pressed.
- `{"type":"mode","ptt":true|false}` for the hold-to-talk toggle
- `{"type":"playback","playing":true|false}` when tutor audio starts or stops playing
- `{"type":"heard","turn":N,"seconds":S}` after an interrupt: how much of that answer was heard
- `{"type":"hangup"}` to end

**Server → browser**
- `ready`; `partial` `{text}` (live caption)
- `interrupt`: drop the queued tutor audio (reply with `heard`)
- `carry_on`: the speech wasn't for the tutor; resume it if it was paused
- `audio_start` `{turn}`, then binary frames: the answer's audio, mono 16-bit PCM at 24 kHz
- `cue` `{turn, at, offset}`: when this turn's audio reaches `offset` seconds, show the video at `at` seconds (the moment the sentence cites)
- `user` `{turn, text, language}`, `assistant_delta` `{turn, text}`, `assistant_done` `{turn, text, citations, interrupted, retracted, timings}`
- `ignored` `{text, reason: other|noise|backchannel|echo}`, `stopped` `{text}`, `noisy` (suggest hold-to-talk), `error` `{message}`

**Turn-taking:**
1. Sarvam's VAD ends speech after `CALL_SILENCE_MS` (600 ms) of silence.
2. The **turn analyzer** (`src/call/turnAnalyzer.ts`), a small LLM call with no transcript (~200 ms), labels the utterance `question`, `incomplete`, `stop`, `backchannel`, `other` or `noise`.
3. Complete questions are answered after 100 ms; unfinished ones wait up to 2 s for more. Only speech meant for the tutor is merged into the question.

**Barge-in:** the browser pauses the tutor the moment the mic hears the user (no fade). After 3 words the analyzer decides: a question or "stop" → `interrupt` (drop the answer); anything else → `carry_on`, and the browser resumes from where it paused. The answer to the new question opens with a short filler ("Sure.", "हाँ, बिल्कुल।"); "stop" gets a short "Okay.".

**Grounding:** answers use only the video (no outside facts or definitions), cite a timestamp per sentence, and every citation is snapped to a real transcript line or dropped (`cleanCitations` in `src/services/tutor.ts`).

**Tests** (with `npm run dev` running):
- `npm run turn-eval`: analyzer accuracy on 21 labelled utterances (20/21)
- `npm run voice-scenarios`: 8 end-to-end voice scenarios (thinking pause, chatter while speaking, "hmm", "ruko", barge-in, grounding)
- `npm run call-test "question"`: a single spoken question

**Debugging:** every call's events are kept in memory at `/api/calls/latest`.

## Try it without a frontend

```bash
curl -X POST localhost:8787/api/transcripts -H 'content-type: application/json' --data @fixtures/sample-transcript.json
```

```bash
curl -X POST localhost:8787/api/ask -H 'content-type: application/json' -d '{"videoId":"sample-photosynthesis","question":"Why are leaves green?"}'
```

```bash
curl -X POST localhost:8787/api/tts -H 'content-type: application/json' -d '{"text":"Hello from Sarvam"}' -o hello.mp3
```
