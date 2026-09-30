import { Router } from "express";
import { HttpError } from "../errors.js";
import { audioUpload } from "../upload.js";
import { transcribeClip } from "../services/stt.js";
import { synthesize } from "../services/tts.js";

// Standalone STT/TTS endpoints, useful for testing each piece on its own
// and for the "play this answer again" button.
export const speechRouter = Router();

/** Multipart form: audio (file, ≤30 s). Returns { text, language }. */
speechRouter.post("/stt", audioUpload.single("audio"), async (req, res) => {
  if (!req.file) throw new HttpError(400, "audio file is required");
  const result = await transcribeClip({
    audio: req.file.buffer,
    filename: req.file.originalname || "clip.webm",
    contentType: req.file.mimetype,
  });
  res.json(result);
});

/** Body: { text, language? }. Returns audio/mpeg. */
speechRouter.post("/tts", async (req, res) => {
  const { text, language } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text is required");
  const audio = await synthesize(text, language);
  res.type("audio/mpeg").send(audio);
});
