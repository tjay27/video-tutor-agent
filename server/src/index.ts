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

// Transcripts shipped with the repo (fixtures/), so the app works out of the
// box. The toy "sample-" transcript has no real video, so it's skipped when hosted.
const fixtures = new URL("../fixtures/", import.meta.url);
for (const file of readdirSync(fixtures).filter((f) => f.endsWith(".json"))) {
  if (config.hosted && file.startsWith("sample-")) continue;
  saveTranscript(JSON.parse(readFileSync(new URL(file, fixtures), "utf8")));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, models: { llm: config.llm.model, stt: config.stt.model, tts: config.tts.model } });
});

// What the UI should offer (e.g. hide "add a video" on the hosted demo).
app.get("/api/config", (_req, res) => {
  res.json({ hosted: config.hosted, canAddVideos: !config.hosted, limits: config.limits });
});

if (config.hosted) {
  // Hosted demo: no adding videos (YouTube blocks cloud servers and yt-dlp
  // isn't installed), no public call logs (they contain what visitors said),
  // and no raw STT/TTS/LLM endpoints that would spend credits outside a session.
  const blocked = (message: string): express.RequestHandler => (_req, res) => {
    res.status(403).json({ error: message });
  };
  app.post("/api/videos", blocked("Adding new videos is turned off on the hosted demo. Run it locally to add your own."));
  app.post("/api/transcripts", blocked("Not available on the hosted demo."));
  app.use("/api/calls", blocked("Not available on the hosted demo."));
  app.use(["/api/ask", "/api/stt", "/api/tts"], blocked("Not available on the hosted demo."));
}

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
  console.log(`Video Tutor API listening on http://localhost:${config.port}${config.hosted ? " (hosted mode)" : ""}`);
  if (cachedCount) console.log(`Loaded ${cachedCount} cached transcript(s)`);
});
attachCallServer(server);
