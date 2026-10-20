// Gemini Live (the Live API): one WebSocket that takes the microphone as 16 kHz PCM and answers with
// 24 kHz speech, transcripts both ways and tool calls. The protocol only; voice mode drives it
// (live-session.ts). https://ai.google.dev/api/live
import { geminiSchema } from "./llm";
import type { ToolSchema } from "./agent/vendor/openbot/types";

export const LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const LIVE_MODELS = [
  { id: "gemini-3.8-live", label: "Gemini 3.8 Live (fastest replies)" },
  { id: "gemini-3.8-live-extended-thinking", label: "Gemini 3.8 Live Extended Thinking (thinks in the background)" },
];

/** The prebuilt voices, with Google's one-word descriptions. */
export const LIVE_VOICES: { name: string; style: string }[] = [
  { name: "Kore", style: "Firm" },
  { name: "Puck", style: "Upbeat" },
  { name: "Zephyr", style: "Bright" },
  { name: "Charon", style: "Informative" },
  { name: "Fenrir", style: "Excitable" },
  { name: "Leda", style: "Youthful" },
  { name: "Orus", style: "Firm" },
  { name: "Aoede", style: "Breezy" },
  { name: "Callirrhoe", style: "Easy-going" },
  { name: "Autonoe", style: "Bright" },
  { name: "Enceladus", style: "Breathy" },
  { name: "Iapetus", style: "Clear" },
  { name: "Umbriel", style: "Easy-going" },
  { name: "Algieba", style: "Smooth" },
  { name: "Despina", style: "Smooth" },
  { name: "Erinome", style: "Clear" },
  { name: "Algenib", style: "Gravelly" },
  { name: "Rasalgethi", style: "Informative" },
  { name: "Laomedeia", style: "Upbeat" },
  { name: "Achernar", style: "Soft" },
  { name: "Alnilam", style: "Firm" },
  { name: "Schedar", style: "Even" },
  { name: "Gacrux", style: "Mature" },
  { name: "Pulcherrima", style: "Forward" },
  { name: "Achird", style: "Friendly" },
  { name: "Zubenelgenubi", style: "Casual" },
  { name: "Vindemiatrix", style: "Gentle" },
  { name: "Sadachbia", style: "Lively" },
  { name: "Sadaltager", style: "Knowledgeable" },
  { name: "Sulafat", style: "Warm" },
];

/** What Gemini Live costs per minute of audio (Google's price list, September 2026). */
export const LIVE_PRICE = { inputPerMin: 0.005, outputPerMin: 0.018 };

export type LiveSetup = {
  model: string;
  system: string;
  tools: ToolSchema[];
  voice: string;
  /** The chat so far, sent once after setup so the conversation carries on. */
  history?: { role: "user" | "model"; text: string }[];
  /** Carry on a session after a reconnect (from a "sessionResumptionUpdate"). */
  resumeHandle?: string;
  /** Google Search grounding (the app's own web_search tool is left out then). */
  googleSearch?: boolean;
};

/**
 * Tools run in the background while the model keeps talking (NON_BLOCKING): a task on the Mac
 * takes seconds, and the conversation shouldn't freeze for it.
 */
export function functionDeclarations(tools: ToolSchema[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters), behavior: "NON_BLOCKING" }));
}

