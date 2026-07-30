import {
  DEFAULT_AUDIO_GATEWAY_MEDIA_PATH,
  DEFAULT_AUDIO_PROXY_PATH,
  DEFAULT_DR40_MEDIA_PATH,
  appendWebSocketSuffix,
} from "./audioPlayback.js";
import { firstMediaUri } from "./mediaUriPick.js";
import type {
  RhombusAudioSource,
  RhombusConnectionMode,
  RhombusPlayerPaths,
  RhombusTalkbackCapability,
} from "./types.js";
import { joinUrl } from "./urlAuth.js";

export const DEFAULT_AUDIO_TALKBACK_CAPABILITIES_PATH =
  "/api/audio-talkback-capabilities";
export const TALKBACK_SAMPLE_RATE = 48_000;
export const TALKBACK_FRAME_SAMPLES = 960;
export const TALKBACK_FRAME_BYTES = TALKBACK_FRAME_SAMPLES * 2;

export type ResolveTalkbackCapabilityOptions = {
  source: RhombusAudioSource;
  apiOverrideBaseUrl: string;
  path?: string;
  requestHeaders: HeadersInit;
  signal?: AbortSignal;
};

/** Resolves the proxy-normalized RBAC, license, and device capability for talkback. */
export async function resolveTalkbackCapability(
  options: ResolveTalkbackCapabilityOptions
): Promise<RhombusTalkbackCapability> {
  const response = await fetch(
    joinUrl(
      options.apiOverrideBaseUrl,
      options.path ?? DEFAULT_AUDIO_TALKBACK_CAPABILITIES_PATH
    ),
    {
      method: "POST",
      headers: options.requestHeaders,
      body: JSON.stringify({ source: options.source }),
      signal: options.signal,
    }
  );
  if (!response.ok) {
    throw new Error(
      `Audio talkback capability request failed: ${response.status} ${response.statusText}`
    );
  }
  return parseTalkbackCapability(await response.json());
}

export type ResolveAudioTalkbackUriOptions = {
  source: RhombusAudioSource;
  connectionMode: RhombusConnectionMode;
  apiOverrideBaseUrl?: string;
  rhombusApiBaseUrl: string;
  paths?: RhombusPlayerPaths;
  federatedSessionToken: string;
  requestHeaders: HeadersInit;
  signal?: AbortSignal;
};

/**
 * Resolves only the realtime audio URI. Unlike the playback resolver, this works for
 * LIVEONLY roles whose media response intentionally omits historical audio fields.
 */
