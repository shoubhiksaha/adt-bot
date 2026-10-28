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

  // Cutting in is often a few words together: "wait, stop", "okay okay stop", "no, hold on".
  const STOPS = "stop|stop talking|stop it|be quiet|quiet|shut up|enough|cancel|never ?mind|hold on|hang on|wait|wait a (?:second|sec|minute)";
  if (new RegExp(`^${PLEASE}(?:(?:ok|okay|no|hey|oh|um|uh|wait|sorry|actually) )*(?:${STOPS})(?: (?:${STOPS}|please|now|thanks|thank you))*$`).test(t)) return { type: "stop" };
  if (test("goodbye|good bye|bye|bye bye|end voice mode|exit voice mode|close voice mode|stop listening|that's all|that is all|i'm done|we're done") || endsVoiceMode(t)) {
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

type WakeBot = { name: string; nickname?: string; wakePhrase?: string };

/** What wakes a bot, as shown to the user: the phrase it was given, or "Hey <nickname>". */
export function wakePhraseOf(bot: WakeBot | undefined): string {
  return bot?.wakePhrase?.trim() || `Hey ${bot?.nickname?.trim() || bot?.name || "ADT"}`;
}

/** The bot's own wake phrase at the start of what was said, or "Hey <nickname or name>" when it has none. */
export function matchBotWake(text: string, bot: WakeBot): { woke: boolean; rest: string } {
  const phrase = bot.wakePhrase?.trim();
  if (phrase) return matchWakePhrase(text, phrase);
  return matchWakeWord(text, [bot.nickname?.trim(), bot.name].filter((n): n is string => Boolean(n)));
}

/**
 * A wake phrase the person chose ("Computer", "Wake up Friday"): at the start of what was said, alone
 * or before a request, with or without a greeting first, and compared loosely like names.
 */
export function matchWakePhrase(text: string, phrase: string): { woke: boolean; rest: string } {
  const wanted = normalize(phrase);
  const t = normalize(text);
  if (!wanted || !t) return { woke: false, rest: "" };
  const size = wanted.split(" ").length;
  for (const said of new Set([t, t.replace(WAKE_PREFIX, "")])) {
    const words = said.split(" ");
    for (let take = Math.max(1, size - 1); take <= Math.min(words.length, size + 2); take++) {
      const candidate = words.slice(0, take).join(" ");
      // Squashed for a phrase heard in pieces ("wake up fry day"), but starting the same ("my computer" isn't "computer").
      const squashed = candidate[0] === wanted[0] && closeEnough(wanted.replace(/ /g, ""), candidate.replace(/ /g, ""));
      if (closeEnough(wanted, candidate) || squashed) return { woke: true, rest: restoreCase(text, words.slice(take).join(" ")) };
    }
  }
  return { woke: false, rest: "" };
}

/**
 * Closing voice mode in the user's own words, said anywhere in a short sentence: "you are done for
 * now, now you can exit the voice mode", "close voice", "turn off voice mode". A question about it
 * ("how do I exit voice mode?") isn't a request to close it.
 */
function endsVoiceMode(t: string): boolean {
  if (t.split(" ").length > 14 || /^(how|what|why|when|where|can i|does|do i|is it)\b/.test(t)) return false;
  return /\b(exit|close|end|quit|leave|stop|turn off|switch off|shut down|finish)\b(?: the| this)? voice(?: mode| chat| conversation)?\b/.test(t);
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

/**
 * Content words: not the short ones (they say little about who spoke) and not numbers, which
 * speech-to-text writes either way ("third" / "3rd", "seven fifty-three" / "753").
 */
const isContent = (w: string) => w.length > 2 && !/\d/.test(w);
const content = (text: string) => normalize(text).split(" ").filter(isContent);

/**
 * Which heard words line up, in order, with what the bot said (allowing for speech-to-text slips):
 * a longest common subsequence. The bot's echo lines up almost entirely, even garbled; someone
 * talking over it doesn't, even when they reuse a word or two of the bot's.
 */
function alignedFlags(heard: string[], spoken: string[]): boolean[] {
  const n = heard.length;
  const m = spoken.length;
  const table = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = similar(heard[i], spoken[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const flags = new Array<boolean>(n).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (similar(heard[i], spoken[j]) && table[i][j] === table[i + 1][j + 1] + 1) {
      flags[i] = true;
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return flags;
}

/**
 * The bot's words, word for word (four or more), then one or two misheard ones that start like its
 * next word ("Rome began as a song set" for "Rome began as a small settlement"): its echo, garbled
 * at the end. A short cut-in after the echo ("…small settlement, no wait go back") isn't.
 */
function garbledEchoTail(heard: string, spoken: string): boolean {
  const h = normalize(heard).split(" ").filter(Boolean);
  const s = normalize(spoken).split(" ").filter(Boolean).slice(-200);
  let lead = 0;
  let next = "";
  for (let j = 0; j < s.length; j++) {
    let k = 0;
    while (k < h.length && j + k < s.length && h[k] === s[j + k]) k++;
    if (k > lead) {
      lead = k;
      next = s[j + k] ?? "";
    }
  }
  const tail = h.slice(lead);
  return lead >= 4 && tail.length > 0 && tail.length <= 2 && Boolean(next) && tail[0][0] === next[0] && !parseVoiceCommand(tail.join(" "), []);
}

/** What the bot said lately, as content words (enough for any echo still in the room). */
const spokenWords = (spoken: string) => content(spoken).slice(-160);

/**
 * An answer said over the bot's question that came back with it in one stretch ("Can I run a
 * command? Yes, go ahead"): the sentences after the question's own. Only with a word of their own:
 * a bare "Yes." could be its "Say yes or no" coming back misheard. Null when there's no such part.
 */
export function answerAfterEcho(heard: string, question: string): string | null {
  const sentences = (heard.match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  let echoed = 0;
  while (echoed < sentences.length && isEcho(sentences[echoed], question)) echoed++;
  if (!echoed || echoed === sentences.length) return null;
  const rest = sentences.slice(echoed).join(" ");
  const asked = new Set(normalize(question).split(" "));
  return normalize(rest)
    .split(" ")
    .some((w) => w && !asked.has(w))
    ? rest
    : null;
}

/** Heard words that don't line up with what the bot said: the user's own. */
export function newWords(heard: string, spoken: string): string[] {
  const words = content(heard);
  const flags = alignedFlags(words, spokenWords(spoken));
  return words.filter((_, i) => !flags[i]);
}

/**
 * Heard while (or just after) the bot talked: the user's words in it, or null when it's only the
 * bot's own voice coming back through the microphone, maybe garbled ("Here's Rome" heard as "20
 * years' room"). An echo that runs into the user talking over it ("…Romulus founded it. Tell me
 * about Paris") gives back the user's part.
 */
export function userPart(heard: string, spoken: string): string | null {
  if (garbledEchoTail(heard, spoken)) return null;
  const own = withoutTrailingEcho(withoutLeadingEcho(heard, spoken), spoken);
  const words = content(own);
  if (!words.length) return null;
  const said = spokenWords(spoken);
  // One word is too little to call a misheard echo: only an exact repeat of the bot's counts.
  if (words.length === 1) return said.includes(words[0]) && own === heard.trim() ? null : own;
  const fresh = words.length - alignedFlags(words, said).filter(Boolean).length;
  return fresh >= 2 && fresh / words.length >= 0.4 ? own : null;
}

/**
 * For a live caption while the bot talks: someone cutting in says at least three words of their own,
 * and they're the latest words. A caption still ending in the bot's own words is its echo, however
 * misheard the middle is (long echoes come back with garbled words).
 */
export function soundsLikeUser(heard: string, spoken: string): boolean {
  if (withoutTrailingEcho(heard, spoken) !== heard.trim()) return false;
  const own = userPart(heard, spoken);
  // Three words of their own: two misheard echo words ("and island island") come back too easily.
  return own !== null && newWords(own, spoken).length >= 3;
}

/**
 * The other end: the bot kept talking (or echoing) after the user's words, so the stretch ends with
 * a run of the bot's words again. Drop that run (three words or more) after the user's last two.
 */
export function withoutTrailingEcho(heard: string, spoken: string): string {
  const tokens = heard.trim().split(/\s+/);
  const words = tokens.map((t) => normalize(t)).map((w) => (isContent(w) ? w : ""));
  const contentIndex = words.flatMap((w, i) => (w ? [i] : []));
  const flags = alignedFlags(
    contentIndex.map((i) => words[i]),
    spokenWords(spoken),
  );
  let end = -1;
  for (let k = flags.length - 1; k > 0; k--) {
    if (!flags[k] && !flags[k - 1]) {
      end = k;
      break;
    }
  }
  // Forward over the user's words and lone words of the bot's among them, as at the start.
  while (end >= 0 && end + 1 < flags.length && (!flags[end + 1] || (end + 2 < flags.length && !flags[end + 2]))) end++;
  if (end < 0 || flags.length - 1 - end < 3) return heard.trim();
  return tokens.slice(0, contentIndex[end] + 1).join(" ");
}

/**
 * The bot's echo and the user talking over it often arrive as one stretch of speech: drop the
 * leading part that lines up with what the bot said (at least three words of it), so "…Romulus
 * founded it. Tell me about Paris" becomes "Tell me about Paris".
 */
export function withoutLeadingEcho(heard: string, spoken: string): string {
  const tokens = heard.trim().split(/\s+/);
  const said = spokenWords(spoken);
  const words = tokens.map((t) => normalize(t)).map((w) => (isContent(w) ? w : ""));
  const contentIndex = words.flatMap((w, i) => (w ? [i] : []));
  const flags = alignedFlags(
    contentIndex.map((i) => words[i]),
    said,
  );
  // The echo is the run of lined-up words at the start; the user starts at two unaligned in a row
  // (one stray word at the end is a mishearing, not someone talking).
  let cut = -1;
  for (let k = 0; k + 1 < flags.length; k++) {
    if (!flags[k] && !flags[k + 1]) {
      cut = k;
      break;
    }
  }
  // Walk back over the user's own words, and over a lone word of the bot's among them ("Tell me
  // about Paris": the bot said "about" too); the echo is a run of the bot's words.
  let start = cut;
  while (start > 0 && (!flags[start - 1] || (start - 2 >= 0 && !flags[start - 2]))) start--;
  if (start < 3) return heard.trim();
  let from = contentIndex[start];
  // A last echo word before a full stop ("…in September. Wait, stop.") isn't the user's.
  if (/[.!?]$/.test(tokens[from]) && from + 1 < tokens.length) from++;
  return tokens.slice(from).join(" ");
}

/**
 * Stricter than isEcho, for sound that starts a little after the bot stopped (speaker delay,
 * Bluetooth, a room's reverb): at least four heard words must follow the bot's last words in the
 * same order. A quick real reply ("yes, send it") doesn't, so it still gets through.
 */
export function echoesLastWords(heard: string, spoken: string): boolean {
  const h = normalize(heard).split(" ").filter(Boolean);
  if (h.length < 4) return false;
  // A late echo is always the last words said: look back only a little further than it is long.
  const s = normalize(spoken).split(" ").filter(Boolean).slice(-(Math.ceil(h.length * 1.5) + 8));
  // "Yes, the message to Sayan was the right one": an answer that repeats the bot's words starts
  // with one the bot didn't say.
  if ((YES.test(h[0]) || NO.test(h[0])) && !s.some((w) => similar(w, h[0]))) return false;
  // Most heard words found in order, allowing for words misheard ("with a chance" for "with the
  // chance"), and ending near the end of what was said.
  const { count, last } = latestAlignment(h, s);
  return last >= s.length - 15 && count / h.length >= 0.75;
}

/** How many heard words line up, in order, with what was said, and where the last one is (as late as possible). */
function latestAlignment(heard: string[], spoken: string[]): { count: number; last: number } {
  const n = heard.length;
  const m = spoken.length;
  const table = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      table[i][j] = similar(heard[i - 1], spoken[j - 1]) ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  // Walk back from the end, skipping heard words before spoken ones, so the last match is the latest.
  for (let i = n, j = m; i > 0 && j > 0; ) {
    if (similar(heard[i - 1], spoken[j - 1]) && table[i][j] === table[i - 1][j - 1] + 1) return { count: table[n][m], last: j - 1 };
    if (table[i - 1][j] >= table[i][j - 1]) i--;
    else j--;
  }
  return { count: 0, last: -1 };
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
  // One word over and over ("foreign foreign foreign"): what speech models make of noise. Not "no
  // no no" or "stop stop stop": people say those.
  const repeated = /^(\S+)(?: \1){2,}$/.exec(t)?.[1];
  if (repeated && !/^(no|nope|yes|yeah|yep|stop|wait|ok|okay|hey|hello|hi|please)$/.test(repeated) && !parseVoiceCommand(t, [])) return true;
  return !t || HALLUCINATIONS.test(t) || t === "foreign";
}

/** Enough real words to count as the user cutting in (single words are usually noise or echo). */
export function isSubstantial(text: string): boolean {
  return normalize(text).split(" ").filter((w) => w.length > 2).length >= 3;
}

const YES =
  /^(yes|yeah|yea|yep|yup|sure|ok|okay|alright|all right|go ahead|go for it|do it|just do it|do (?:all of )?(?:it|that|this|them|everything|all)|allow( it)?|approved?|confirm(ed)?|proceed|carry on|please do|of course|absolutely|definitely|you can|you may|haan?|ha|hya|ji( haan)?|theek hai|thik ache|thik ase|korো|kor)\b/;
/** "Don't ask me again", "no need to ask": a go-ahead, not a no. */
const DONT_ASK = /\b(?:don'?t|do not|no need to|stop) (?:ask|asking|check|checking)(?: me)?(?:(?: to)? (?:approve|confirm)| for (?:approval|permission))?(?: (?:anything|everything|again))?\b/g;
/** A long answer that starts with a yes is still a yes, unless it hesitates or says no anywhere. */
const HESITANT = /\?|\b(but|wait|hold on|hang on|not yet|later|first|before|unless|maybe|don'?t|do not|not|no|nope|stop|cancel|never ?mind|nahi|nahin)\b/;
const NO = /^(no|nope|nah|don'?t|do not|stop|cancel|deny|never ?mind|nahi|nahin|na|naa|mat( karo)?|thak|dorkar nei)\b/;

/**
 * Not an answer yet: a question ("what will it delete?"), a pause ("ok, hold on", "wait"), or a
 * condition ("sure, but first…", "do it later"). These start like a yes but aren't one.
 */
const NOT_YET =
  /\?|\b(what|why|how|which|when|where|who|wait|hold on|hang on|one (sec|second|moment|minute)|just a (sec|second|moment|minute)|let me|later|first|before|but|unless|if|not yet|maybe|tell me|explain|ruko|ek minute|dara(o)?|ektu)\b/;

/** A spoken answer to "Can I …? Say yes or no.": "allow", "deny", or null when it's neither. */
export function yesOrNo(text: string): "allow" | "deny" | null {
  const raw = text.toLowerCase();
  const t = raw.replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
  // A clear answer is short; anything longer, questioning or hesitant is asked again.
  if (!t || t.split(" ").length > 6 || NOT_YET.test(raw.replace(/[^\p{L}\p{N}'? ]+/gu, " "))) return null;
  const yes = YES.test(t);
  const no = NO.test(t);
  // "Yes… no, wait": unclear, so ask again rather than guess.
  const mixed = (yes && /\b(no|not|don'?t|nahi|nahin)\b/.test(t)) || (no && /\b(yes|yeah|sure|okay|ok|haan)\b/.test(t));
  if (mixed || yes === no) return null;
  return yes ? "allow" : "deny";
}

/**
 * The answer to a spoken "Can I …?" in the user's own words: a clear short yes or no (yesOrNo), or a
 * longer sentence that opens with a yes and never hesitates ("Yes, you can clear it and also see if
 * there's more to free up"; "do all of it and don't ask me to approve anything"). `rest` is what
 * they asked for on top, to do once this step is done.
 */
export function approvalAnswer(text: string): { answer: "allow" | "deny" | null; rest: string } {
  const short = yesOrNo(text);
  if (short) return { answer: short, rest: "" };
  const raw = text.toLowerCase().replace(DONT_ASK, " ");
  const t = raw.replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
  const yes = YES.exec(t);
  if (!yes || HESITANT.test(raw.replace(/[^\p{L}\p{N}'? ]+/gu, " "))) return { answer: null, rest: "" };
  // What follows the opening yes ("Yes, you can clear it and also…"), from the original wording.
  const after = text
    .replace(/^[^\p{L}\p{N}]*/u, "")
    .slice(yes[0].length)
    .replace(new RegExp(DONT_ASK.source, "gi"), " ")
    .replace(/^[\s,.;:!-]+(?:and |also |then |plus )*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return { answer: "allow", rest: isSubstantial(after) ? after : "" };
}

/** "…and it started as a small kingdom. Stop": a stop said at the end of what was heard, after an echo. */
export function endsWithStop(text: string): boolean {
  const words = normalize(text).split(" ").filter(Boolean);
  for (let n = 1; n <= Math.min(4, words.length); n++) {
    if (parseVoiceCommand(words.slice(-n).join(" "), [])?.type === "stop") return true;
  }
  return false;
}

