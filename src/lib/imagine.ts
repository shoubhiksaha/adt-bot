import { describeHttpError, errorText } from "./llm";
import { withCustomHeaders } from "./llm";
import { providerFetch } from "./transport";
import type { ProviderConfig } from "./types";

/** Suggested image models per provider preset. Any image model id the provider offers works. */
export const IMAGE_MODEL_SUGGESTIONS: Record<string, string[]> = {
  openrouter: ["google/gemini-3.1-flash-image", "openai/gpt-image-2", "x-ai/grok-imagine-image-2.0", "black-forest-labs/flux.2-pro"],
  openai: ["gpt-image-2", "gpt-image-1"],
  xai: ["grok-imagine-image-2.0"],
  google: ["gemini-3.1-flash-image"],
  together: ["black-forest-labs/FLUX.1-schnell"],
};

export function canImagine(provider: ProviderConfig): boolean {
  return provider.kind !== "anthropic";
}

/** Picks the configured image provider/model, or the first connected provider that can draw. */
export function resolveImageModel(
  providers: ProviderConfig[],
  setting: { providerId: string; model: string },
): { provider: ProviderConfig; model: string } | null {
  const chosen = providers.find((p) => p.id === setting.providerId);
  if (chosen && setting.model) return { provider: chosen, model: setting.model };
  for (const provider of providers) {
    const suggestion = IMAGE_MODEL_SUGGESTIONS[provider.presetId]?.[0];
    if (suggestion && canImagine(provider)) return { provider, model: suggestion };
  }
  return null;
}

/** Generates images from a prompt. Returns data URLs (or remote URLs if the provider only gives links). */
export async function generateImage(
  provider: ProviderConfig,
  model: string,
  prompt: string,
  useProxy: boolean,
  signal?: AbortSignal,
): Promise<{ images: string[]; text: string }> {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (provider.kind === "gemini") {
    headers["x-goog-api-key"] = provider.apiKey;
    const res = await providerFetch(
      `${base}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`,
      {
        method: "POST",
        headers: withCustomHeaders(headers, provider.headers),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
        signal,
      },
      useProxy,
    );
    if (!res.ok) throw new Error(await describeHttpError(res));
    const json: any = await res.json();
    const parts: any[] = json.candidates?.[0]?.content?.parts ?? [];
    return {
      images: parts.filter((p) => p.inlineData?.data).map((p) => `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`),
      text: parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("\n").trim(),
    };
  }

  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  if (provider.presetId === "openrouter" || base.includes("openrouter.ai")) {
    // OpenRouter draws through chat completions with image output enabled.
    const res = await providerFetch(
      `${base}/chat/completions`,
      {
        method: "POST",
        headers: withCustomHeaders(headers, provider.headers),
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], modalities: ["image", "text"] }),
        signal,
      },
      useProxy,
    );
    if (!res.ok) throw new Error(await describeHttpError(res));
    const json: any = await res.json();
    if (json.error) throw new Error(errorText(json.error));
    const message = json.choices?.[0]?.message ?? {};
    const images = (message.images ?? [])
      .map((image: any) => (typeof image.image_url === "string" ? image.image_url : image.image_url?.url))
      .filter(Boolean);
    return { images, text: typeof message.content === "string" ? message.content.trim() : "" };
  }

  // OpenAI-style images endpoint: OpenAI, xAI, Together, LocalAI, and other compatible servers.
  const res = await providerFetch(
    `${base}/images/generations`,
    {
      method: "POST",
      headers: withCustomHeaders(headers, provider.headers),
      body: JSON.stringify({ model, prompt, n: 1 }),
      signal,
    },
    useProxy,
  );
  if (!res.ok) throw new Error(await describeHttpError(res));
  const json: any = await res.json();
  const images: string[] = [];
  for (const item of json.data ?? []) {
    if (item.b64_json) images.push(`data:image/png;base64,${item.b64_json}`);
    else if (item.url) images.push(await keepLocally(item.url, useProxy));
  }
  return { images, text: (json.data?.[0]?.revised_prompt as string | undefined) ?? "" };
}

/** Provider image links often expire, so store a copy when the image can be downloaded. */
async function keepLocally(url: string, useProxy: boolean): Promise<string> {
  try {
    const res = await providerFetch(url, { method: "GET", headers: {} }, useProxy);
    if (!res.ok) return url;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(url);
      reader.readAsDataURL(blob);
    });
  } catch {
    return url;
  }
}
