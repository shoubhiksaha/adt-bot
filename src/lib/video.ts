/**
 * Video creation: short clips with sound from a prompt (and optionally a picture to animate), with
 * Google's Gemini Omni Flash (one request returns the video) or xAI's Grok Imagine Video (a job that
 * is polled until it's done). Videos are kept on the device in IndexedDB, not inside the chat.
 */
import { createStore, del, get, set } from "idb-keyval";
import { providerFetch } from "./transport";
import type { ProviderConfig } from "./types";

export const VIDEO_MODELS: Record<string, string[]> = {
  google: ["gemini-omni-1.1-flash"],
  xai: ["grok-imagine-video-1.5"],
};

export type VideoOptions = { aspect: "16:9" | "9:16"; seconds: number; image?: string };

/** The provider and model for a video: the one chosen in Settings → Images, or the first that can make videos. */
export function resolveVideoModel(providers: ProviderConfig[], setting: { providerId: string; model: string }): { provider: ProviderConfig; model: string } | null {
  const chosen = providers.find((p) => p.id === setting.providerId);
  if (chosen && setting.model) return { provider: chosen, model: setting.model };
  for (const provider of providers) {
    const model = VIDEO_MODELS[provider.presetId]?.[0];
    if (model && provider.apiKey) return { provider, model };
  }
  return null;
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function failure(res: Response, who: string): Promise<Error> {
  const text = await res.text().catch(() => "");
  let reason = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    reason = j.error?.message ?? j.error ?? j.message ?? reason;
  } catch {}
  return new Error(`${who} said ${res.status}${reason ? `: ${reason}` : ""}`);
}

/** Makes a video; resolves with its bytes (MP4). `onStatus` hears progress. */
export async function generateVideo(
  provider: ProviderConfig,
  model: string,
  prompt: string,
  options: VideoOptions,
  useProxy: boolean,
  signal: AbortSignal,
  onStatus: (text: string) => void = () => undefined,
): Promise<{ data: Uint8Array; mime: string }> {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (provider.kind === "gemini") {
    onStatus(`Creating the video with ${model} (about a minute)…`);
    const input = options.image
      ? [
          { type: "image", mime_type: /^data:([^;]+)/.exec(options.image)?.[1] ?? "image/png", data: options.image.replace(/^data:[^,]+,/, "") },
          { type: "text", text: prompt },
        ]
      : prompt;
    const res = await providerFetch(
      `${base}/interactions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": provider.apiKey, ...(provider.headers ?? {}) },
        body: JSON.stringify({ model, input, response_format: { type: "video", aspect_ratio: options.aspect, resolution: "720p", delivery: "base64" } }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
      },
      useProxy,
    );
    if (!res.ok) throw await failure(res, "Google");
    const body = (await res.json()) as {
      steps?: { type: string; content?: { type: string; mime_type?: string; data?: string }[] }[];
      output_video?: { uri?: string };
      status?: string;
    };
    const video = body.steps?.flatMap((s) => s.content ?? []).find((c) => c.type === "video" && c.data);
    if (video?.data) return { data: fromBase64(video.data), mime: video.mime_type ?? "video/mp4" };
    if (body.output_video?.uri) {
      onStatus("Downloading the video…");
      const file = await providerFetch(body.output_video.uri, { method: "GET", headers: { "x-goog-api-key": provider.apiKey }, signal }, useProxy);
      if (!file.ok) throw await failure(file, "Google");
      return { data: new Uint8Array(await file.arrayBuffer()), mime: "video/mp4" };
    }
    throw new Error(`Google didn't return a video (${body.status ?? "no status"}). Try another prompt.`);
  }

  // xAI: start a job, then check until it's done.
  const headers = { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}`, ...(provider.headers ?? {}) };
  onStatus(`Starting the video with ${model}…`);
  const start = await providerFetch(
    `${base}/videos/generations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt, duration: Math.min(Math.max(Math.round(options.seconds), 1), 15), aspect_ratio: options.aspect, ...(options.image ? { image: { url: options.image } } : {}) }),
      signal,
    },
    useProxy,
  );
  if (!start.ok) throw await failure(start, "xAI");
  const { request_id: id } = (await start.json()) as { request_id?: string };
  if (!id) throw new Error("xAI didn't start the video.");
  const began = Date.now();
  for (;;) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (Date.now() - began > 10 * 60_000) throw new Error("The video took longer than 10 minutes. Try a shorter one.");
    await new Promise((r) => setTimeout(r, Date.now() - began < 20_000 ? 3000 : 6000));
    onStatus(`Creating the video with ${model} (${Math.round((Date.now() - began) / 1000)} s)…`);
    const poll = await providerFetch(`${base}/videos/${encodeURIComponent(id)}`, { method: "GET", headers, signal }, useProxy);
    if (!poll.ok) throw await failure(poll, "xAI");
    const job = (await poll.json()) as { status?: string; video?: { url?: string }; error?: { message?: string } | string };
    if (job.status === "done" && job.video?.url) {
      onStatus("Downloading the video…");
      const file = await providerFetch(job.video.url, { method: "GET", headers: {}, signal }, useProxy);
      if (!file.ok) throw await failure(file, "xAI");
      return { data: new Uint8Array(await file.arrayBuffer()), mime: file.headers.get("content-type")?.startsWith("video/") ? file.headers.get("content-type")! : "video/mp4" };
    }
    if (job.status === "failed" || job.status === "expired") {
      throw new Error(`xAI couldn't make the video (${typeof job.error === "string" ? job.error : (job.error?.message ?? job.status)}).`);
    }
  }
}

// Kept on the device -----------------------------------------------------------------------------

const media = typeof indexedDB === "undefined" ? undefined : createStore("adtbot-media", "files");
const memory = new Map<string, Blob>();

export async function saveMedia(data: Uint8Array, mime: string): Promise<string> {
  const id = crypto.randomUUID();
  const blob = new Blob([data as BlobPart], { type: mime });
  if (media) await set(id, blob, media);
  else memory.set(id, blob);
  return id;
}

export async function loadMedia(id: string): Promise<Blob | undefined> {
  return media ? get<Blob>(id, media) : memory.get(id);
}

export async function deleteMedia(id: string) {
  if (media) await del(id, media);
  memory.delete(id);
}
