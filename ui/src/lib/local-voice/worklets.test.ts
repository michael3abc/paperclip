import { describe, expect, it } from "vitest";
import { VOICE_WORKLET_SOURCES } from "./worklets";

function load(source: string, sampleRate: number) {
  const registered: Record<string, new () => any> = {};
  class AudioWorkletProcessor { port = { posted: [] as any[], onmessage: null as null | ((event: { data: unknown }) => void), postMessage(message: unknown) { this.posted.push(message); } }; }
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", source)(
    AudioWorkletProcessor, (name: string, ctor: new () => any) => { registered[name] = ctor; }, sampleRate);
  return registered;
}

describe("voice worklets", () => {
  it("passes a 24 kHz context through as 40 ms PCM16 frames at 24 kHz", () => {
    const processor = new (load(VOICE_WORKLET_SOURCES.capture, 24_000)["pc-mic-capture"]!)();
    const block = new Float32Array(128).fill(0.25);
    block[0] = -1;
    for (let i = 0; i < 8; i++) processor.process([[block]]); // 1024 samples → one 960-sample frame
    expect(processor.port.posted).toHaveLength(1);
    const frame = new Int16Array(processor.port.posted[0].pcm);
    expect(frame).toHaveLength(960);
    expect(frame[0]).toBe(-0x8000);
    expect(frame[1]).toBe(Math.floor(0.25 * 0x7fff));
  });

  it("switches to 16 kHz frames for the Gemini fallback and decimates a 48 kHz context", () => {
    const processor = new (load(VOICE_WORKLET_SOURCES.capture, 48_000)["pc-mic-capture"]!)();
    processor.port.onmessage({ data: { type: "rate", rate: 16_000 } });
    const block = new Float32Array(128).fill(0.5);
    for (let i = 0; i < 15; i++) processor.process([[block]]); // 1920 input samples = 640 output samples
    expect(processor.port.posted).toHaveLength(1);
    const frame = new Int16Array(processor.port.posted[0].pcm);
    expect(frame).toHaveLength(640);
    expect(frame[0]).toBe(Math.floor(0.5 * 0x7fff));
    expect(processor.port.posted[0].rms).toBeCloseTo(0.5, 5);
  });

  it("interpolates up when the context runs slower than the relay rate, and tags frames with their rate", () => {
    const processor = new (load(VOICE_WORKLET_SOURCES.capture, 16_000)["pc-mic-capture"]!)();
    const block = new Float32Array(128).fill(0.5);
    for (let i = 0; i < 6; i++) processor.process([[block]]); // 768 input samples at 16 kHz → 1152 at 24 kHz
    expect(processor.port.posted).toHaveLength(1);
    expect(processor.port.posted[0].rate).toBe(24_000);
    const frame = new Int16Array(processor.port.posted[0].pcm);
    expect(frame).toHaveLength(960);
    expect(frame[10]).toBe(Math.floor(0.5 * 0x7fff));
  });

  it("upsamples 24 kHz model audio and drops queued audio on flush", () => {
    const processor = new (load(VOICE_WORKLET_SOURCES.player, 48_000)["pc-voice-player"]!)();
    const pcm = new Int16Array(240).fill(16384);
    processor.port.onmessage({ data: { type: "pcm", data: pcm.buffer } });
    const left = new Float32Array(128), right = new Float32Array(128);
    processor.process([], [[left, right]]);
    expect(left[0]).toBeCloseTo(0.5, 5);
    expect(right[10]).toBeCloseTo(0.5, 5);
    expect(processor.port.posted.at(-1)).toEqual({ type: "playing", playing: true });
    processor.port.onmessage({ data: { type: "flush" } });
    processor.process([], [[left, right]]);
    expect(Array.from(left).every((value) => value === 0)).toBe(true);
    expect(processor.port.posted.at(-1)).toEqual({ type: "playing", playing: false });
  });
});
