// pcm-processor.js — AudioWorklet that captures PCM16 from the mic
// Resamples from device sample rate to 24kHz for AssemblyAI Voice Agent API
// and posts fixed-size chunks (default 50 ms) to the main thread.
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputSampleRate, targetSampleRate, chunkSamples } = options.processorOptions || {};
    // Input samples consumed per output sample (2 at 48 kHz, 1.8375 at 44.1 kHz)
    this.step = (inputSampleRate || sampleRate) / (targetSampleRate || 24000);
    // Fractional read position in the current block, carried across blocks so
    // non-integer ratios don't drop samples. Position -1 is the previous
    // block's last sample.
    this.pos = 0;
    this.prev = 0;
    this.chunk = new Int16Array(chunkSamples || 1200);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    const len = input.length;
    while (this.pos < len - 1) {
      const i0 = Math.floor(this.pos);
      const s0 = i0 < 0 ? this.prev : input[i0];
      const s1 = input[i0 + 1];
      const sample = s0 + (s1 - s0) * (this.pos - i0);
      this.chunk[this.fill++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));

      if (this.fill === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(this.chunk.length);
        this.fill = 0;
      }
      this.pos += this.step;
    }
    this.pos -= len;
    this.prev = input[len - 1];
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
