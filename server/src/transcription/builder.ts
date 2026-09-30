import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SarvamAI } from "sarvamai";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { userMessage } from "../userErrors.js";
import { getTranscript, saveTranscript } from "../services/transcriptStore.js";
import type { Segment, Transcript } from "../types.js";
import { describeFilled, fillThinStretches, segmentsFromCaptions } from "./captions.js";
import { runSarvamBatch, segmentsFromSarvamBatch, type Json3Captions, type SarvamBatchOutput } from "./sarvamBatch.js";
import { downloadMedia, fetchVideoInfo, findDownloadedMedia, parseVideoId, parseVideoInfo, type VideoInfo } from "./youtube.js";

/*
 * YouTube link → Transcript, as a background job.
 *
 *   fetching_info  yt-dlp: title, channel, duration, language, tags, caption tracks
 *   downloading    yt-dlp: audio + captions (one call, reusing the info JSON)
 *   transcribing   Sarvam batch STT (saaras:v4, codemix, key terms from the video)
 *   building       sentences + caption-snapped timestamps + completeness check
 *
 * Everything is cached in data/videos/<id>/, so a video is only fetched and
 * transcribed once. If STT fails, captions are used on their own.
 */

export type Stage = "queued" | "fetching_info" | "downloading" | "transcribing" | "building" | "ready" | "failed";

export interface VideoJob {
  videoId: string;
  stage: Stage;
  message: string;
  error?: string;
  title?: string;
  channel?: string;
  durationSeconds?: number;
  source?: Transcript["source"];
  segmentCount?: number;
  warnings?: string[];
  startedAt: string;
  finishedAt?: string;
}

export type TranscriptSourcePreference = "auto" | "captions";

const jobs = new Map<string, VideoJob>();

const SARVAM_LANGUAGES = new Set([
  "hi", "bn", "kn", "ml", "mr", "od", "pa", "ta", "te", "en", "gu",
  "as", "ur", "ne", "kok", "ks", "sd", "sa", "sat", "mni", "brx", "mai", "doi",
]);

function toSarvamLanguage(ytLanguage?: string): SarvamAI.SpeechToTextLanguage {
  const base = ytLanguage?.split("-")[0].toLowerCase();
  const code = base === "or" ? "od" : base;
  return code && SARVAM_LANGUAGES.has(code) ? (`${code}-IN` as SarvamAI.SpeechToTextLanguage) : "unknown";
}

