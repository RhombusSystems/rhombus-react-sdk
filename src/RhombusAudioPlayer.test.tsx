import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RhombusAudioPlayer } from "./RhombusAudioPlayer.js";

const mocks = vi.hoisted(() => ({
  engines: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    enqueueOpus: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    setMuted: ReturnType<typeof vi.fn>;
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

  it("discards an isolated non-TLV A100 startup packet", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mediaResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    render(
      <RhombusAudioPlayer
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        federatedSessionToken="token"
        controls={[]}
        onError={onError}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    const malformedStartupPacket = new Uint8Array([
      0xfb, 0xeb, 0xc7, 0x23, 0xa3, 0x82,
    ]).buffer;
    const validPacket = new Uint8Array([
      0x00, 0, 0, 2, 0, 1,
      0x01, 0, 0, 8, 0, 0, 1, 0x9f, 0x90, 0x6a, 0x41, 0x03,
      0x04, 0, 0, 3, 1, 2, 3,
    ]).buffer;

    act(() => {
      socket.onmessage?.({ data: malformedStartupPacket } as MessageEvent);
      socket.onmessage?.({ data: validPacket } as MessageEvent);
    });

    expect(onError).not.toHaveBeenCalled();
    expect(mocks.engines[0]?.enqueueOpus).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      1_784_834_310_403
    );
  });

  it("reports and closes a stream with repeated malformed TLVs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mediaResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    render(
      <RhombusAudioPlayer
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        federatedSessionToken="token"
        controls={[]}
        onError={onError}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    const malformedPacket = new Uint8Array([
      0xfb, 0xeb, 0xc7, 0x23, 0xa3, 0x82,
    ]).buffer;
    act(() => {
      socket.onmessage?.({ data: malformedPacket } as MessageEvent);
      socket.onmessage?.({ data: malformedPacket } as MessageEvent);
      socket.onmessage?.({ data: malformedPacket } as MessageEvent);
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Live audio stream sent three consecutive malformed TLV messages",
      })
    );
    expect(socket.close).toHaveBeenCalled();
  });

  it("resumes Web Audio directly from the unmute gesture", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mediaResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RhombusAudioPlayer
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        federatedSessionToken="token"
        controls={["volume"]}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const engine = mocks.engines[0];
    const playCallsBeforeUnmute = engine.play.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Unmute audio" })
    );

    expect(engine.setMuted).toHaveBeenCalledWith(false);
    expect(engine.play.mock.calls.length).toBeGreaterThan(
      playCallsBeforeUnmute
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Mute audio" })
      ).toBeTruthy()
    );
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
