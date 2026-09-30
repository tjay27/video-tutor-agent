import { Router } from "express";
import { HttpError } from "../errors.js";
import { getTranscript } from "../services/transcriptStore.js";
import { askTutor } from "../services/tutor.js";
import type { ChatTurn } from "../types.js";

export const tutorRouter = Router();

function requireTranscript(videoId: unknown) {
  if (typeof videoId !== "string" || !videoId) throw new HttpError(400, "videoId is required");
  const transcript = getTranscript(videoId);
  if (!transcript) throw new HttpError(404, `No transcript loaded for video ${videoId}`);
  return transcript;
}

function parseHistory(raw: unknown): ChatTurn[] {
  if (!raw) return [];
  const history = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(history)) throw new HttpError(400, "history must be an array");
  return history;
}

/**
 * Text question.
 * Body: { videoId, question, history? }
 * Returns: { answer, citations, timings }
 */
tutorRouter.post("/ask", async (req, res) => {
  const { videoId, question, history } = req.body ?? {};
  const transcript = requireTranscript(videoId);
  if (typeof question !== "string" || !question.trim()) throw new HttpError(400, "question is required");

  const t0 = Date.now();
  const { answer, citations } = await askTutor({ transcript, question, history: parseHistory(history) });
  res.json({ answer, citations, timings: { llmMs: Date.now() - t0 } });
});

