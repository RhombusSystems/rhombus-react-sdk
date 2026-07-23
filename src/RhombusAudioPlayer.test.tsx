import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RhombusAudioPlayer } from "./RhombusAudioPlayer.js";

const mocks = vi.hoisted(() => ({
  engines: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("./audioPcmEngine.js", () => ({
  AudioPcmEngine: class {
    destroy = vi.fn().mockResolvedValue(undefined);

    constructor() {
      mocks.engines.push(this);
    }

    ready = vi.fn().mockResolvedValue(undefined);
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn().mockResolvedValue(undefined);
    reset = vi.fn().mockResolvedValue(undefined);
    setMuted = vi.fn();
    setVolume = vi.fn();
    setPlaybackRate = vi.fn();
    enqueueOpus = vi.fn();
    getWallClockMs = vi.fn().mockReturnValue(null);
    getBufferedDurationSec = vi.fn().mockReturnValue(0);
  },
}));

vi.mock("./dashjsRuntime.js", () => {
  const create = vi.fn(() => ({
    extend: vi.fn(),
    updateSettings: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    initialize: vi.fn(),
    attachSource: vi.fn(),
    reset: vi.fn(),
  }));
  return {
    MediaPlayer: Object.assign(() => ({ create }), {
      events: { ERROR: "error" },
    }),
  };
});

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
}

const mediaResponse = {
  wanLiveOpusUri: "wss://media.example/gateway",
  wanVodMpdUriTemplate:
    "https://media.example/{START_TIME}/{DURATION}/file.mpd",
};

beforeEach(() => {
  MockWebSocket.instances = [];
  mocks.engines.length = 0;
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("MediaSource", undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RhombusAudioPlayer transports", () => {
  it("authenticates and reconnects live audio when the supplied token rotates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mediaResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const source = { type: "audio-gateway", uuid: "gateway-1" } as const;
    const view = render(
      <RhombusAudioPlayer
        source={source}
        federatedSessionToken="token-1"
        controls={[]}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(new URL(MockWebSocket.instances[0].url).pathname).toBe("/gateway/ws");
    expect(new URL(MockWebSocket.instances[0].url).searchParams.get("x-auth-ft")).toBe(
      "token-1"
    );

    view.rerender(
      <RhombusAudioPlayer
        source={source}
        federatedSessionToken="token-2"
        controls={[]}
      />
    );
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    expect(new URL(MockWebSocket.instances[1].url).searchParams.get("x-auth-ft")).toBe(
      "token-2"
    );

    view.unmount();
    expect(MockWebSocket.instances[1].close).toHaveBeenCalled();
    expect(mocks.engines[mocks.engines.length - 1]?.destroy).toHaveBeenCalled();
  });

  it("authenticates and aborts decoded historical segment requests on cleanup", async () => {
    let historicalSignal: AbortSignal | undefined;
    let historicalUrl = "";
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify(mediaResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      historicalUrl = String(input);
      historicalSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <RhombusAudioPlayer
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        federatedSessionToken="history-token"
        initialMode="vod"
        initialStartTimeMs={1_700_000_000_000}
        controls={[]}
      />
    );

    await waitFor(() => expect(historicalUrl).toContain("seg_"));
    expect(new URL(historicalUrl).searchParams.get("x-auth-ft")).toBe(
      "history-token"
    );
    expect(historicalSignal?.aborted).toBe(false);

    view.unmount();
    expect(historicalSignal?.aborted).toBe(true);
    expect(mocks.engines[mocks.engines.length - 1]?.destroy).toHaveBeenCalled();
  });
});
