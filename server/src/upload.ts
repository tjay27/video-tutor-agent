import multer from "multer";
import { config } from "./config.js";

// Audio clips are held in memory; they're small (≤30 s) and sent straight to Sarvam.
export const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.stt.maxUploadBytes } });
