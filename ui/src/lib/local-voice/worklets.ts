/**
 * AudioWorklet processors for local voice calls (HOM-311, HOM-318), shipped as
 * Blob modules so no extra static asset or bundler entry is needed.
 *
 * - `pc-mic-capture`: mono microphone input → PCM16 mono frames of 40 ms at
 *   the relay's input rate (24 kHz for OpenAI Realtime, 16 kHz for the Gemini
 *   fallback), plus an RMS level for silence detection. The call runs its
 *   AudioContext at 24 kHz, so the browser resamples the microphone and the
 *   capture is a straight conversion; the averaging decimator below only
 *   runs when the context rate is higher than the target (a browser that
 *   ignored the requested rate, or the 16 kHz fallback), and linear
 *   interpolation when it is lower. The rate changes with a
 *   `{ type: "rate", rate }` message; every frame carries the rate it was made at.
 * - `pc-voice-player`: PCM16 mono 24 kHz chunks → context-rate output with a
 *   queue that `flush` empties immediately on barge-in.
 */
const CAPTURE_SOURCE = `
class PcMicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.configure(24000);
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === "rate" && Number.isFinite(data.rate) && data.rate >= 8000 && data.rate <= 48000) this.configure(data.rate);
    };
  }
  configure(rate) {
    this.rate = rate;
    // Input samples per output sample. >= 1: averaging decimation, which
    // suppresses aliasing and carries across blocks (1 copies samples).
    // < 1 (a context slower than the relay rate): linear interpolation.
    this.ratio = sampleRate / rate;
    this.phase = 0;
    this.sum = 0;
    this.taken = 0;
    this.last = 0;
    this.position = 0;
    this.frame = new Int16Array(Math.round(rate * 0.04));
    this.filled = 0;
    this.sumSquares = 0;
    this.count = 0;
  }
  emit(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.frame[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.filled === this.frame.length) {
      const rms = Math.sqrt(this.sumSquares / Math.max(1, this.count));
      const buffer = this.frame.buffer.slice(0);
      this.port.postMessage({ pcm: buffer, rms, rate: this.rate }, [buffer]);
      this.filled = 0; this.sumSquares = 0; this.count = 0;
    }
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const x = channel[i];
      this.sumSquares += x * x; this.count++;
      if (this.ratio >= 1) {
        this.sum += x; this.taken++; this.phase += 1;
        if (this.phase >= this.ratio) {
          this.emit(this.sum / this.taken);
          this.phase -= this.ratio; this.sum = 0; this.taken = 0;
        }
      } else {
        // Output samples lie at fractional positions between the previous and this input sample.
        while (this.position <= 1) {
          this.emit(this.last + (x - this.last) * this.position);
          this.position += this.ratio;
        }
        this.position -= 1;
        this.last = x;
      }
    }
    return true;
  }
}
registerProcessor("pc-mic-capture", PcMicCapture);
`;

const PLAYER_SOURCE = `
class PcVoicePlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = 24000 / sampleRate;
    this.queue = [];
    this.current = null;
    this.position = 0;
    this.playing = false;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === "flush") { this.queue = []; this.current = null; this.position = 0; this.report(false); return; }
      if (data.type === "pcm") {
        const pcm = new Int16Array(data.data);
        const samples = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
        this.queue.push(samples);
      }
    };
  }
  report(playing) { if (playing !== this.playing) { this.playing = playing; this.port.postMessage({ type: "playing", playing }); } }
  process(_inputs, outputs) {
    const output = outputs[0][0];
    let written = 0;
    while (written < output.length) {
      if (!this.current || this.position >= this.current.length - 1) {
        if (this.current) this.position -= Math.max(0, this.current.length - 1);
        this.current = this.queue.shift() || null;
        if (!this.current) break;
        if (this.position < 0) this.position = 0;
      }
      const index = Math.floor(this.position), fraction = this.position - index;
      const a = this.current[index], b = index + 1 < this.current.length ? this.current[index + 1] : a;
      output[written++] = a + (b - a) * fraction;
      this.position += this.step;
    }
    for (let i = written; i < output.length; i++) output[i] = 0;
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output);
    this.report(written > 0);
    return true;
  }
}
registerProcessor("pc-voice-player", PcVoicePlayer);
`;

const loaded = new WeakSet<BaseAudioContext>();

export async function loadVoiceWorklets(context: BaseAudioContext) {
  if (loaded.has(context)) return;
  for (const source of [CAPTURE_SOURCE, PLAYER_SOURCE]) {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  }
  loaded.add(context);
}

export const VOICE_WORKLET_SOURCES = { capture: CAPTURE_SOURCE, player: PLAYER_SOURCE };