/** Channel name + tags, deduped, within Sarvam's limits (50 terms, 64 chars each). */
function keytermsFor(info: VideoInfo): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of [info.channel, ...info.tags]) {
    const term = t?.trim();
    if (!term || term.length > 64 || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return terms.slice(0, 50);
}

function readyJob(t: Transcript): VideoJob {
  return {
    videoId: t.videoId,
    stage: "ready",
    message: "Transcript ready",
    title: t.title,
    channel: t.channel,
    durationSeconds: t.durationSeconds,
    source: t.source,
    segmentCount: t.segments.length,
    warnings: t.warnings,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

export function getJob(videoId: string): VideoJob | null {
  const job = jobs.get(videoId);
  if (job) return job;
  const t = getTranscript(videoId);
  return t ? readyJob(t) : null;
}

export function listJobs(): VideoJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Starts (or returns the existing) transcription job for a YouTube link. */
export function startTranscription(url: string, source: TranscriptSourcePreference = "auto"): VideoJob {
  const videoId = parseVideoId(url);
  if (!videoId) throw new HttpError(400, "That doesn't look like a YouTube video link.");

  const existing = getJob(videoId);
  if (existing && existing.stage !== "failed") return existing;

  const job: VideoJob = { videoId, stage: "queued", message: "Queued", startedAt: new Date().toISOString() };
  jobs.set(videoId, job);
  runJob(job, source).catch((e) => {
    job.stage = "failed";
    job.error = userMessage(e);
    job.message = "Failed";
    job.finishedAt = new Date().toISOString();
    console.error(`[transcribe ${videoId}]`, e instanceof Error ? e.message : e);
  });
  return job;
}

function update(job: VideoJob, stage: Stage, message: string) {
  job.stage = stage;
  job.message = message;
  console.log(`[transcribe ${job.videoId}] ${message}`);
}

async function readJson<T>(path: string): Promise<T | null> {
  return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as T) : null;
}

async function runJob(job: VideoJob, source: TranscriptSourcePreference) {
  const dir = join(config.transcription.dataDir, job.videoId);
  await mkdir(dir, { recursive: true });
  const paths = {
    info: join(dir, "info.json"),
    stt: join(dir, "stt.json"),
    transcript: join(dir, "transcript.json"),
  };

  // --- Video info (reused from cache once the audio is downloaded)
  update(job, "fetching_info", "Fetching video info");
  const cached = await findDownloadedMedia(dir);
  const haveAudio = !!cached.audioPath;
  const info =
    haveAudio && existsSync(paths.info)
      ? parseVideoInfo(await readFile(paths.info, "utf8"))
      : await fetchVideoInfo(job.videoId, paths.info);
  Object.assign(job, { title: info.title, channel: info.channel, durationSeconds: info.durationSeconds });

  if (info.isLive) throw new HttpError(400, "Live streams aren't supported yet.");
  const max = config.transcription.maxDurationSeconds;
  if (info.durationSeconds > max) {
    throw new HttpError(400, `This video is ${Math.round(info.durationSeconds / 60)} min; the limit is ${Math.round(max / 60)} min.`);
  }

  // --- Audio + captions
  update(job, "downloading", info.captionTrack ? `Downloading audio and ${info.captionTrack.kind} captions` : "Downloading audio (no captions available)");
  const media = haveAudio
    ? { audioPath: cached.audioPath!, captionsPath: cached.captionsPath }
    : await downloadMedia(info, paths.info, dir);
  const captions = media.captionsPath ? await readJson<Json3Captions>(media.captionsPath) : null;

  // --- Transcript text
  const warnings: string[] = [];
  let segments: Segment[] | null = null;
  let transcriptSource: Transcript["source"] = "sarvam-stt";
  const language = toSarvamLanguage(info.language);

  if (source === "auto") {
    update(job, "transcribing", `Transcribing with Sarvam ${config.transcription.sttModel}`);
    try {
      let output = await readJson<SarvamBatchOutput>(paths.stt);
      if (!output) {
        output = await runSarvamBatch(media.audioPath, join(dir, "stt-output"), { language, keyterms: keytermsFor(info) });
        await writeFile(paths.stt, JSON.stringify(output));
      }
      segments = segmentsFromSarvamBatch(output, captions ?? undefined);
      if (captions) {
        const checked = fillThinStretches(segments, captions);
        segments = checked.segments;
        if (checked.filled.length) warnings.push(describeFilled(checked.filled));
      }
    } catch (e) {
      if (!captions) throw e;
      warnings.push(`Speech-to-text failed (${e instanceof Error ? e.message : e}); using YouTube captions.`);
    }
  }
  if (!segments) {
    if (!captions) throw new HttpError(422, "This video has no captions to use.");
    segments = segmentsFromCaptions(captions);
    transcriptSource = "captions";
    if (info.captionTrack?.kind === "auto") warnings.push("Using YouTube's auto-generated captions, which may contain recognition errors.");
  }
  if (!segments.length) throw new Error("The transcript came out empty.");

  // --- Save
  update(job, "building", "Building transcript");
  const transcript: Transcript = {
    videoId: job.videoId,
    title: info.title,
    channel: info.channel,
    durationSeconds: info.durationSeconds,
    language: language === "unknown" ? info.language : language,
    source: transcriptSource,
    segments,
    keyterms: keytermsFor(info),
    warnings: warnings.length ? warnings : undefined,
  };
  await writeFile(paths.transcript, JSON.stringify(transcript, null, 2));
  saveTranscript(transcript);

  Object.assign(job, { source: transcriptSource, segmentCount: segments.length, warnings: transcript.warnings });
  update(job, "ready", "Transcript ready");
  job.finishedAt = new Date().toISOString();
}

/** Loads transcripts built in earlier runs, so they survive restarts. */
export async function loadCachedTranscripts(): Promise<number> {
  const root = config.transcription.dataDir;
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const id of await readdir(root)) {
    const t = await readJson<Transcript>(join(root, id, "transcript.json"));
    if (t) {
      saveTranscript(t);
      count++;
    }
  }
  return count;
}
