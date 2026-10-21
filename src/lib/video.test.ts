// @vitest-environment node
// Video creation against stand-ins for Google's Interactions API (inline or download link) and xAI's
// video jobs (start, poll, download), and /video in a chat.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "./types";

vi.mock("./transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));

const { generateVideo, loadMedia, resolveVideoModel } = await import("./video");
const { sendMessage } = await import("./chat");
const { defaultSettings, useStore } = await import("./store");

const MP4 = Buffer.from("fake-mp4-bytes");
let server: Server;
let base = "";
const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
let googleMode: "inline" | "uri" | "error" = "inline";
let polls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw });
      const json = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url === "/google/interactions") {
        if (googleMode === "error") return json(400, { error: { message: "prompt blocked" } });
        if (googleMode === "uri") return json(200, { status: "completed", steps: [], output_video: { uri: `${base}/google/files/v1:download?alt=media` } });
        return json(200, { status: "completed", steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: MP4.toString("base64") }] }] });
      }
      if (req.url?.startsWith("/google/files/")) return res.writeHead(200, { "content-type": "video/mp4" }).end(MP4);
      if (req.url === "/xai/videos/generations") return json(200, { request_id: "job1" });
      if (req.url === "/xai/videos/job1") return json(200, ++polls < 2 ? { status: "pending" } : { status: "done", video: { url: `${base}/cdn/job1.mp4` } });
      if (req.url === "/cdn/job1.mp4") return res.writeHead(200, { "content-type": "video/mp4" }).end(MP4);
      json(404, { error: "no route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  seen.length = 0;
  polls = 0;
  googleMode = "inline";
});

const google = (): ProviderConfig => ({ id: "g", presetId: "google", name: "Google", kind: "gemini", baseUrl: `${base}/google`, apiKey: "gkey", models: [] });
const xai = (): ProviderConfig => ({ id: "x", presetId: "xai", name: "xAI", kind: "openai", baseUrl: `${base}/xai`, apiKey: "xkey", models: [] });

describe("video", () => {
  it("picks Google or xAI automatically, or the one chosen", () => {
    expect(resolveVideoModel([{ ...google(), apiKey: "" }, xai()], { providerId: "", model: "" })).toMatchObject({ provider: { id: "x" }, model: "grok-imagine-video-1.5" });
    expect(resolveVideoModel([google()], { providerId: "", model: "" })?.model).toBe("gemini-omni-1.1-flash");
    expect(resolveVideoModel([google(), xai()], { providerId: "x", model: "custom-video" })).toMatchObject({ provider: { id: "x" }, model: "custom-video" });
    expect(resolveVideoModel([], { providerId: "", model: "" })).toBeNull();
  });

  it("Google: one request, video inline or behind a download link, with the key in a header", async () => {
    const inline = await generateVideo(google(), "gemini-omni-1.1-flash", "a fox", { aspect: "9:16", seconds: 8 }, false, new AbortController().signal);
    expect(Buffer.from(inline.data).toString()).toBe("fake-mp4-bytes");
    expect(JSON.parse(seen[0].body)).toEqual({ model: "gemini-omni-1.1-flash", input: "a fox", response_format: { type: "video", aspect_ratio: "9:16", resolution: "720p", delivery: "base64" } });
    expect(seen[0].headers["x-goog-api-key"]).toBe("gkey");
    googleMode = "uri";
    const linked = await generateVideo(google(), "gemini-omni-1.1-flash", "a fox", { aspect: "16:9", seconds: 8 }, false, new AbortController().signal);
    expect(Buffer.from(linked.data).toString()).toBe("fake-mp4-bytes");
    googleMode = "error";
    await expect(generateVideo(google(), "m", "x", { aspect: "16:9", seconds: 8 }, false, new AbortController().signal)).rejects.toThrow(/Google said 400: prompt blocked/);
  });

  it("xAI: starts a job, polls until it's done and downloads the clip", async () => {
    const statuses: string[] = [];
    const out = await generateVideo(xai(), "grok-imagine-video-1.5", "a fox", { aspect: "16:9", seconds: 99 }, false, new AbortController().signal, (s) => statuses.push(s));
    expect(Buffer.from(out.data).toString()).toBe("fake-mp4-bytes");
    expect(JSON.parse(seen[0].body)).toEqual({ model: "grok-imagine-video-1.5", prompt: "a fox", duration: 15, aspect_ratio: "16:9" });
    expect(seen[0].headers.authorization).toBe("Bearer xkey");
    expect(seen.filter((r) => r.url === "/xai/videos/job1")).toHaveLength(2);
    // The download link gets no key.
    expect(seen.find((r) => r.url === "/cdn/job1.mp4")!.headers.authorization).toBeUndefined();
    expect(statuses.at(-1)).toBe("Downloading the video…");
  }, 20_000);

  it("/video in a chat saves the clip on the device and shows it", async () => {
    useStore.setState({
      providers: [google()],
      bots: [{ id: "b", name: "ADT", avatar: "", description: "", systemPrompt: "", providerId: "g", model: "m", temperature: null, thinking: "off", memory: [], autoMemory: false, createdAt: 0 }],
      activeBotId: "b",
      activeConversationId: null,
      conversations: {},
      streamingId: null,
      settings: { ...defaultSettings, useProxy: false, smartTitles: false },
    });
    await sendMessage("/video a vertical reel of a fox in snow");
    const [chat] = Object.values(useStore.getState().conversations);
    const reply = chat.messages.at(-1)!;
    expect(reply.attachments?.[0]).toMatchObject({ kind: "video", mime: "video/mp4" });
    expect(JSON.parse(seen.at(-1)!.body).response_format.aspect_ratio).toBe("9:16");
    const blob = await loadMedia((reply.attachments![0] as { mediaId: string }).mediaId);
    expect(Buffer.from(await blob!.arrayBuffer()).toString()).toBe("fake-mp4-bytes");
  });
});
