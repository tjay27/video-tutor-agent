import { SarvamAIError } from "sarvamai";
import { HttpError } from "./errors.js";

/**
 * Turns internal errors (Sarvam API responses, sockets, yt-dlp) into short
 * messages that are safe to show users. The raw error still goes to the
 * server log and the call log.
 */
export function userMessage(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  const status = e instanceof SarvamAIError ? e.statusCode : undefined;
  const text = e instanceof Error ? e.message : String(e);

  if (status === 402 || /no credits|credits exhausted|insufficient_quota/i.test(text)) {
    return "Sarvam credits have run out. Top up in the Sarvam dashboard, then try again.";
  }
  if (status === 401 || status === 403 || /invalid (subscription|api) key|unauthori[sz]ed/i.test(text)) {
    return "The Sarvam API key isn't valid. Check SARVAM_API_KEY in server/.env.";
  }
  if (status === 429 || /rate limit|too many requests/i.test(text)) {
    return "Too many requests right now. Wait a few seconds and try again.";
  }
  if (/disconnected|socket|ECONNRESET|ETIMEDOUT|timeout/i.test(text)) {
    return "Lost the connection to the voice service. Please start the call again.";
  }
  return "Something went wrong. Please try again.";
}
