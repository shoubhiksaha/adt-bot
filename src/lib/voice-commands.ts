/** Things you can say in voice mode that the app handles itself instead of sending to the AI. */
export type VoiceCommand =
  | { type: "stop" }
  | { type: "end" }
  | { type: "standby" }
  | { type: "newChat" }
  | { type: "switchBot"; botId: string }
  | { type: "repeat" }
  | { type: "slower" }
  | { type: "faster" }
  | { type: "search"; query: string }
  | { type: "imagine"; prompt: string };

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PLEASE = "(?:please |can you |could you |would you )?";
const TAIL = "(?: please| now| thanks| thank you)*$";

/**
 * Recognises a spoken command. Only short, whole-utterance phrases count, so a question like
 * "how do I stop a process" still goes to the AI.
 */
export function parseVoiceCommand(text: string, bots: { id: string; name: string; nickname?: string }[]): VoiceCommand | null {
  const t = normalize(text);
  if (!t) return null;
  const test = (pattern: string) => new RegExp(`^${PLEASE}(?:${pattern})${TAIL}`).test(t);

  if (test("stop|stop talking|be quiet|quiet|shut up|enough|cancel|never ?mind|hold on|wait")) return { type: "stop" };
  if (test("goodbye|good bye|bye|bye bye|end voice mode|exit voice mode|close voice mode|stop listening|that's all|that is all|i'm done|we're done")) {
    return { type: "end" };
  }
  if (test("go to sleep|sleep|standby|stand by|pause listening")) return { type: "standby" };
  if (test("new chat|new conversation|start over|start a new chat|clear the chat|reset")) return { type: "newChat" };
  if (test("repeat that|say that again|repeat|come again|what did you say")) return { type: "repeat" };
  if (test("slower|speak slower|talk slower|slow down")) return { type: "slower" };
  if (test("faster|speak faster|talk faster|speed up")) return { type: "faster" };

  const switchTo = /^(?:please )?(?:switch|change|go) to (?:the )?(.+?)(?: bot)?$|^(?:talk|speak|let me talk) to (?:the )?(.+?)(?: bot)?$/.exec(t);
  if (switchTo) {
    const wanted = (switchTo[1] ?? switchTo[2]).trim();
    const bot = bots.find((b) => [b.name, b.nickname].some((n) => n && closeEnough(normalize(n), wanted)));
    if (bot) return { type: "switchBot", botId: bot.id };
  }

  const search = /^(?:please )?(?:search(?: the web| online| google)?(?: for)?|look up|google) (.{3,})$/.exec(t);
  if (search) return { type: "search", query: text.trim().replace(/^.*?\b(?:for|up|google)\b\s*/i, "") || search[1] };

  const imagine = /^(?:please )?(?:imagine|draw|paint|sketch|create an image of|make an image of|generate an image of|make a picture of|show me a picture of) (.{3,})$/.exec(t);
  if (imagine) return { type: "imagine", prompt: imagine[1] };

  return null;
}

const WAKE_PREFIX = /^(?:hey|hi|hello|ok|okay|yo|oi|hay|a|eh)\s+/;

/**
 * Finds a wake phrase ("Hey Jarvis", "Jarvis, …") at the start of an utterance. Speech recognition
 * often mangles short names ("ADT" → "a d t", "80"), so names are compared loosely.
 */
export function matchWakeWord(text: string, names: string[]): { woke: boolean; rest: string } {
  const t = normalize(text);
  const withoutPrefix = t.replace(WAKE_PREFIX, "");
  const hadPrefix = withoutPrefix !== t;
  const words = withoutPrefix.split(" ");

  for (const raw of names) {
    const name = normalize(raw);
    if (!name) continue;
    const nameWords = name.split(" ").length;
    // Try the name as written, and squashed ("a d t" → "adt").
    for (let take = 1; take <= Math.min(words.length, nameWords + 3); take++) {
      const candidate = words.slice(0, take).join(" ");
      if (closeEnough(name, candidate) || closeEnough(name.replace(/ /g, ""), candidate.replace(/ /g, ""))) {
        // Without "hey", only accept the name when it is clearly addressed ("Jarvis, ...").
        if (!hadPrefix && take === words.length && words.length > 1) continue;
        const rest = words.slice(take).join(" ");
        return { woke: true, rest: restoreCase(text, rest) };
      }
    }
  }
  return { woke: false, rest: "" };
}

/** Maps the normalized remainder back to the original wording when possible. */
function restoreCase(original: string, normalizedRest: string): string {
  if (!normalizedRest) return "";
  const words = normalizedRest.split(" ");
  const pattern = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+"), "iu");
  const match = pattern.exec(original.normalize("NFKD").replace(/[̀-ͯ]/g, ""));
  return match ? original.slice(match.index).trim() : normalizedRest;
}

export function closeEnough(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const limit = a.length <= 3 ? 0 : a.length <= 6 ? 1 : 2;
  return Math.abs(a.length - b.length) <= limit && levenshtein(a, b) <= limit;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/** Rough check that a transcript is the bot hearing itself through the speakers. */
export function isEcho(heard: string, spoken: string): boolean {
  const h = normalize(heard).split(" ").filter((w) => w.length > 2);
  if (!h.length) return true;
  const s = new Set(normalize(spoken).split(" "));
  const overlap = h.filter((w) => s.has(w)).length / h.length;
  return overlap >= 0.6;
}

/**
 * Whisper invents short phrases from noise or silence ("Thank you.", "Thanks for watching!",
 * "Love you.", "[Music]"). These are dropped instead of being treated as the user speaking.
 */
const HALLUCINATIONS =
  /^(?:thank you(?: (?:so much|very much|for watching|for listening))?|thanks(?: for watching| for listening)?|love you(?: \w+)?|bye|you|oh|ah|uh|um|hmm|mm|so|the|i|amen|music|applause|laughter|silence|subtitles.*|please subscribe.*|see you(?: next time| later)?)$/;

export function isLikelyHallucination(text: string): boolean {
  if (/^\s*[[(*♪].*[\])*♪]\s*$/.test(text)) return true; // [Music], (silence), ♪ ♪
  const t = normalize(text);
  return !t || HALLUCINATIONS.test(t);
}

/** Enough real words to count as the user cutting in (single words are usually noise or echo). */
export function isSubstantial(text: string): boolean {
  return normalize(text).split(" ").filter((w) => w.length > 2).length >= 3;
}
