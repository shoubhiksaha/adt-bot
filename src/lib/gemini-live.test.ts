// Gemini Live protocol: the setup the server gets, how its messages are read, audio encoding, and the
// connection's handshake.
import { describe, expect, it } from "vitest";
import { closeReason, functionDeclarations, historyMessage, LiveConnection, parseServerMessage, pcm16Base64, pcm16Samples, setupMessage } from "./gemini-live";

const tool = {
  name: "save_note",
  description: "Saves a note",
  parameters: { type: "object" as const, properties: { text: { type: "string", default: "" } }, required: ["text"], additionalProperties: false },
};

describe("setup", () => {
  it("asks for speech with transcripts both ways, the chosen voice, tools and Google Search", () => {
    const { setup } = setupMessage({ model: "gemini-3.8-live", system: "Be brief.", tools: [tool], voice: "Puck", googleSearch: true });
    expect(setup.model).toBe("models/gemini-3.8-live");
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    expect(setup.systemInstruction).toEqual({ parts: [{ text: "Be brief." }] });
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(setup.sessionResumption).toEqual({});
    expect(setup.tools).toEqual([{ googleSearch: {} }, { functionDeclarations: functionDeclarations([tool]) }]);
    // Gemini 3.8 Live rejects a thinking level; it isn't sent.
    expect(JSON.stringify(setup)).not.toMatch(/thinking/i);
  });

  it("declares tools as non-blocking, without JSON-Schema keywords Gemini rejects", () => {
    expect(functionDeclarations([tool])).toEqual([
      { name: "save_note", description: "Saves a note", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, behavior: "NON_BLOCKING" },
    ]);
  });

  it("sends the chat so far after setup, but not when resuming a session that already has it", () => {
    const history = [
      { role: "user" as const, text: "Hi" },
      { role: "model" as const, text: "Hello!" },
    ];
    expect(setupMessage({ model: "m", system: "", tools: [], voice: "Kore", history }).setup.historyConfig).toEqual({ initialHistoryInClientContent: true });
    const resumed = setupMessage({ model: "m", system: "", tools: [], voice: "Kore", history, resumeHandle: "h1" }).setup;
    expect(resumed.historyConfig).toBeUndefined();
    expect(resumed.sessionResumption).toEqual({ handle: "h1" });
    expect(historyMessage(history)).toEqual({
      clientContent: {
        turns: [
          { role: "user", parts: [{ text: "Hi" }] },
          { role: "model", parts: [{ text: "Hello!" }] },
        ],
        turnComplete: true,
      },
    });
  });
});

describe("server messages", () => {
  it("reads speech, transcripts, interruptions and the end of a turn in order", () => {
    expect(parseServerMessage({ setupComplete: {} })).toEqual([{ type: "ready" }]);
    expect(
      parseServerMessage({
        serverContent: {
          inputTranscription: { text: "What's the weather" },
          modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } }, { text: "thought" }] },
          outputTranscription: { text: "It's sunny" },
          turnComplete: true,
        },
      }),
    ).toEqual([
      { type: "input", text: "What's the weather" },
      { type: "audio", data: "AAA=", rate: 24000, mime: "audio/pcm;rate=24000" },
      { type: "output", text: "It's sunny" },
      { type: "turnComplete" },
    ]);
    expect(parseServerMessage({ serverContent: { interrupted: true } })).toEqual([{ type: "interrupted" }]);
  });

  it("reads tool calls, cancellations, the warning before a disconnect and the way back", () => {
    expect(parseServerMessage({ toolCall: { functionCalls: [{ id: "c1", name: "save_note", args: { text: "milk" } }] } })).toEqual([
      { type: "toolCall", calls: [{ id: "c1", name: "save_note", args: { text: "milk" } }] },
    ]);
    expect(parseServerMessage({ toolCallCancellation: { ids: ["c1"] } })).toEqual([{ type: "toolCancel", ids: ["c1"] }]);
    expect(parseServerMessage({ goAway: { timeLeft: "2.5s" } })).toEqual([{ type: "goAway", timeLeftMs: 2500 }]);
    expect(parseServerMessage({ sessionResumptionUpdate: { newHandle: "h2", resumable: true } })).toEqual([{ type: "resume", handle: "h2" }]);
    // A handle that can't be resumed from isn't kept.
    expect(parseServerMessage({ sessionResumptionUpdate: { newHandle: "h3", resumable: false } })).toEqual([]);
    expect(parseServerMessage("junk")).toEqual([]);
  });

  it("explains why the server closed the connection", () => {
    expect(closeReason(1008, "API key not valid. Please pass a valid API key.")).toMatch(/refused the API key/);
    expect(closeReason(1008, "models/gemini-9-live is not found")).toMatch(/Pick another model/);
    expect(closeReason(1011, "Quota exceeded")).toMatch(/quota/);
    expect(closeReason(1006, "")).toMatch(/internet/);
  });
});

