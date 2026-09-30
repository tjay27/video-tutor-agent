import { SarvamAIClient } from "sarvamai";
import { config } from "../config.js";

export const sarvam = new SarvamAIClient({
  apiSubscriptionKey: config.sarvamApiKey,
});
