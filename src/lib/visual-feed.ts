/**
 * Camera and screen sharing for voice mode: the bot sees what you show it. With the app's own voice
 * pipeline, each thing you say carries the latest frame (for models that can see images); with
 * Gemini Live, a frame goes every second. Frames are small JPEGs (768 px on the long side).
 */
export type FeedKind = "camera" | "screen";

export class VisualFeed {
  readonly kind: FeedKind;
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
  private canvas = document.createElement("canvas");

  private constructor(kind: FeedKind, stream: MediaStream) {
    this.kind = kind;
    this.stream = stream;
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
  }

  /** Opens the camera (front or back) or asks which screen or window to share. */
  static async open(kind: FeedKind, facing: "user" | "environment" = "user"): Promise<VisualFeed> {
    if (!navigator.mediaDevices) throw new Error("This device can't share video here.");
    let stream: MediaStream;
    try {
      stream =
        kind === "camera"
          ? await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
          : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    } catch (error) {
      const name = (error as Error).name;
      if (name === "NotAllowedError") throw new Error(kind === "camera" ? "Camera access was blocked. Allow it for ADT Bot in your system settings." : "Screen sharing was cancelled or blocked.");
      if (name === "NotFoundError") throw new Error("No camera found.");
      throw error;
    }
    const feed = new VisualFeed(kind, stream);
    await feed.video.play().catch(() => undefined);
    return feed;
  }

  get active(): boolean {
    return this.stream.getVideoTracks().some((t) => t.readyState === "live");
  }

  /** The current picture as a JPEG (null before the first frame). */
  frame(maxSide = 768, quality = 0.7): { dataUrl: string; mediaType: "image/jpeg"; data: string } | null {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (!w || !h) return null;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const dataUrl = this.canvas.toDataURL("image/jpeg", quality);
    return { dataUrl, mediaType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  }

  close() {
    this.stream.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
  }
}

/** The feed voice mode is showing right now (one at a time). */
let current: VisualFeed | null = null;
const listeners = new Set<() => void>();

export function setVisualFeed(feed: VisualFeed | null) {
  if (current && current !== feed) current.close();
  current = feed;
  listeners.forEach((l) => l());
}

export function visualFeed(): VisualFeed | null {
  return current?.active ? current : null;
}

export function onVisualFeed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
