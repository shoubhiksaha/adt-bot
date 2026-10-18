// Captures microphone audio as 512-sample (32 ms) frames at 16 kHz and sends them straight to the
// speech worker over a MessagePort, without touching the main thread.
class PcmFrames extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.frame = new Float32Array(512);
    this.filled = 0;
    // Resample if the browser didn't honour the 16 kHz context rate.
    this.step = sampleRate / 16000;
    this.position = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) this.out = e.data.port;
    };
  }

  push(sample) {
    this.frame[this.filled++] = sample;
    if (this.filled === 512) {
      this.out.postMessage(this.frame, [this.frame.buffer]);
      this.frame = new Float32Array(512);
      this.filled = 0;
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || !this.out) return true;
    if (this.step === 1) {
      for (let i = 0; i < input.length; i++) this.push(input[i]);
    } else {
      for (; this.position < input.length; this.position += this.step) this.push(input[Math.floor(this.position)]);
      this.position -= input.length;
    }
    return true;
  }
}

registerProcessor("pcm-frames", PcmFrames);
