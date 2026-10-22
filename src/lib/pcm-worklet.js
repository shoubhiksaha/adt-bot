// Captures microphone audio as 512-sample (32 ms) frames at 16 kHz and sends them straight to the
// speech worker over a MessagePort, without touching the main thread.
//
// In voice mode it also takes the bot's own voice out of the microphone (EchoCanceller below): a
// second input carries exactly what the page sends to the speakers, so its echo can be predicted
// and subtracted. The system's echo canceller usually does this already; this one is for when it
// can't (no echo cancelling on the device, loud external speakers), where a short "stop" said over
// the bot is no louder than its echo and nothing else could pick it out.

/** One render quantum at 16 kHz: the canceller's block. */
const N = 128;
const M = 2 * N;
/** Frequency bins of a real block (0 to Nyquist). */
const K = N + 1;
/** Echo up to 512 ms after the voice that made it (Bluetooth speakers, rooms). */
const PARTITIONS = 64;
/**
 * The microphone is held back this long so the voice reference, which reaches this worklet through
 * a MediaStream (with its own small buffering), always arrives before its echo does.
 */
const MIC_DELAY = 8 * N;
/** Learning rate of the adapting filter. */
const STEP = 0.6;
/**
 * The cleaned microphone is used once the echo has been turned down this far (dB, over a second).
 * Until then the plain microphone goes on: a half-learned canceller garbles the echo instead of
 * removing it, and garbled echo no longer sounds like the bot's own words.
 */
const TRUSTED_DB = 12;

