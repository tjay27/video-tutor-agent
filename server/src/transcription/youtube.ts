import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { HttpError } from "../errors.js";

const run = promisify(execFile);

/** Accepts watch, youtu.be, shorts, embed and live URLs, or a bare 11-char id. */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
  if (host === "youtu.be") return url.pathname.slice(1, 12) || null;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  const v = url.searchParams.get("v");
  if (v) return v.slice(0, 11);
  const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

export interface VideoInfo {
  id: string;
  title: string;
  channel?: string;
  durationSeconds: number;
  /** yt-dlp's language code, e.g. "hi", "en". */
  language?: string;
  tags: string[];
  isLive: boolean;
  /** Caption track to download, preferring human-made ones. */
  captionTrack?: { lang: string; kind: "human" | "auto" };
}

type CaptionMap = Record<string, { ext: string }[]>;

function pickCaptionTrack(
  language: string | undefined,
  subtitles: CaptionMap,
  auto: CaptionMap,
): VideoInfo["captionTrack"] {
  const hasJson3 = (tracks?: { ext: string }[]) => tracks?.some((t) => t.ext === "json3");
  const human = Object.keys(subtitles).filter((k) => hasJson3(subtitles[k]) && k !== "live_chat");
  // Human captions in the video's language, then any human captions.
  const humanPick = human.find((k) => language && k.split("-")[0] === language) ?? human[0];
  if (humanPick) return { lang: humanPick, kind: "human" };
  // "<lang>-orig" is YouTube's recognition of the original audio; the rest
  // of the auto tracks are machine translations of it.
  const orig = Object.keys(auto).find((k) => k.endsWith("-orig") && hasJson3(auto[k]));
  if (orig) return { lang: orig, kind: "auto" };
  if (language && hasJson3(auto[language])) return { lang: language, kind: "auto" };
  return undefined;
}

async function ytDlp(args: string[]): Promise<string> {
  try {
    const { stdout } = await run(config.transcription.ytDlpPath, ["--no-warnings", "--no-progress", ...args], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    return stdout;
  } catch (e) {
    throw friendlyYtDlpError(e);
  }
}

function friendlyYtDlpError(e: unknown): Error {
  const err = e as NodeJS.ErrnoException & { stderr?: string };
  if (err.code === "ENOENT") {
    return new Error(`yt-dlp not found at ${config.transcription.ytDlpPath}. See server/README.md.`);
  }
  const stderr = err.stderr ?? String(e);
  const line = stderr.split("\n").find((l) => l.includes("ERROR")) ?? stderr.trim().split("\n").pop() ?? "";
  if (/429|Too Many Requests/i.test(stderr)) return new HttpError(429, "YouTube is rate-limiting requests. Try again in a few minutes.");
  if (/Sign in to confirm|bot/i.test(stderr)) return new HttpError(403, "YouTube is asking to confirm this isn't a bot. Try again later.");
  if (/Private video|Video unavailable|removed|not available/i.test(stderr)) return new HttpError(404, "This video is private or unavailable.");
  if (/age/i.test(line)) return new HttpError(403, "This video is age-restricted and can't be fetched.");
  return new Error(`yt-dlp failed: ${line.replace(/^ERROR:\s*/, "")}`);
}

/** Fetches video metadata and saves the raw info JSON for the download step. */
export async function fetchVideoInfo(videoId: string, infoPath: string): Promise<VideoInfo> {
  const raw = await ytDlp(["--dump-single-json", "--skip-download", `https://www.youtube.com/watch?v=${videoId}`]);
  await writeFile(infoPath, raw);
  return parseVideoInfo(raw);
}

export function parseVideoInfo(raw: string): VideoInfo {
  const d = JSON.parse(raw);
  return {
    id: d.id,
    title: d.title,
    channel: d.channel ?? d.uploader,
    durationSeconds: d.duration ?? 0,
    language: d.language ?? undefined,
    tags: d.tags ?? [],
    isLive: d.live_status === "is_live" || d.live_status === "is_upcoming",
    captionTrack: pickCaptionTrack(d.language ?? undefined, d.subtitles ?? {}, d.automatic_captions ?? {}),
  };
}

/**
 * Downloads audio (and captions, if any) in a single yt-dlp run, reusing the
 * saved info JSON so YouTube is only hit once more. Returns the file paths.
 */
export async function downloadMedia(
  info: VideoInfo,
  infoPath: string,
  dir: string,
): Promise<{ audioPath: string; captionsPath?: string }> {
  const args = ["--load-info-json", infoPath, "-f", "bestaudio[ext=m4a]/bestaudio", "-o", join(dir, "audio.%(ext)s")];
  if (info.captionTrack) {
    args.push(
      info.captionTrack.kind === "human" ? "--write-subs" : "--write-auto-subs",
      "--sub-langs", info.captionTrack.lang,
      "--sub-format", "json3",
      "-o", `subtitle:${join(dir, "captions")}`,
    );
  }
  await ytDlp(args);

  const media = await findDownloadedMedia(dir);
  if (!media.audioPath) throw new Error("Audio download finished but no audio file was found.");
  return { audioPath: media.audioPath, captionsPath: media.captionsPath };
}

/** Audio and caption files already downloaded into a video's cache folder. */
export async function findDownloadedMedia(dir: string): Promise<{ audioPath?: string; captionsPath?: string }> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const audio = files.find((f) => f.startsWith("audio.") && !f.endsWith(".json") && !f.endsWith(".part"));
  const captions = files.find((f) => f.startsWith("captions.") && f.endsWith(".json3"));
  return { audioPath: audio && join(dir, audio), captionsPath: captions && join(dir, captions) };
}
