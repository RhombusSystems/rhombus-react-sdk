import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TALKBACK_FRAME_BYTES,
  TALKBACK_FRAME_SAMPLES,
  TalkbackPcmEncoder,
  buildTalkbackControlPacket,
  resolveAudioTalkbackUri,
  resolveTalkbackCapability,
} from "./audioTalkback.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("audio talkback protocol", () => {
  it("builds the exact play-ASAP control packet", () => {
    expect([...buildTalkbackControlPacket()]).toEqual([
      0x63, 0x74, 0x72, 0x6c,
      0x00, 0x00, 0x00, 0x08,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("emits exact 20 ms PCM16 frames with gain and clipping", () => {
    const encoder = new TalkbackPcmEncoder(2);
    const samples = new Float32Array(TALKBACK_FRAME_SAMPLES + 1);
    samples.fill(0.75);
    const frames = encoder.push(samples, 48_000);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(TALKBACK_FRAME_SAMPLES);
    expect(frames[0].byteLength).toBe(TALKBACK_FRAME_BYTES);
    expect(frames[0][0]).toBe(32_767);
  });

  it("resamples a 44.1 kHz input into 48 kHz frames", () => {
    const encoder = new TalkbackPcmEncoder(1);
    const frames = encoder.push(new Float32Array(1_765).fill(0.25), 44_100);

    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]).toHaveLength(960);
    expect(frames[0][100]).toBeCloseTo(8_192, -1);
  });
});

describe("audio talkback request contracts", () => {
  it("posts the source to the normalized capability proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          canTalk: true,
          interactionMode: "toggle",
          authorized: true,
          licensed: true,
          speakerEnabled: true,
          connected: true,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveTalkbackCapability({
        source: { type: "audio-gateway", uuid: "gateway-1" },
        apiOverrideBaseUrl: "https://app.example",
        requestHeaders: { Authorization: "Bearer app" },
      })
    ).resolves.toMatchObject({
      canTalk: true,
      interactionMode: "toggle",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.example/api/audio-talkback-capabilities",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          source: { type: "audio-gateway", uuid: "gateway-1" },
        }),
      })
    );
  });

  it("fails closed when capability booleans are internally inconsistent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            canTalk: true,
            interactionMode: "hold",
            authorized: false,
            licensed: true,
            speakerEnabled: true,
            connected: true,
          }),
          { status: 200 }
        )
      )
    );

    await expect(
      resolveTalkbackCapability({
        source: { type: "dr40", uuid: "dr40-1" },
        apiOverrideBaseUrl: "https://app.example",
        requestHeaders: {},
      })
    ).resolves.toMatchObject({
      canTalk: false,
      authorized: false,
    });
  });

  it("resolves A100 live talkback without requiring historical fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          wanLiveOpusUri: "wss://media.example/audio/gateway-1",
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveAudioTalkbackUri({
        source: { type: "audio-gateway", uuid: "gateway-1" },
        connectionMode: "wan",
        apiOverrideBaseUrl: "https://app.example",
        rhombusApiBaseUrl: "https://rhombus.example/api",
        federatedSessionToken: "ft",
        requestHeaders: { "Content-Type": "application/json" },
      })
    ).resolves.toBe("wss://media.example/audio/gateway-1/ws");
  });

  it("uses the DR40 direct endpoint, body, and federated headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          wanLiveOpusUri:
            "wss://media.example/api/audio/live/dr40-1/ws",
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const uri = await resolveAudioTalkbackUri({
      source: { type: "dr40", uuid: "dr40-1" },
      connectionMode: "wan",
      rhombusApiBaseUrl: "https://rhombus.example/api",
      federatedSessionToken: "ft",
      requestHeaders: {},
    });

    expect(uri).toBe(
      "wss://media.example/api/audio/live/dr40-1/ws"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rhombus.example/api/doorbellcamera/getMediaUris",
      expect.objectContaining({
        body: JSON.stringify({ deviceUuid: "dr40-1" }),
        headers: expect.objectContaining({
          "x-auth-scheme": "federated-token",
          "x-auth-ft": "ft",
        }),
      })
    );
  });
});
