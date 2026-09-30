import { Router } from "express";
import { saveTranscript, getTranscript, listTranscripts } from "../services/transcriptStore.js";
import { HttpError } from "../errors.js";
import type { Transcript } from "../types.js";

// Until the transcription module exists, transcripts are loaded here by hand
// (e.g. from fixtures/sample-transcript.json). The transcription module will
// call saveTranscript() directly.
export const transcriptsRouter = Router();

transcriptsRouter.get("/", (_req, res) => {
  res.json(listTranscripts());
});

transcriptsRouter.get("/:videoId", (req, res) => {
  const transcript = getTranscript(req.params.videoId);
  if (!transcript) throw new HttpError(404, "Transcript not found");
  res.json(transcript);
});

transcriptsRouter.post("/", (req, res) => {
  const body = req.body as Transcript;
  res.status(201).json(saveTranscript({ ...body, source: body.source ?? "manual" }));
});
