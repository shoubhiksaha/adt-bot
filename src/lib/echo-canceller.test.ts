import { describe, expect, it } from "vitest";
import { EchoCanceller } from "./pcm-worklet.js";

const RATE = 16000;
const BLOCK = 128;

/** A deterministic voice-like signal: a gliding pitch with harmonics, in syllables, with a little breath noise. */
function voice(seconds: number, pitch: number, seed: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let s = seed;
  const random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const f0 = pitch * (1 + 0.15 * Math.sin(2 * Math.PI * 0.7 * t + seed));
    phase += (2 * Math.PI * f0) / RATE;
    let v = 0;
    for (let h = 1; h <= 16; h++) v += Math.sin(h * phase) / h;
    // Syllables about four a second, with short gaps.
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t + seed)) ** 0.6;
    out[i] = 0.12 * syllable * (v + 0.3 * random());
  }
  return out;
}

/** The bot's voice as the microphone hears it: late, quieter, smeared by the room. */
function echoOf(ref: Float32Array, delayMs: number, gain: number): Float32Array {
  const delay = Math.round((delayMs / 1000) * RATE);
  const room = [1, 0, 0, 0.5, 0, 0.3, 0.2, 0, 0, 0.15, 0.1, 0.05].map((g) => g * gain);
  const out = new Float32Array(ref.length);
  for (let i = 0; i < ref.length; i++) {
    let v = 0;
    for (let j = 0; j < room.length; j++) {
      const at = i - delay - j * 12;
      if (at >= 0) v += room[j] * ref[at];
    }
    out[i] = v;
  }
  return out;
}

function run(mic: Float32Array, ref: Float32Array | null) {
  const aec = new EchoCanceller();
  const out = new Float32Array(mic.length);
  for (let i = 0; i + BLOCK <= mic.length; i += BLOCK) {
    out.set(aec.process(mic.subarray(i, i + BLOCK), ref ? ref.subarray(i, i + BLOCK) : null), i);
  }
  return out;
}

const energy = (x: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) sum += x[i] * x[i];
  return sum;
};
const db = (a: number, b: number) => 10 * Math.log10(a / b);

describe("voice-mode echo canceller", () => {
  const bot = voice(12, 140, 1);
  const user = new Float32Array(bot.length);
  // A short "stop" at 5 s, then talking over the bot for two seconds from 7 s.
  user.set(voice(0.5, 230, 7).map((v) => v * 0.6), 5 * RATE);
  user.set(voice(2, 210, 9).map((v) => v * 0.6), 7 * RATE);
  // Echo as loud as the user: no system echo cancelling.
  const echo = echoOf(bot, 200, 0.6);
  const mic = echo.map((v, i) => v + user[i] + 0.0005 * Math.sin(i));
  const out = run(mic, bot);

  it("turns the bot's echo well down once it has heard a little of it", () => {
    // This voice is all harmonics, harder to learn than real speech (15 dB at 3 s, 25 dB by 6 s).
    expect(db(energy(mic, 2.5, 4.5), energy(out, 2.5, 4.5))).toBeGreaterThan(12);
  });

  it("keeps the user's short stop: it stands well clear of what's left of the echo", () => {
    const residual = echo.map((v, i) => out[i] - user[i]);
    // Before: the stop was no louder than the echo around it.
    expect(db(energy(user, 5, 5.5), energy(echo, 5, 5.5))).toBeLessThan(3);
    // After: the echo left over is far below it, and the stop itself is intact.
    expect(db(energy(user, 5, 5.5), energy(residual, 5, 5.5))).toBeGreaterThan(12);
  });

  it("doesn't learn to cancel the user while they talk over the bot", () => {
    const residual = out.map((v, i) => v - user[i]);
    expect(db(energy(user, 7.2, 9), energy(residual, 7.2, 9))).toBeGreaterThan(10);
    // And it still cancels the echo afterwards.
    expect(db(energy(mic, 9.5, 11.5), energy(out, 9.5, 11.5))).toBeGreaterThan(15);
  });

  it("passes the microphone through untouched when the bot is quiet", () => {
    const quietMic = voice(1, 200, 3);
    expect(Array.from(run(quietMic, null))).toEqual(Array.from(quietMic));
  });

  it("is never worse than the microphone when the reference has nothing to do with it", () => {
    const other = voice(4, 160, 5);
    const alone = voice(4, 220, 11);
    const cleaned = run(alone, other);
    expect(energy(cleaned, 0.5, 4)).toBeLessThanOrEqual(energy(alone, 0.5, 4) * 1.01);
    expect(db(energy(alone, 0.5, 4), energy(cleaned.map((v, i) => v - alone[i]), 0.5, 4))).toBeGreaterThan(15);
  });
});
