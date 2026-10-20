// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ProviderConfig, VoiceSettings } from "./types";
import { resolveEngine, speakable, takeSentences } from "./voice";

const voice = (patch: Partial<VoiceSettings> = {}): VoiceSettings => ({
  engine: "auto",
  providerId: "",
  model: "",
  localModel: "base",
  voiceName: "",
  rate: 1,
  ...patch,
});
const groq = { id: "g", presetId: "groq", name: "Groq", kind: "openai", baseUrl: "x", apiKey: "k", models: [] } as ProviderConfig;

describe("voice engine choice", () => {
  it("falls back to on-device Whisper when there is no device recognizer (desktop app, Firefox, Claude-only setups)", () => {
    expect(resolveEngine(voice(), [])).toBe("whisper-local");
  });
  it("prefers configured cloud Whisper over downloading a model", () => {
    expect(resolveEngine(voice({ providerId: "g", model: "whisper-large-v3-turbo" }), [groq])).toBe("whisper-cloud");
  });
  it("honours an explicit choice, and never picks cloud without a provider", () => {
    expect(resolveEngine(voice({ engine: "whisper-local", providerId: "g", model: "m" }), [groq])).toBe("whisper-local");
    expect(resolveEngine(voice({ engine: "whisper-cloud" }), [])).toBe("whisper-local");
  });
});

describe("speaking", () => {
  it("speaks finished sentences while the reply is still streaming", () => {
    const first = takeSentences("Canberra is the capital of Australia. It has about 470,000 peo", false);
    expect(first.sentences).toEqual(["Canberra is the capital of Australia."]);
    expect(first.rest).toBe("It has about 470,000 peo");
    expect(takeSentences(`${first.rest}ple.`, true).sentences).toEqual(["It has about 470,000 people."]);
  });
  it("merges tiny fragments so speech isn't choppy", () => {
    const out = takeSentences("Yes. Absolutely. That is correct and here is why it works. Next", false);
    expect(out.sentences).toEqual(["Yes. Absolutely. That is correct and here is why it works."]);
    expect(out.rest).toBe("Next");
  });
  it("reads Markdown naturally", () => {
    expect(speakable("## Answer\n**Paris** is the capital [1]. See [docs](https://x.com).\n```js\ncode()\n```")).toBe(
      "Answer Paris is the capital. See docs. I've put the code in the chat.",
    );
  });
  it("says links, lists, symbols and emoji the way a person would", () => {
    expect(speakable("Read https://www.example.com/a/b?c=1 for more 🎉")).toBe("Read example.com for more");
    expect(speakable("Steps:\n1. Open it\n2. Click Send")).toBe("Steps: First, Open it Second, Click Send");
    expect(speakable("Use C# when x > 5")).toBe("Use C sharp when x greater than 5");
    expect(speakable("Sure, I'll note that <remem")).toBe("Sure, I'll note that");
  });
  it("doesn't split sentences at abbreviations", () => {
    const out = takeSentences("I spoke with Dr. Smith about it today. Then e.g. this other thing happened later. More", false);
    expect(out.sentences).toEqual(["I spoke with Dr. Smith about it today.", "Then e.g. this other thing happened later."]);
  });
});
