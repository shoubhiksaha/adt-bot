// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SUPERTONIC3_LANGUAGES, supertonicIds, supertonicLanguage, supertonicText } from "./supertonic-text";

describe("Supertonic 3 text", () => {
  it("decomposes accents, tidies punctuation, closes the sentence and adds the language tags", () => {
    expect(supertonicText("Bien sûr, je peux vous aider avec ça", "fr")).toBe("<fr>Bien sûr, je peux vous aider avec ça.</fr>");
    expect(supertonicText("“Hello” — it’s  me ,ok?", "en")).toBe(`<en>"Hello" - it's me,ok?</en>`);
    expect(supertonicText("Mail me @ work 🎉", "en")).toBe("<en>Mail me at work.</en>");
    expect(supertonicText("Hi", "xx")).toBe("<en>Hi.</en>");
  });

  it("maps characters through the model's index, unknown ones to -1", () => {
    const indexer = Array.from({ length: 128 }, (_, i) => i + 1000);
    expect([...supertonicIds("<en>A</en>", indexer)]).toEqual([60, 101, 110, 62, 65, 60, 47, 101, 110, 62].map((c) => BigInt(c + 1000)));
    expect([...supertonicIds("é", indexer)]).toEqual([-1n]);
  });

  it("reads each sentence in its own language", () => {
    expect(supertonicLanguage("東京は日本の首都です。", "en")).toBe("ja");
    expect(supertonicLanguage("서울은 한국의 수도입니다.", "en")).toBe("ko");
    expect(supertonicLanguage("Привет, как дела?", "uk-UA")).toBe("uk");
    expect(supertonicLanguage("Привет, как дела?", "en-US")).toBe("ru");
    expect(supertonicLanguage("Γεια σου", "en")).toBe("el");
    expect(supertonicLanguage("Berlin ist die Hauptstadt von Deutschland.", "de-DE")).toBe("de");
    expect(supertonicLanguage("Het is mooi weer vandaag.", "nl")).toBe("nl");
    expect(supertonicLanguage("Mañana va a llover.", "es-ES")).toBe("es");
    // An English reply for someone whose system is in German.
    expect(supertonicLanguage("Sure, I can help with that.", "de-DE")).toBe("en");
    expect(supertonicLanguage("Paris is the capital of France, and it's about two hours from London.", "fr")).toBe("en");
    // Someone with an English system asking for other languages.
    expect(supertonicLanguage("Mañana va a llover en Lisboa por la tarde.", "en-US")).toBe("es");
    expect(supertonicLanguage("Bien sûr, je peux vous aider avec ça.", "en-US")).toBe("fr");
    expect(supertonicLanguage("Berlin ist die Hauptstadt von Deutschland.", "en-US")).toBe("de");
    // No clear sign: the preferred language, or English when Supertonic doesn't speak it.
    expect(supertonicLanguage("Okay, schneller.", "de-DE")).toBe("de");
    expect(supertonicLanguage("Habari yako?", "sw")).toBe("en");
    expect(supertonicLanguage("Anything at all", "en-GB")).toBe("en");
  });

  it("covers the 31 languages", () => {
    expect(SUPERTONIC3_LANGUAGES).toHaveLength(31);
  });
});
