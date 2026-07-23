import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendWebSocketSuffix,
  buildHistoricalAudioSegmentUrl,
  getHistoricalAudioSegmentNumber,
  parseAudioTlvMessage,
  parseHistoricalAudioSegment,
  pickAudioMediaUris,
  resolveAudioMediaUris,
} from "./audioPlayback.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audio media URI resolution", () => {
  it("normalizes an A100 WebSocket path exactly once", () => {
    expect(appendWebSocketSuffix("wss://media.example/audio/device")).toBe(
      "wss://media.example/audio/device/ws"
    );
    expect(appendWebSocketSuffix("wss://media.example/audio/device/ws")).toBe(
      "wss://media.example/audio/device/ws"
    );
  });

  it("selects WAN and LAN audio fields without changing DR40 paths", () => {
    const response = {
      error: false,
      lanCheckUrls: ["https://lan.example/check"],
      lanLiveMpdUris: ["https://lan.example/live/file.mpd"],
      wanLiveOpusUri: "wss://wan.example/audio/ws",
      lanLiveOpusUris: ["wss://lan.example/audio/ws"],
      wanVodMpdUriTemplate: "https://wan.example/{START_TIME}/{DURATION}/file.mpd",
      lanVodMpdUrisTemplates: [
        "https://lan.example/{START_TIME}/{DURATION}/file.mpd",
      ],
    };
    expect(
      pickAudioMediaUris(response, { type: "dr40", uuid: "doorbell" }, "wan")
    ).toEqual({
      liveOpusUri: "wss://wan.example/audio/ws",
      vodMpdUriTemplate:
        "https://wan.example/{START_TIME}/{DURATION}/file.mpd",
    });
    expect(
      pickAudioMediaUris(
        response,
        { type: "audio-gateway", uuid: "gateway" },
        "lan"
      )
    ).toEqual({
      liveOpusUri: "wss://lan.example/audio/ws",
      vodMpdUriTemplate:
        "https://lan.example/{START_TIME}/{DURATION}/file.mpd",
    });
  });

  it("explains the empty response returned for an unknown or inaccessible device", () => {
    expect(() =>
      pickAudioMediaUris(
        {
          error: false,
          lanCheckUrls: [],
          lanLiveMpdUris: [],
          lanLiveOpusUris: [],
          lanVodMpdUrisTemplates: [],
        },
        { type: "audio-gateway", uuid: "unknown-gateway" },
        "wan"
      )
    ).toThrow(
      "No audio media URIs were returned for this A100 audio gateway. " +
        "Verify that the UUID belongs to a device visible to the authenticated organization."
    );
  });

  it("preserves upstream errors and suggests an available network mode", () => {
    expect(() =>
      pickAudioMediaUris(
        { error: true, errorMsg: "Audio access denied" },
        { type: "dr40", uuid: "doorbell" },
        "wan"
      )
    ).toThrow("Audio media URIs request failed: Audio access denied");

    expect(() =>
      pickAudioMediaUris(
        {
          lanLiveOpusUris: ["wss://lan.example/audio"],
          lanVodMpdUrisTemplates: [
            "https://lan.example/{START_TIME}/{DURATION}/file.mpd",
          ],
        },
        { type: "audio-gateway", uuid: "gateway" },
        "wan"
      )
    ).toThrow('No WAN live Opus URI was returned. Try connectionMode="lan".');
  });

  it("uses exact direct endpoint bodies and federated headers", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            wanLiveOpusUri: "wss://media.example/device",
            wanVodMpdUriTemplate:
              "https://media.example/{START_TIME}/{DURATION}/file.mpd",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await resolveAudioMediaUris({
      source: { type: "audio-gateway", uuid: "gateway-1" },
      connectionMode: "wan",
      rhombusApiBaseUrl: "https://api.example/api",
      federatedSessionToken: "ft",
      requestHeaders: {},
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example/api/audiogateway/getMediaUris",
      expect.objectContaining({
        body: JSON.stringify({ gatewayUuid: "gateway-1" }),
        headers: expect.objectContaining({
          "x-auth-scheme": "federated-token",
          "x-auth-ft": "ft",
        }),
      })
    );

    await resolveAudioMediaUris({
      source: { type: "dr40", uuid: "doorbell-1" },
      connectionMode: "wan",
      rhombusApiBaseUrl: "https://api.example/api",
      federatedSessionToken: "ft",
      requestHeaders: {},
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.example/api/doorbellcamera/getMediaUris",
      expect.objectContaining({
        body: JSON.stringify({ deviceUuid: "doorbell-1" }),
      })
    );
  });

  it("uses the unified proxy body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          wanLiveOpusUri: "wss://media.example/device/ws",
          wanVodMpdUriTemplate:
            "https://media.example/{START_TIME}/{DURATION}/file.mpd",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const source = { type: "dr40", uuid: "doorbell-1" } as const;
    await resolveAudioMediaUris({
      source,
      connectionMode: "wan",
      apiOverrideBaseUrl: "https://proxy.example",
      rhombusApiBaseUrl: "https://api.example",
      federatedSessionToken: "ft",
      requestHeaders: { Authorization: "Bearer app" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.example/api/audio-media-uris",
      expect.objectContaining({ body: JSON.stringify({ source }) })
    );
  });
});

describe("audio frame parsing", () => {
  it("parses stats, timestamp, normal, and far-audio TLVs", () => {
    const timestamp = 1_700_000_000_123n;
    const timestampBytes = Array.from({ length: 8 }, (_, index) =>
      Number((timestamp >> BigInt((7 - index) * 8)) & 0xffn)
    );
    const bytes = new Uint8Array([
      0x00, 0, 0, 2, 0, 10,
      0x01, 0, 0, 8, ...timestampBytes,
      0x02, 0, 0, 3, 1, 2, 3,
      0x82, 0, 0, 2, 4, 5,
    ]);
    const parsed = parseAudioTlvMessage(bytes);
    expect(parsed.timestampMs).toBe(Number(timestamp));
    expect(parsed.frames.map(frame => [...frame.data])).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(parsed.frames.map(frame => frame.farAudio)).toEqual([false, true]);
  });

  it("rejects malformed TLVs", () => {
    expect(() => parseAudioTlvMessage(new Uint8Array([2, 0, 0, 4, 1]))).toThrow(
      "payload length"
    );
  });

  it("parses historical timestamps and length-prefixed frames", () => {
    const timestamp = 1_700_000_000_000n;
    const timestampBytes = Array.from({ length: 8 }, (_, index) =>
      Number((timestamp >> BigInt((7 - index) * 8)) & 0xffn)
    );
    const parsed = parseHistoricalAudioSegment(
      new Uint8Array([
        ...timestampBytes,
        0, 3, 1, 2, 3,
        0, 2, 4, 5,
      ]),
      1,
      Number(timestamp)
    );
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[1].timestampMs).toBe(Number(timestamp) + 20);
  });

  it("builds and indexes historical segment requests", () => {
    const start = 1_700_000_000_000;
    expect(getHistoricalAudioSegmentNumber(start, start + 10_000)).toBe(5);
    expect(
      buildHistoricalAudioSegmentUrl(
        "https://media/{START_TIME}/{DURATION}/vod/file.mpd",
        start / 1000,
        120,
        5
      )
    ).toBe(
      "https://media/1700000000/120/vod/seg_5.mpd"
    );
  });
});