describe("audio", () => {
  it("turns microphone samples into 16-bit PCM and back", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
    const back = pcm16Samples(pcm16Base64(samples));
    expect(back.length).toBe(6);
    expect(back[0]).toBe(0);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
    expect(back[3]).toBeCloseTo(1, 3);
    expect(back[4]).toBe(-1);
    // Out of range is clipped, not wrapped.
    expect(back[5]).toBeCloseTo(1, 3);
    // Little-endian: 0.5 → 0x3fff → bytes ff 3f.
    expect(Array.from(atob(pcm16Base64(new Float32Array([0.5]))), (c) => c.charCodeAt(0))).toEqual([0xff, 0x3f]);
  });
});

/** A WebSocket stand-in: records what's sent; the test plays the server. */
class FakeSocket {
  static last: FakeSocket;
  sent: any[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  serve(message: unknown, binary = false) {
    const text = JSON.stringify(message);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }
}

describe("connection", () => {
  it("sends the setup first, then the chat so far once the server is ready; reads binary frames", async () => {
    const events: unknown[] = [];
    const connection = new LiveConnection({
      key: "k/1",
      setup: { model: "gemini-3.8-live", system: "s", tools: [], voice: "Kore", history: [{ role: "user", text: "Hi" }, { role: "model", text: "Hey" }] },
      onEvent: (e) => events.push(e),
      onClose: () => undefined,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    const opened = connection.open();
    await new Promise((r) => setTimeout(r, 5));
    const socket = FakeSocket.last;
    expect(socket.url).toMatch(/BidiGenerateContent\?key=k%2F1$/);
    expect(socket.sent[0].setup.model).toBe("models/gemini-3.8-live");
    socket.serve({ setupComplete: {} }, true);
    await opened;
    expect(socket.sent[1].clientContent.turns).toHaveLength(2);
    connection.sendAudio("AAA=");
    connection.sendToolResponses([{ id: "c1", name: "t", response: { status: "ok" }, scheduling: "INTERRUPT" }]);
    expect(socket.sent[2]).toEqual({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "AAA=" } } });
    expect(socket.sent[3]).toEqual({ toolResponse: { functionResponses: [{ id: "c1", name: "t", response: { status: "ok" }, scheduling: "INTERRUPT" }] } });
    socket.serve({ serverContent: { outputTranscription: { text: "Hello" } } });
    expect(events).toEqual([{ type: "ready" }, { type: "output", text: "Hello" }]);
  });

  it("fails with the server's reason when it refuses the setup", async () => {
    const connection = new LiveConnection({
      key: "bad",
      setup: { model: "gemini-3.8-live", system: "", tools: [], voice: "Kore" },
      onEvent: () => undefined,
      onClose: () => undefined,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    const opened = connection.open();
    await new Promise((r) => setTimeout(r, 5));
    FakeSocket.last.onclose?.({ code: 1008, reason: "API key not valid" });
    await expect(opened).rejects.toThrow(/refused the API key/);
  });

  it("gives up when the server never answers the setup", async () => {
    const connection = new LiveConnection({
      key: "k",
      setup: { model: "m", system: "", tools: [], voice: "Kore" },
      onEvent: () => undefined,
      onClose: () => undefined,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      setupTimeoutMs: 30,
    });
    await expect(connection.open()).rejects.toThrow(/didn't answer/);
  });

  it("reports a drop after it was open, but not its own close", async () => {
    const closes: unknown[] = [];
    const make = () =>
      new LiveConnection({
        key: "k",
        setup: { model: "m", system: "", tools: [], voice: "Kore" },
        onEvent: () => undefined,
        onClose: (info) => closes.push(info),
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      });
    const a = make();
    const openedA = a.open();
    await new Promise((r) => setTimeout(r, 5));
    FakeSocket.last.serve({ setupComplete: {} });
    await openedA;
    FakeSocket.last.onclose?.({ code: 1006, reason: "" });
    expect(closes).toEqual([{ code: 1006, reason: "" }]);
    const b = make();
    const openedB = b.open();
    await new Promise((r) => setTimeout(r, 5));
    FakeSocket.last.serve({ setupComplete: {} });
    await openedB;
    b.close();
    expect(closes).toHaveLength(1);
  });
});
