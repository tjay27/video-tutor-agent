import { SarvamAIClient } from "sarvamai";
import { config } from "../config.js";

// Node 22+ ships a built-in (browser-style) WebSocket. The Sarvam SDK prefers it
// over the `ws` package, but it can't send custom headers, so the realtime STT
// socket loses its "Api-Subscription-Key" header and Sarvam answers
// `invalid_subscription_key` (401). TTS still works because the SDK also sends
// the key as a subprotocol there, which is what made this confusing on Render.
// Hiding the built-in one makes the SDK use `ws` on every Node version. Nothing
// else in this server uses the global WebSocket.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "undefined") {
  try {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  } catch {}
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "undefined") {
    Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });
  }
}

export const sarvam = new SarvamAIClient({
  apiSubscriptionKey: config.sarvamApiKey,
});
