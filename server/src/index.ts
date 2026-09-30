import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import multer from "multer";
import { SarvamAIError } from "sarvamai";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { userMessage } from "./userErrors.js";
import { transcriptsRouter } from "./routes/transcripts.js";
import { tutorRouter } from "./routes/tutor.js";
import { speechRouter } from "./routes/speech.js";
import { callsRouter } from "./routes/calls.js";
import { videosRouter } from "./routes/videos.js";
import { loadCachedTranscripts } from "./transcription/builder.js";
import { saveTranscript } from "./services/transcriptStore.js";
import { attachCallServer } from "./call/server.js";

const app = express();

app.use(cors());
// Transcripts of long videos can be a few MB of JSON.
app.use(express.json({ limit: "10mb" }));

// The web app (index.html, app.js, app.css).
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

if (process.env.NODE_ENV !== "production") {
  // Dev-only: every transcript in fixtures/ preloaded (e.g. the sample video).
  const fixtures = new URL("../fixtures/", import.meta.url);
  for (const file of readdirSync(fixtures).filter((f) => f.endsWith(".json"))) {
    saveTranscript(JSON.parse(readFileSync(new URL(file, fixtures), "utf8")));
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, models: { llm: config.llm.model, stt: config.stt.model, tts: config.tts.model } });
});

app.use("/api/transcripts", transcriptsRouter);
app.use("/api/calls", callsRouter);
app.use("/api/videos", videosRouter);
app.use("/api", tutorRouter);
app.use("/api", speechRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message });
  } else if (err instanceof SarvamAIError) {
    console.error("Sarvam API error:", err.statusCode, err.body);
    res.status(502).json({ error: userMessage(err) });
  } else if (err instanceof SyntaxError) {
    res.status(400).json({ error: "Invalid JSON" });
  } else {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
};
app.use(errorHandler);

// Transcripts built in earlier runs (data/videos/<id>/transcript.json).
const cachedCount = await loadCachedTranscripts();

const server = app.listen(config.port, () => {
  console.log(`Video Tutor API listening on http://localhost:${config.port}`);
  if (cachedCount) console.log(`Loaded ${cachedCount} cached transcript(s)`);
});
attachCallServer(server);