export async function resolveAudioTalkbackUri(
  options: ResolveAudioTalkbackUriOptions
): Promise<string> {
  const overrideBase = options.apiOverrideBaseUrl?.trim();
  const isGateway = options.source.type === "audio-gateway";
  let url: string;
  let headers: HeadersInit;
  let body: unknown;

  if (overrideBase) {
    url = joinUrl(
      overrideBase,
      options.paths?.audioMediaUris ?? DEFAULT_AUDIO_PROXY_PATH
    );
    headers = options.requestHeaders;
    body = { source: options.source };
  } else {
    const path = isGateway
      ? options.paths?.audioGatewayMediaUris ?? DEFAULT_AUDIO_GATEWAY_MEDIA_PATH
      : options.paths?.dr40MediaUris ?? DEFAULT_DR40_MEDIA_PATH;
    url = joinUrl(options.rhombusApiBaseUrl, path);
    headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-auth-scheme": "federated-token",
      "x-auth-ft": options.federatedSessionToken,
    };
    body = isGateway
      ? { gatewayUuid: options.source.uuid }
      : { deviceUuid: options.source.uuid };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Audio talkback media request failed: ${response.status} ${response.statusText}`
    );
  }
  return pickAudioTalkbackUri(
    await response.json(),
    options.source,
    options.connectionMode
  );
}

/** Builds the one-time "play immediately" prefix required by every talkback socket. */
export function buildTalkbackControlPacket(): Uint8Array {
  return new Uint8Array([
    0x63, 0x74, 0x72, 0x6c,
    0x00, 0x00, 0x00, 0x08,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
}

/**
 * Stateful linear resampler and PCM16 frame accumulator. Input may arrive at any browser
 * AudioContext sample rate; output is always exact 20 ms / 1,920-byte frames at 48 kHz.
 */
export class TalkbackPcmEncoder {
  private readonly gain: number;
  private inputRate = 0;
  private input: number[] = [];
  private readPosition = 0;
  private frame = new Int16Array(TALKBACK_FRAME_SAMPLES);
  private frameOffset = 0;

  constructor(gain: number) {
    this.gain = Number.isFinite(gain) ? Math.max(0, gain) : 6;
  }

  push(samples: Float32Array, inputSampleRate: number): Int16Array[] {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
      throw new Error("Invalid microphone sample rate");
    }
    if (this.inputRate !== inputSampleRate) {
      this.reset();
      this.inputRate = inputSampleRate;
    }
    for (let index = 0; index < samples.length; index++) {
      this.input.push(samples[index]);
    }

    const output: Int16Array[] = [];
    const step = inputSampleRate / TALKBACK_SAMPLE_RATE;
    while (this.readPosition + 1 < this.input.length) {
      const leftIndex = Math.floor(this.readPosition);
      const fraction = this.readPosition - leftIndex;
      const value =
        this.input[leftIndex] +
        (this.input[leftIndex + 1] - this.input[leftIndex]) * fraction;
      const amplified = Math.max(-1, Math.min(1, value * this.gain));
      this.frame[this.frameOffset++] =
        amplified < 0
          ? Math.round(amplified * 0x8000)
          : Math.round(amplified * 0x7fff);
      this.readPosition += step;

      if (this.frameOffset === TALKBACK_FRAME_SAMPLES) {
        output.push(this.frame);
        this.frame = new Int16Array(TALKBACK_FRAME_SAMPLES);
        this.frameOffset = 0;
      }
    }

    const consumed = Math.floor(this.readPosition);
    if (consumed > 0) {
      this.input.splice(0, consumed);
      this.readPosition -= consumed;
    }
    return output;
  }

  reset(): void {
    this.input = [];
    this.readPosition = 0;
    this.frame = new Int16Array(TALKBACK_FRAME_SAMPLES);
    this.frameOffset = 0;
  }
}

function parseTalkbackCapability(value: unknown): RhombusTalkbackCapability {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid audio talkback capability response");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.canTalk !== "boolean" ||
    typeof record.authorized !== "boolean" ||
    typeof record.licensed !== "boolean" ||
    typeof record.speakerEnabled !== "boolean" ||
    (record.interactionMode !== "toggle" && record.interactionMode !== "hold")
  ) {
    throw new Error("Invalid audio talkback capability response");
  }
  const connected =
    typeof record.connected === "boolean" ? record.connected : undefined;
  const allowedReasons = new Set([
    "not-authorized",
    "license-required",
    "speaker-disabled",
    "device-unavailable",
    "capability-unavailable",
  ]);
  const suppliedReason =
    typeof record.reason === "string" && allowedReasons.has(record.reason)
      ? (record.reason as RhombusTalkbackCapability["reason"])
      : undefined;
  const authorized = record.authorized as boolean;
  const licensed = record.licensed as boolean;
  const speakerEnabled = record.speakerEnabled as boolean;
  const canTalk =
    (record.canTalk as boolean) &&
    authorized &&
    licensed &&
    speakerEnabled &&
    connected !== false;
  const reason =
    suppliedReason ??
    (!authorized
      ? "not-authorized"
      : !licensed
        ? "license-required"
        : !speakerEnabled
          ? "speaker-disabled"
          : connected === false
            ? "device-unavailable"
            : undefined);
  return {
    canTalk,
    interactionMode: record.interactionMode,
    authorized,
    licensed,
    speakerEnabled,
    connected,
    reason,
  };
}

function pickAudioTalkbackUri(
  mediaJson: unknown,
  source: RhombusAudioSource,
  connectionMode: RhombusConnectionMode
): string {
  if (!mediaJson || typeof mediaJson !== "object") {
    throw new Error("Invalid audio talkback media response");
  }
  const record = mediaJson as Record<string, unknown>;
  if (record.error === true) {
    const message =
      typeof record.errorMsg === "string" && record.errorMsg.trim()
        ? record.errorMsg.trim()
        : "the Rhombus API returned an error";
    throw new Error(`Audio talkback media request failed: ${message}`);
  }
  const live =
    connectionMode === "wan"
      ? firstMediaUri(record.wanLiveOpusUri)
      : firstMediaUri(record.lanLiveOpusUris) ??
        firstMediaUri(record.lanLiveOpusUri);
  if (!live) {
    throw new Error(
      `No ${connectionMode.toUpperCase()} live talkback URI was returned`
    );
  }
  return source.type === "audio-gateway"
    ? appendWebSocketSuffix(live)
    : live;
}
