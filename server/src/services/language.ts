import type { SarvamAI } from "sarvamai";

/*
 * Which language the tutor should answer in.
 *
 * Sarvam's realtime STT tags each utterance with a language, but the tag isn't
 * reliable on its own: it gets "stuck" on the last language spoken, and it tags
 * romanised Hindi ("Mujhe yeh samjhao") as English. So the decision is based
 * on the words themselves first, and the tag is only a hint.
 */

export type ReplyLanguage =
  | "English" | "Hindi" | "Hinglish" | "Telugu" | "Tamil" | "Kannada" | "Malayalam"
  | "Bengali" | "Gujarati" | "Punjabi" | "Odia" | "Marathi";

const SCRIPTS: [RegExp, ReplyLanguage][] = [
  [/[ऀ-ॿ]/, "Hindi"], [/[ఀ-౿]/, "Telugu"], [/[஀-௿]/, "Tamil"],
  [/[ಀ-೿]/, "Kannada"], [/[ഀ-ൿ]/, "Malayalam"], [/[ঀ-৿]/, "Bengali"],
  [/[઀-૿]/, "Gujarati"], [/[਀-੿]/, "Punjabi"], [/[଀-୿]/, "Odia"],
];

const FROM_CODE: Record<string, ReplyLanguage> = {
  hi: "Hindi", te: "Telugu", ta: "Tamil", kn: "Kannada", ml: "Malayalam", bn: "Bengali",
  gu: "Gujarati", pa: "Punjabi", od: "Odia", or: "Odia", mr: "Marathi", en: "English",
};

// Common Hindi words as they're written in Latin letters. Two or more of these
// in a sentence means romanised Hindi, whatever STT's tag says.
const ROMAN_HINDI = new Set([
  "hai", "hain", "ho", "hoga", "hota", "hoti", "tha", "thi", "kya", "kyu", "kyun", "kyon", "kaise", "kaisa", "kab",
  "kahan", "kaha", "kaun", "kitna", "mujhe", "mujhko", "mera", "mere", "meri", "tum", "tumhe", "aap", "aapko", "hum",
  "humein", "yeh", "ye", "woh", "wo", "vo", "iska", "uska", "isko", "usko", "nahi", "nahin", "haan", "matlab", "samjhao",
  "samjha", "samajh", "batao", "bataiye", "bata", "bolo", "karo", "karna", "kar", "karte", "raha", "rahi", "rahe", "ko",
  "ki", "ka", "ke", "se", "mein", "par", "aur", "lekin", "toh", "bhi", "sirf", "zaroorat", "zarurat", "chahiye", "wala",
  "wali", "accha", "achha", "thoda", "phir", "fir", "abhi", "agar", "jab", "kuch", "sab", "bahut", "dobara",
]);

export function isRomanisedHindi(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const hits = words.filter((w) => ROMAN_HINDI.has(w)).length;
  return hits >= 2 || (words.length > 0 && hits / words.length >= 0.3);
}

/** The language this question is in, from its script and words, with STT's tag as a hint. */
export function detectLanguage(text: string, sttLanguage?: string): ReplyLanguage | null {
  const byScript = SCRIPTS.find(([re]) => re.test(text))?.[1];
  if (byScript) return byScript;
  if (/[a-z]/i.test(text)) {
    if (isRomanisedHindi(text) || sttLanguage?.startsWith("hi")) return "Hinglish";
    return "English";
  }
  return sttLanguage ? (FROM_CODE[sttLanguage.split("-")[0].toLowerCase()] ?? null) : null;
}

// "talk in English", "reply in Hindi", "Hindi mein samjhao", "इंग्लिश में बोलो", "తెలుగులో చెప్పు"
const NAMES: [RegExp, ReplyLanguage][] = [
  [/english|इंग्लिश|अंग्रेज़ी|अंग्रेजी|ఇంగ్లీష్|ఇంగ్లిష్/i, "English"],
  [/hinglish/i, "Hinglish"],
  [/hindi|हिंदी|हिन्दी|హిందీ/i, "Hindi"],
  [/telugu|తెలుగు/i, "Telugu"],
  [/tamil|தமிழ்/i, "Tamil"],
  [/kannada|ಕನ್ನಡ/i, "Kannada"],
  [/malayalam|മലയാളം/i, "Malayalam"],
  [/bengali|bangla|বাংলা/i, "Bengali"],
  [/marathi|मराठी/i, "Marathi"],
];
const ASKS_FOR_LANGUAGE =
  /\b(talk|speak|reply|answer|respond|explain|tell|say)\b.*\b(in|using)\b|\b(me|mein|main)\b\s*(bolo|batao|samjhao|baat|bol|bataiye)|में\s*(बोलो|बताओ|समझाओ|बात)|లో\s*(చెప్పు|మాట్లాడు)|లో మాట్లాడ/i;

/** An explicit request to switch language ("talk in English"), or null. */
export function requestedLanguage(text: string): ReplyLanguage | null {
  if (!ASKS_FOR_LANGUAGE.test(text)) return null;
  return NAMES.find(([re]) => re.test(text))?.[1] ?? null;
}

/** The instruction appended to the student's message. */
export function languageNote(lang: ReplyLanguage): string {
  const how =
    lang === "English"
      ? "Write your whole answer in English."
      : lang === "Hinglish"
        ? "Write in Hinglish: Hindi words in Latin letters mixed with English, the way the student talks. Do not answer in plain English."
        : `Write your whole answer in ${lang}, in its own script (English technical terms are fine). Do not answer in English.`;
  return `\n\n[Reply language: ${lang}. ${how}]`;
}

/** TTS voice language for an answer in this language. */
export function ttsLanguageFor(lang: ReplyLanguage | null): SarvamAI.TextToSpeechLanguage | undefined {
  switch (lang) {
    case "Hindi": case "Hinglish": return "hi-IN";
    case "Telugu": return "te-IN";
    case "Tamil": return "ta-IN";
    case "Kannada": return "kn-IN";
    case "Malayalam": return "ml-IN";
    case "Bengali": return "bn-IN";
    case "Gujarati": return "gu-IN";
    case "Punjabi": return "pa-IN";
    case "Odia": return "od-IN";
    case "Marathi": return "mr-IN";
    case "English": return "en-IN";
    default: return undefined;
  }
}
