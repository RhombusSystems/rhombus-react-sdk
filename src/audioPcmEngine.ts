import { OpusDecoderWebWorker } from "opus-decoder";
import { AUDIO_SAMPLE_RATE } from "./audioPlayback.js";

export type AudioPcmEngineOptions = {
  muted: boolean;
  volume: number;
  playbackRate?: number;
  onError?: (error: Error) => void;
};

/**
 * Worker-backed Opus decoder and Web Audio scheduler shared by live and decoded VOD playback.
 * A generation counter prevents decoded work from a previous seek from reaching the speakers.
 */
export class AudioPcmEngine {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private readonly decoder: OpusDecoderWebWorker<48000>;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private decodeChain = Promise.resolve();
  private generation = 0;
  private nextStartSec = 0;
  private wallClockOffsetMs: number | null = null;
  private muted: boolean;
  private volume: number;
  private playbackRate: number;
  private readonly onError?: (error: Error) => void;

  constructor(options: AudioPcmEngineOptions) {
    const AudioContextConstructor =
      globalThis.AudioContext ??
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error("Web Audio is unavailable in this browser");
    }
    this.context = new AudioContextConstructor({
      latencyHint: "interactive",
      sampleRate: AUDIO_SAMPLE_RATE,
    });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    this.decoder = new OpusDecoderWebWorker({
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 1,
      streamCount: 1,
      coupledStreamCount: 0,
      channelMappingTable: [0],
    });
    this.muted = options.muted;
    this.volume = clamp(options.volume, 0, 1);
    this.playbackRate = clamp(options.playbackRate ?? 1, 0.25, 4);
    this.onError = options.onError;
    this.applyGain();
  }

  async ready(): Promise<void> {
    await this.decoder.ready;
  }

  async play(): Promise<void> {
    await this.context.resume();
  }

  async pause(): Promise<void> {
    await this.context.suspend();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.applyGain();
  }

  setPlaybackRate(playbackRate: number): void {
    this.playbackRate = clamp(playbackRate, 0.25, 4);
  }

  enqueueOpus(frame: Uint8Array, timestampMs?: number): void {
    const generation = this.generation;
    const ownedFrame = frame.slice();
    this.decodeChain = this.decodeChain
      .then(async () => {
        const decoded = await this.decoder.decodeFrame(ownedFrame);
        if (generation !== this.generation || decoded.samplesDecoded <= 0) return;
        if (decoded.errors.length > 0) {
          this.onError?.(new Error(decoded.errors[0].message));
        }
        const channel = decoded.channelData[0];
        if (channel) this.schedule(channel, decoded.sampleRate, timestampMs);
      })
      .catch(error => {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  }

  getWallClockMs(): number | null {
    if (this.wallClockOffsetMs == null) return null;
    return this.context.currentTime * 1000 + this.wallClockOffsetMs;
  }

  getBufferedDurationSec(): number {
    return Math.max(0, this.nextStartSec - this.context.currentTime);
  }

  async reset(wallClockMs?: number): Promise<void> {
    this.generation++;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // The source may already have ended.
      }
      source.disconnect();
    }
    this.sources.clear();
    this.nextStartSec = 0;
    this.wallClockOffsetMs =
      wallClockMs == null ? null : wallClockMs - this.context.currentTime * 1000;
    await this.decoder.reset();
  }

  async destroy(): Promise<void> {
    await this.reset();
    await this.decoder.free();
    this.gain.disconnect();
    await this.context.close();
  }

  private schedule(
    pcm: Float32Array,
    sampleRate: number,
    timestampMs?: number
  ): void {
    if (pcm.length === 0) return;
    const buffer = this.context.createBuffer(1, pcm.length, sampleRate);
    buffer.getChannelData(0).set(pcm);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.playbackRate;
    source.connect(this.gain);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
    };
    this.sources.add(source);

    const current = this.context.currentTime;
    if (
      this.nextStartSec < current ||
      this.nextStartSec - current > 0.75
    ) {
      this.nextStartSec = current + 0.08;
    }
    const startAt = this.nextStartSec;
    source.start(startAt);
    this.nextStartSec += buffer.duration / this.playbackRate;
    if (timestampMs != null) {
      this.wallClockOffsetMs = timestampMs - startAt * 1000;
    }
  }

  private applyGain(): void {
    const next = this.muted ? 0 : this.volume;
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.linearRampToValueAtTime(next, this.context.currentTime + 0.05);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
