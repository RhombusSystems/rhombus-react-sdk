import { firstMediaUri } from "./mediaUriPick.js";
import type {
  RhombusAudioSource,
  RhombusConnectionMode,
  RhombusPlayerPaths,
} from "./types.js";
import { appendFederatedAuthQueryParams, joinUrl } from "./urlAuth.js";

export const DEFAULT_AUDIO_PROXY_PATH = "/api/audio-media-uris";
export const DEFAULT_AUDIO_GATEWAY_MEDIA_PATH = "/audiogateway/getMediaUris";
export const DEFAULT_DR40_MEDIA_PATH = "/doorbellcamera/getMediaUris";
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_FRAME_DURATION_MS = 20;
export const AUDIO_SEGMENT_DURATION_MS = 2_000;

export type ResolvedAudioMediaUris = {
  liveOpusUri: string;
  vodMpdUriTemplate: string;
};

export type ResolveAudioMediaUrisOptions = {
  source: RhombusAudioSource;
  connectionMode: RhombusConnectionMode;
  apiOverrideBaseUrl?: string;
  rhombusApiBaseUrl: string;
  paths?: RhombusPlayerPaths;
  federatedSessionToken: string;
  requestHeaders: HeadersInit;
};

/** Resolves A100 or DR40 audio media URIs through the proxy or directly with federated auth. */
export async function resolveAudioMediaUris(
  options: ResolveAudioMediaUrisOptions
): Promise<ResolvedAudioMediaUris> {
  const overrideBase = options.apiOverrideBaseUrl?.trim();
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
    const isGateway = options.source.type === "audio-gateway";
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
  });
  if (!response.ok) {
    throw new Error(
      `Audio media URIs request failed: ${response.status} ${response.statusText}`
    );
  }
  return pickAudioMediaUris(
    await response.json(),
    options.source,
    options.connectionMode
  );
}

/** Selects and normalizes the live Opus and historical MPD fields from getMediaUris. */
export function pickAudioMediaUris(
  mediaJson: unknown,
  source: RhombusAudioSource,
  connectionMode: RhombusConnectionMode
): ResolvedAudioMediaUris {
  if (!mediaJson || typeof mediaJson !== "object") {
    throw new Error("Invalid audio media URIs response");
  }
  const record = mediaJson as Record<string, unknown>;
  const live =
    connectionMode === "wan"
      ? firstMediaUri(record.wanLiveOpusUri)
      : firstMediaUri(record.lanLiveOpusUris) ??
        firstMediaUri(record.lanLiveOpusUri);
  const vod =
    connectionMode === "wan"
      ? firstMediaUri(record.wanVodMpdUriTemplate)
      : firstMediaUri(record.lanVodMpdUrisTemplates);
  if (!live) {
    throw new Error(
      `Invalid audio media URIs response: missing ${connectionMode} live Opus URI`
    );
  }
  if (!vod) {
    throw new Error(
      `Invalid audio media URIs response: missing ${connectionMode} VOD MPD template`
    );
  }
  return {
    liveOpusUri:
      source.type === "audio-gateway" ? appendWebSocketSuffix(live) : live,
    vodMpdUriTemplate: vod,
  };
}

/** A100 media responses omit the terminal `/ws`; normalize it without duplicating the suffix. */
export function appendWebSocketSuffix(uri: string): string {
  const parsed = new URL(uri);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/ws") ? pathname : `${pathname}/ws`;
  return parsed.toString();
}

export type AudioTlvFrame = { data: Uint8Array; farAudio: boolean; type: number };
export type ParsedAudioTlvMessage = {
  timestampMs?: number;
  frames: AudioTlvFrame[];
};

