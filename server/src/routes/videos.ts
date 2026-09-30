import { Router } from "express";
import { HttpError } from "../errors.js";
import { getJob, listJobs, startTranscription, type TranscriptSourcePreference } from "../transcription/builder.js";

export const videosRouter = Router();

/**
 * Start building a transcript from a YouTube link.
 * Body: { url, source?: "auto" | "captions" }
 * Returns 202 with the job; poll GET /api/videos/:videoId until stage is "ready".
 */
videosRouter.post("/", (req, res) => {
  const { url, source } = req.body ?? {};
  if (typeof url !== "string" || !url.trim()) throw new HttpError(400, "url is required");
  if (source !== undefined && source !== "auto" && source !== "captions") {
    throw new HttpError(400, 'source must be "auto" or "captions"');
  }
  const job = startTranscription(url, source as TranscriptSourcePreference | undefined);
  res.status(job.stage === "ready" ? 200 : 202).json(job);
});

videosRouter.get("/", (_req, res) => {
  res.json(listJobs());
});

videosRouter.get("/:videoId", (req, res) => {
  const job = getJob(req.params.videoId);
  if (!job) throw new HttpError(404, "No transcription job for this video");
  res.json(job);
});