export function setupMessage(setup: LiveSetup) {
  const tools: unknown[] = [];
  if (setup.googleSearch) tools.push({ googleSearch: {} });
  if (setup.tools.length) tools.push({ functionDeclarations: functionDeclarations(setup.tools) });
  return {
    setup: {
      model: setup.model.startsWith("models/") ? setup.model : `models/${setup.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: setup.voice || "Kore" } } },
      },
      systemInstruction: { parts: [{ text: setup.system }] },
      ...(tools.length ? { tools } : {}),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Older turns are summarised away instead of the session ending at its size limit.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: setup.resumeHandle ? { handle: setup.resumeHandle } : {},
      // The chat so far is sent as client content right after setup (a resumed session has it).
      ...(setup.history?.length && !setup.resumeHandle ? { historyConfig: { initialHistoryInClientContent: true } } : {}),
    },
  };
}

/** The chat so far, as the turns that follow setup. Ends on a finished turn. */
export function historyMessage(history: { role: "user" | "model"; text: string }[]) {
  return {
    clientContent: {
      turns: history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
      turnComplete: true,
    },
  };
}

export type LiveCall = { id: string; name: string; args: Record<string, unknown> };

export type LiveEvent =
  | { type: "ready" }
  /** Base64 16-bit PCM at `rate` Hz. */
  | { type: "audio"; data: string; rate: number }
  /** What the user said, a piece at a time. */
  | { type: "input"; text: string }
  /** What the model is saying, a piece at a time. */
  | { type: "output"; text: string }
  /** The user talked over the model: its reply is dropped from here on. */
  | { type: "interrupted" }
  | { type: "turnComplete" }
  | { type: "toolCall"; calls: LiveCall[] }
  | { type: "toolCancel"; ids: string[] }
  /** The server will close the connection soon: reconnect with the latest handle. */
  | { type: "goAway"; timeLeftMs: number }
  | { type: "resume"; handle: string }
  | { type: "error"; message: string };

const seconds = (value: unknown) => {
  const match = /^([\d.]+)s$/.exec(String(value ?? ""));
  return match ? Math.round(Number(match[1]) * 1000) : 0;
};

type Transcript = { text?: string };
type ServerMessage = {
  setupComplete?: object;
  serverContent?: {
    inputTranscription?: Transcript;
    outputTranscription?: Transcript;
    modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: unknown }[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  error?: { message?: string };
};

/** One server message as the events voice mode handles, in order. */
export function parseServerMessage(message: unknown): LiveEvent[] {
  if (!message || typeof message !== "object") return [];
  const m = message as ServerMessage;
  const events: LiveEvent[] = [];
  if (m.setupComplete) events.push({ type: "ready" });
  const content = m.serverContent;
  if (content) {
    if (content.inputTranscription?.text) events.push({ type: "input", text: String(content.inputTranscription.text) });
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part?.inlineData;
      if (data?.data && /^audio\//.test(String(data.mimeType ?? "audio/pcm"))) {
        const rate = Number(/rate=(\d+)/.exec(String(data.mimeType ?? ""))?.[1] ?? 24000);
        events.push({ type: "audio", data: String(data.data), rate });
      }
    }
    if (content.outputTranscription?.text) events.push({ type: "output", text: String(content.outputTranscription.text) });
    if (content.interrupted) events.push({ type: "interrupted" });
    if (content.turnComplete) events.push({ type: "turnComplete" });
  }
  if (m.toolCall?.functionCalls?.length) {
    events.push({
      type: "toolCall",
      calls: m.toolCall.functionCalls.map((c) => ({
        id: String(c.id ?? ""),
        name: String(c.name ?? ""),
        args: c.args && typeof c.args === "object" ? (c.args as Record<string, unknown>) : {},
      })),
    });
  }
  if (m.toolCallCancellation?.ids?.length) events.push({ type: "toolCancel", ids: m.toolCallCancellation.ids.map(String) });
  if (m.goAway) events.push({ type: "goAway", timeLeftMs: seconds(m.goAway.timeLeft) });
  if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) events.push({ type: "resume", handle: String(m.sessionResumptionUpdate.newHandle) });
  if (m.error?.message) events.push({ type: "error", message: String(m.error.message) });
  return events;
}

// Audio ------------------------------------------------------------------------------------------

/** Microphone samples (−1…1) as base64 little-endian 16-bit PCM. */
export function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Base64 little-endian 16-bit PCM as samples (−1…1). */
export function pcm16Samples(base64: string): Float32Array {
  const binary = atob(base64);
  const count = binary.length >> 1;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    if (value >= 0x8000) value -= 0x10000;
    out[i] = value / 0x8000;
  }
  return out;
}

// Connection -------------------------------------------------------------------------------------

/** Why a connection closed, in words (the server puts the reason in the close frame). */
export function closeReason(code: number, reason: string): string {
  if (/api key|permission|unauthori[sz]ed|forbidden/i.test(reason)) return `Gemini Live refused the API key: ${reason}`;
  if (/not found|not supported|unknown model/i.test(reason)) return `Gemini Live: ${reason}. Pick another model in Settings → Voice.`;
  if (/quota|rate|exhausted/i.test(reason)) return `Gemini Live is over its quota: ${reason}`;
  if (reason) return `Gemini Live closed the connection: ${reason}`;
  return code === 1006 ? "Lost the connection to Gemini Live. Check the internet connection." : `Gemini Live closed the connection (${code}).`;
}

export type LiveConnectionOptions = {
  key: string;
  setup: LiveSetup;
  onEvent: (event: LiveEvent) => void;
  /** After open() resolved: the connection ended (not by close()). */
  onClose: (info: { code: number; reason: string }) => void;
  /** Tests point this at a fake server. */
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  setupTimeoutMs?: number;
};

export class LiveConnection {
  private socket: WebSocket | null = null;
  private closedByUs = false;

  constructor(private options: LiveConnectionOptions) {}

  /** Connects and sends the setup; resolves once the server accepted it. */
  open(): Promise<void> {
    const { key, setup, onEvent } = this.options;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const url = `${this.options.url ?? LIVE_ENDPOINT}?key=${encodeURIComponent(key)}`;
    return new Promise((resolve, reject) => {
      let ready = false;
      const socket = new Impl(url);
      // No answer to the setup: give up rather than show "Getting ready…" forever.
      const timer = setTimeout(() => {
        if (ready) return;
        reject(new Error("Gemini Live didn't answer. Check the internet connection, then try again."));
        this.closedByUs = true;
        socket.close();
      }, this.options.setupTimeoutMs ?? 15_000);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => this.send(setupMessage(setup));
      // Synchronous, so messages are handled in the order they came (binaryType makes frames ArrayBuffers).
      socket.onmessage = (event) => {
        const raw = event.data;
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
        let message: unknown;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        for (const e of parseServerMessage(message)) {
          if (e.type === "ready" && !ready) {
            ready = true;
            clearTimeout(timer);
            if (setup.history?.length && !setup.resumeHandle) this.send(historyMessage(setup.history));
            resolve();
          }
          onEvent(e);
        }
      };
      socket.onerror = () => undefined;
      socket.onclose = (event) => {
        this.socket = null;
        clearTimeout(timer);
        if (!ready) reject(new Error(closeReason(event.code, event.reason)));
        else if (!this.closedByUs) this.options.onClose({ code: event.code, reason: event.reason });
      };
    });
  }

  private send(message: unknown) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  sendAudio(base64: string) {
    this.send({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: base64 } } });
  }

  /** The microphone paused (muted): the server shouldn't wait for more of this turn. */
  audioEnded() {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /** A picture the model should see (a screenshot a tool took). */
  sendImage(mediaType: string, data: string) {
    this.send({ realtimeInput: { video: { mimeType: mediaType, data } } });
  }

  /** A note for the model, as the user's turn (the app speaking, e.g. "ask the user first"). */
  sendText(text: string) {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
  }

  sendToolResponses(responses: { id: string; name: string; response: Record<string, unknown>; scheduling?: "INTERRUPT" | "WHEN_IDLE" | "SILENT" }[]) {
    this.send({ toolResponse: { functionResponses: responses } });
  }

  close() {
    this.closedByUs = true;
    this.socket?.close();
    this.socket = null;
  }
}