/** Parses one Rhombus live-audio WebSocket message. */
export function parseAudioTlvMessage(input: ArrayBuffer | Uint8Array): ParsedAudioTlvMessage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const result: ParsedAudioTlvMessage = { frames: [] };
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) {
      throw new Error("Malformed audio TLV header");
    }
    const type = bytes[offset++];
    const length =
      (bytes[offset++] << 16) | (bytes[offset++] << 8) | bytes[offset++];
    if (length > bytes.length - offset) {
      throw new Error("Malformed audio TLV payload length");
    }
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    if (type === 0x00) continue;
    if (type === 0x01) {
      if (payload.length !== 8) {
        throw new Error("Malformed audio timestamp record");
      }
      const timestamp = readUint64(payload, 0);
      if (!Number.isSafeInteger(timestamp)) {
        throw new Error("Audio timestamp exceeds JavaScript safe integer range");
      }
      result.timestampMs = timestamp;
      continue;
    }
    result.frames.push({
      data: payload.slice(),
      farAudio: (type & 0x80) === 0x80,
      type,
    });
  }
  return result;
}

export type ParsedHistoricalAudioSegment = {
  timestampMs: number;
  frames: Array<{ data: Uint8Array; timestampMs: number }>;
};

/** Parses the Rhombus two-second historical audio segment envelope. */
export function parseHistoricalAudioSegment(
  input: ArrayBuffer | Uint8Array,
  segmentNumber: number,
  playlistStartMs: number,
  previousSegmentTimestampMs?: number
): ParsedHistoricalAudioSegment {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8) throw new Error("Historical audio segment is too short");
  const encodedTimestamp = readUint64(bytes, 0);
  const timestampMs =
    encodedTimestamp ||
    (previousSegmentTimestampMs != null
      ? previousSegmentTimestampMs + AUDIO_SEGMENT_DURATION_MS
      : playlistStartMs + (segmentNumber - 1) * AUDIO_SEGMENT_DURATION_MS);
  if (!Number.isSafeInteger(timestampMs)) {
    throw new Error("Historical audio timestamp exceeds JavaScript safe integer range");
  }
  const frames: ParsedHistoricalAudioSegment["frames"] = [];
  let offset = 8;
  let frameIndex = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 2) {
      throw new Error("Malformed historical audio frame length");
    }
    const length = (bytes[offset++] << 8) | bytes[offset++];
    if (length > bytes.length - offset) {
      throw new Error("Malformed historical audio frame payload");
    }
    frames.push({
      data: bytes.slice(offset, offset + length),
      timestampMs: timestampMs + frameIndex * AUDIO_FRAME_DURATION_MS,
    });
    offset += length;
    frameIndex++;
  }
  return { timestampMs, frames };
}

export function getHistoricalAudioSegmentNumber(
  playlistStartMs: number,
  targetTimeMs: number
): number {
  return Math.max(
    1,
    Math.floor((Math.floor(targetTimeMs / 1000) - playlistStartMs / 1000) / 2)
  );
}

export function buildHistoricalAudioSegmentUrl(
  vodTemplate: string,
  startTimeSec: number,
  durationSec: number,
  segmentNumber: number
): string {
  return vodTemplate
    .replace(/{START_TIME}/g, String(Math.floor(startTimeSec)))
    .replace(/{DURATION}/g, String(Math.floor(durationSec)))
    .replace(/(clip|file)\.mpd/g, `seg_${segmentNumber}.mpd`);
}

export function formatAudioVodMpdUri(
  template: string,
  startTimeSec: number,
  durationSec: number
): string {
  return template
    .replace(/{START_TIME}/g, String(Math.floor(startTimeSec)))
    .replace(/{DURATION}/g, String(Math.floor(durationSec)));
}

export function supportsOpusWebmMse(): boolean {
  if (
    typeof MediaSource === "undefined" ||
    typeof MediaSource.isTypeSupported !== "function"
  ) {
    return false;
  }
  return (
    MediaSource.isTypeSupported('audio/webm; codecs="opus"') ||
    MediaSource.isTypeSupported("audio/webm;codecs=opus")
  );
}

export function isReconnectMessage(data: unknown): boolean {
  if (typeof data !== "string") return false;
  try {
    const parsed = JSON.parse(data) as { action?: unknown };
    return parsed.action === "reconnect";
  } catch {
    return false;
  }
}

export function withFederatedAudioAuth(url: string, token: string): string {
  return appendFederatedAuthQueryParams(url, token);
}

function readUint64(bytes: Uint8Array, offset: number): number {
  let value = 0n;
  for (let index = 0; index < 8; index++) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return Number(value);
}