/** In-place radix-2 FFT of `n` complex values; the inverse is scaled by 1/n. */
function makeFft(n) {
  const bits = Math.log2(n);
  const reverse = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return (re, im, inverse) => {
    for (let i = 0; i < n; i++) {
      const j = reverse[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const stride = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = cos[k * stride];
          const s = inverse ? sin[k * stride] : -sin[k * stride];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  };
}

const SILENCE = new Float32Array(N);

const spectra = (count) => Array.from({ length: count }, () => ({ re: new Float64Array(K), im: new Float64Array(K) }));

/**
 * Acoustic echo canceller: a partitioned-block frequency-domain adaptive filter (overlap-save) with
 * a proportionate step, run as two filters. The background filter learns all the time, so it goes
 * wrong while the user talks over the bot; the foreground filter, which makes the output, only
 * takes the background's weights once they remove clearly more than its own. So talking over the
 * bot never teaches it to cancel the user, and the output is never worse than the microphone.
 */
export class EchoCanceller {
  constructor() {
    this.fft = makeFft(M);
    this.re = new Float64Array(M);
    this.im = new Float64Array(M);
    /** The reference's last PARTITIONS spectra (a ring; `head` is the newest). */
    this.x = spectra(PARTITIONS);
    this.head = 0;
    this.background = spectra(PARTITIONS);
    this.foreground = spectra(PARTITIONS);
    this.prevRef = new Float64Array(N);
    /** The reference's power over the filter's span, per bin, weighted by `share` (normalises the step). */
    this.power = new Float64Array(K);
    this.share = new Float64Array(PARTITIONS);
    this.estimate = new Float64Array(N);
    this.backgroundError = new Float64Array(N);
    this.output = new Float32Array(N);
    this.constrainNext = 0;
    /** Blocks since the reference last had sound (past PARTITIONS, nothing left to echo). */
    this.quiet = PARTITIONS + 1;
    // Smoothed block energies: microphone, background error, foreground error.
    this.mic = 0;
    this.errBackground = 0;
    this.errForeground = 0;
    this.betterFor = 0;
    // Microphone and output energy while the bot's echo may be coming back (see takeReduction).
    this.echoIn = 0;
    this.echoOut = 0;
  }

  /** How far the echo was turned down since the last call, in dB (null if the bot was quiet meanwhile). */
  takeReduction() {
    const db = this.echoIn > 1e-6 ? 10 * Math.log10(this.echoIn / (this.echoOut + 1e-12)) : null;
    this.echoIn = 0;
    this.echoOut = 0;
    return db;
  }

  /** Spectrum of the last two blocks of `block` (overlap-save input), into this.re/this.im. */
  transform(prev, block) {
    const { re, im } = this;
    for (let i = 0; i < N; i++) {
      re[i] = prev[i];
      re[N + i] = block[i];
    }
    im.fill(0);
    this.fft(re, im, false);
  }

  /** The echo `filter` predicts for the current block, into `out` (N samples). */
  predict(filter, out) {
    const { re, im, x } = this;
    re.fill(0);
    im.fill(0);
    for (let p = 0; p < PARTITIONS; p++) {
      const xs = x[(this.head - p + PARTITIONS) % PARTITIONS];
      const w = filter[p];
      for (let k = 0; k < K; k++) {
        re[k] += w.re[k] * xs.re[k] - w.im[k] * xs.im[k];
        im[k] += w.re[k] * xs.im[k] + w.im[k] * xs.re[k];
      }
    }
    for (let k = 1; k < N; k++) {
      re[M - k] = re[k];
      im[M - k] = -im[k];
    }
    this.fft(re, im, true);
    for (let i = 0; i < N; i++) out[i] = re[N + i];
  }

  /** Keeps one partition of the background filter a true N-tap filter (one per block, in turn). */
  constrain(w) {
    const { re, im } = this;
    for (let k = 0; k < K; k++) {
      re[k] = w.re[k];
      im[k] = w.im[k];
    }
    for (let k = 1; k < N; k++) {
      re[M - k] = re[k];
      im[M - k] = -im[k];
    }
    this.fft(re, im, true);
    for (let i = N; i < M; i++) re[i] = 0;
    im.fill(0);
    this.fft(re, im, false);
    for (let k = 0; k < K; k++) {
      w.re[k] = re[k];
      w.im[k] = im[k];
    }
  }

  /**
   * One block: `mic` (N samples) and `ref`, what went to the speakers at the same time (N samples,
   * or null for silence). Returns the microphone with the bot's echo taken out.
   */
  process(mic, ref) {
    let refEnergy = 0;
    if (ref) for (let i = 0; i < N; i++) refEnergy += ref[i] * ref[i];
    const sounding = refEnergy > 1e-9;
    this.quiet = sounding ? 0 : this.quiet + 1;
    this.head = (this.head + 1) % PARTITIONS;
    const slot = this.x[this.head];
    if (sounding || this.quiet <= 1) {
      this.transform(this.prevRef, ref ?? SILENCE);
      slot.re.set(this.re.subarray(0, K));
      slot.im.set(this.im.subarray(0, K));
      if (ref) this.prevRef.set(ref);
    } else {
      slot.re.fill(0);
      slot.im.fill(0);
      this.prevRef.fill(0);
    }
    // Nothing the bot said could still be echoing: pass the microphone through.
    if (this.quiet > PARTITIONS) {
      this.output.set(mic);
      return this.output;
    }

    // What the two filters expect to hear of the echo, and what's left.
    this.predict(this.foreground, this.estimate);
    let micEnergy = 0;
    let fgEnergy = 0;
    for (let i = 0; i < N; i++) {
      micEnergy += mic[i] * mic[i];
      const e = mic[i] - this.estimate[i];
      fgEnergy += e * e;
      this.output[i] = e;
    }
    this.predict(this.background, this.estimate);
    let bgEnergy = 0;
    for (let i = 0; i < N; i++) {
      const e = mic[i] - this.estimate[i];
      bgEnergy += e * e;
      this.backgroundError[i] = e;
    }

    if (sounding) {
      // Learn (proportionate NLMS): each partition's share of the step follows how much of the echo
      // it holds already (an echo path is mostly one delay, so learning concentrates there),
      // normalised by the reference's power over the whole span.
      let largest = 1e-12;
      for (let p = 0; p < PARTITIONS; p++) {
        const w = this.background[p];
        let energy = 0;
        for (let k = 0; k < K; k++) energy += w.re[k] * w.re[k] + w.im[k] * w.im[k];
        this.share[p] = Math.sqrt(energy);
        if (this.share[p] > largest) largest = this.share[p];
      }
      let total = 0;
      for (let p = 0; p < PARTITIONS; p++) {
        this.share[p] += 0.1 * largest + 1e-9;
        total += this.share[p];
      }
      const power = this.power;
      power.fill(0);
      for (let p = 0; p < PARTITIONS; p++) {
        // Shares averaging 1.
        this.share[p] *= PARTITIONS / total;
        const xs = this.x[(this.head - p + PARTITIONS) % PARTITIONS];
        const a = this.share[p];
        for (let k = 0; k < K; k++) power[k] += a * (xs.re[k] * xs.re[k] + xs.im[k] * xs.im[k]);
      }
      let meanPower = 0;
      for (let k = 0; k < K; k++) meanPower += power[k];
      const floor = 1e-3 * (meanPower / K) + M * 1e-8;
      const { re, im } = this;
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < N; i++) re[N + i] = this.backgroundError[i];
      this.fft(re, im, false);
      for (let p = 0; p < PARTITIONS; p++) {
        const xs = this.x[(this.head - p + PARTITIONS) % PARTITIONS];
        const w = this.background[p];
        const rate = STEP * this.share[p];
        for (let k = 0; k < K; k++) {
          const g = rate / (power[k] + floor);
          w.re[k] += g * (xs.re[k] * re[k] + xs.im[k] * im[k]);
          w.im[k] += g * (xs.re[k] * im[k] - xs.im[k] * re[k]);
        }
      }
      this.constrain(this.background[this.constrainNext]);
      this.constrainNext = (this.constrainNext + 1) % PARTITIONS;
    }

    this.mic = 0.7 * this.mic + 0.3 * micEnergy;
    this.errBackground = 0.7 * this.errBackground + 0.3 * bgEnergy;
    this.errForeground = 0.7 * this.errForeground + 0.3 * fgEnergy;
    if (sounding && this.errBackground < 0.5 * this.errForeground && this.errBackground < this.mic) {
      // The background has been clearly better for a moment (not one lucky block): take it.
      if (++this.betterFor >= 4) {
        this.copy(this.background, this.foreground);
        this.betterFor = 0;
      }
    } else {
      this.betterFor = 0;
      // Gone wrong while the user talked over the bot: start again from what works.
      if (this.errBackground > 8 * this.errForeground + 1e-9) this.copy(this.foreground, this.background);
    }
    // Never worse than the microphone itself (the echo path changed and the filter hasn't caught up).
    if (fgEnergy > micEnergy) this.output.set(mic);
    this.echoIn += micEnergy;
    this.echoOut += Math.min(fgEnergy, micEnergy);
    return this.output;
  }

  copy(from, to) {
    for (let p = 0; p < PARTITIONS; p++) {
      to[p].re.set(from[p].re);
      to[p].im.set(from[p].im);
    }
  }
}

// Also loaded outside an audio worklet by the tests (for EchoCanceller).
const Processor = typeof AudioWorkletProcessor === "function" ? AudioWorkletProcessor : class {};

class PcmFrames extends Processor {
  constructor(options) {
    super();
    this.out = null;
    this.frame = new Float32Array(512);
    this.filled = 0;
    // Resample if the browser didn't honour the 16 kHz context rate.
    this.step = sampleRate / 16000;
    this.position = 0;
    // Echo cancelling (voice mode's listener asks for it): only at 16 kHz, in whole blocks.
    this.aec = options?.processorOptions?.echoCancel && this.step === 1 ? new EchoCanceller() : null;
    this.delayed = this.aec ? new Float32Array(MIC_DELAY + N) : null;
    this.block = new Float32Array(N);
    this.blocks = 0;
    this.trusted = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) this.out = e.data.port;
      if (e.data && e.data.drain) this.drain();
    };
  }

  /** Finishing a turn now: send what the delay line and the current frame still hold. */
  drain() {
    if (!this.out) return;
    if (this.delayed) {
      for (let i = 0; i < MIC_DELAY; i++) this.push(this.delayed[N + i]);
      this.delayed.fill(0);
    }
    if (this.filled) {
      while (this.filled) this.push(0);
    }
  }

  push(sample) {
    this.frame[this.filled++] = sample;
    if (this.filled === 512) {
      this.out.postMessage(this.frame, [this.frame.buffer]);
      this.frame = new Float32Array(512);
      this.filled = 0;
    }
  }

  process(inputs, outputs) {
    let input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!input) return true;
    if (this.aec && input.length === N) {
      // Hold the microphone back MIC_DELAY, then take out what the reference predicts.
      this.delayed.copyWithin(0, N);
      this.delayed.set(input, MIC_DELAY);
      this.block.set(this.delayed.subarray(0, N));
      const ref = inputs[1] && inputs[1][0];
      try {
        const cleaned = this.aec.process(this.block, ref && ref.length === N ? ref : null);
        input = this.trusted ? cleaned : this.block;
      } catch {
        // A bug here must not cost the microphone.
        this.aec = null;
        input = this.block;
        this.port.postMessage({ echoReduction: null });
      }
      if (this.aec && ++this.blocks % 125 === 0) {
        const echoReduction = this.aec.takeReduction();
        if (echoReduction !== null && echoReduction >= TRUSTED_DB) this.trusted = true;
        // What the page gets is what the speech detector hears: no reduction until it's in use.
        if (echoReduction !== null && this.trusted) this.port.postMessage({ echoReduction });
      }
    }
    // The analyser on this node's output hears the same audio the speech worker gets.
    if (output) output.set(input.subarray(0, output.length));
    if (!this.out) return true;
    if (this.step === 1) {
      for (let i = 0; i < input.length; i++) this.push(input[i]);
    } else {
      for (; this.position < input.length; this.position += this.step) this.push(input[Math.floor(this.position)]);
      this.position -= input.length;
    }
    return true;
  }
}

if (typeof registerProcessor === "function") registerProcessor("pcm-frames", PcmFrames);
