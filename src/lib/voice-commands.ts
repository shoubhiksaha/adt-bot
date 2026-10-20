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

/** Two words that speech-to-text could have heard for each other ("Rome" / "room", "Sayan" / "Sayen"). */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  const allowed = longest >= 6 ? 2 : longest >= 4 ? 1 : 0;
  if (allowed && Math.abs(a.length - b.length) <= allowed && editDistance(a, b) <= allowed) return true;
  const sa = skeleton(a);
  return sa.length >= 2 && sa === skeleton(b);
}

/** Consonants only, doubled letters merged, a few sounds folded together: "rome" and "room" → "rm". */
function skeleton(word: string): string {
  return word
    .replace(/ph/g, "f")
    .replace(/[ckq]/g, "k")
    .replace(/[sz]/g, "s")
    .replace(/[aeiouy'h]/g, "")
    .replace(/(.)\1+/g, "$1");
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** Words in what was heard that the bot didn't just say (allowing for speech-to-text slips). */
export function newWords(heard: string, spoken: string): string[] {
  const said = [...new Set(normalize(spoken).split(" ").filter((w) => w.length > 2))];
  return normalize(heard)
    .split(" ")
    .filter((w) => w.length > 2 && !said.some((s) => similar(s, w)));
}

/**
 * Heard while (or just after) the bot talked: the user's words in it, or null when it's only the
 * bot's own voice coming back through the microphone, maybe garbled ("Here's Rome" heard as "20
 * years' room"). An echo that runs into the user talking over it ("…Romulus founded it. Tell me
 * about Paris") gives back the user's part. The user's words are mostly ones the bot didn't say.
 */
export function userPart(heard: string, spoken: string): string | null {
  const own = withoutLeadingEcho(heard, spoken);
  const words = normalize(own)
    .split(" ")
    .filter((w) => w.length > 2);
  if (!words.length) return null;
  const fresh = newWords(own, spoken).length;
  const share = fresh / words.length;
  // After a run of echo, a stray misheard word isn't the user: they said at least two new things.
  if (own !== heard.trim()) return fresh >= 2 && share >= 0.5 ? own : null;
  return (fresh >= 3 && share >= 0.34) || (fresh >= 1 && share >= 0.6) ? own : null;
}

/** For a live caption while the bot talks: the user cutting in says at least two new words. */
export function soundsLikeUser(heard: string, spoken: string): boolean {
  const own = userPart(heard, spoken);
  return own !== null && newWords(own, spoken).length >= 2;
}

/**
 * The bot's echo and the user talking over it often arrive as one stretch of speech: drop the
 * leading words the bot said, so "…Romulus founded it. Tell me about Paris" becomes "Tell me
 * about Paris".
 */
export function withoutLeadingEcho(heard: string, spoken: string): string {
  const said = [...new Set(normalize(spoken).split(" ").filter((w) => w.length > 2))];
  const tokens = heard.trim().split(/\s+/);
  const isNew = (token: string) => {
    const w = normalize(token);
    return w.length > 2 && !said.some((s) => similar(s, w));
  };
  for (let i = 0; i < tokens.length; i++) {
    // The user's part starts at two new words in a row (short words in between don't count).
    if (!isNew(tokens[i])) continue;
    const next = tokens.slice(i + 1).find((t) => normalize(t).length > 2);
    if (!next || isNew(next)) {
      // An echo is a run of the bot's words; one look-alike word ("wait" / "with") isn't.
      const echoed = tokens.slice(0, i).filter((t) => normalize(t).length > 2).length;
      return echoed >= 3 ? tokens.slice(i).join(" ") : heard.trim();
    }
  }
  return heard.trim();
}

/**
 * Stricter than isEcho, for sound that starts a little after the bot stopped (speaker delay,
 * Bluetooth, a room's reverb): at least four heard words must follow the bot's last words in the
 * same order. A quick real reply ("yes, send it") doesn't, so it still gets through.
 */
export function echoesLastWords(heard: string, spoken: string): boolean {
  const h = normalize(heard).split(" ").filter(Boolean);
  if (h.length < 4) return false;
  const s = normalize(spoken).split(" ").filter(Boolean).slice(-60);
  // Most heard words found in order in what was just said, ending near its end (a late echo is
  // always the last words).
  let best = 0;
  for (let start = 0; start < s.length; start++) {
    let i = 0;
    let last = -1;
    for (let j = start; j < s.length && i < h.length; j++) {
      if (s[j] === h[i] || near(s[j], h[i])) {
        i++;
        last = j;
      }
    }
    if (last >= s.length - 15) best = Math.max(best, i);
    if (best === h.length) break;
  }
  return best / h.length >= 0.75;
}

/** Speech-to-text often hears a word slightly differently ("Sayan" / "Sayen"). */
function near(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let diff = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return true;
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

const YES = /^(yes|yeah|yea|yep|yup|sure|ok|okay|alright|go ahead|do it|allow( it)?|please do|of course|haan?|ha|hya|ji( haan)?|theek hai|thik ache|thik ase|korো|kor)\b/;
const NO = /^(no|nope|nah|don'?t|do not|stop|cancel|deny|never ?mind|nahi|nahin|na|naa|mat( karo)?|thak|dorkar nei)\b/;

/** A spoken answer to "Can I …? Say yes or no.": "allow", "deny", or null when it's neither. */
export function yesOrNo(text: string): "allow" | "deny" | null {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 8) return null;
  const yes = YES.test(t);
  const no = NO.test(t);
  // "Yes… no, wait": unclear, so ask again rather than guess.
  const mixed = (yes && /\b(no|not|don'?t|nahi|nahin)\b/.test(t)) || (no && /\b(yes|yeah|sure|okay|ok|haan)\b/.test(t));
  if (mixed || yes === no) return null;
  return yes ? "allow" : "deny";
}

