import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RhombusTalkback } from "./RhombusTalkback.js";
import type { RhombusTalkbackCapability } from "./types.js";

const allowedHoldCapability: RhombusTalkbackCapability = {
  canTalk: true,
  interactionMode: "hold",
  authorized: true,
  licensed: true,
  speakerEnabled: true,
  connected: true,
};

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
}

class MockScriptProcessorNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;
  connect = vi.fn(() => this);
  disconnect = vi.fn();
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];

  sampleRate = 48_000;
  state: AudioContextState = "running";
  destination = {} as AudioDestinationNode;
  audioWorklet = undefined;
  processor = new MockScriptProcessorNode();
  source = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  gain = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return this.source;
  }

  createGain() {
    return this.gain;
  }

  createScriptProcessor() {
    return this.processor;
  }
}

function processMicrophoneFrame(context = MockAudioContext.instances[0]) {
  act(() => {
    context.processor.onaudioprocess?.({
      inputBuffer: {
        sampleRate: 48_000,
        getChannelData: () => new Float32Array(1_024).fill(0.1),
      },
      outputBuffer: {
        getChannelData: () => new Float32Array(1_024),
      },
    } as unknown as AudioProcessingEvent);
  });
}

const trackStop = vi.fn();
const mediaStream = {
  getTracks: () => [{ stop: trackStop }],
} as unknown as MediaStream;

beforeEach(() => {
  MockWebSocket.instances = [];
  MockAudioContext.instances = [];
  trackStop.mockReset();
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("ScriptProcessorNode", MockScriptProcessorNode);
  vi.stubGlobal("AudioWorkletNode", undefined);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(mediaStream),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RhombusTalkback", () => {
  it("holds to talk and sends control before exact PCM frames", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes("audio-talkback-capabilities")) {
        return Promise.resolve(
          new Response(JSON.stringify(allowedHoldCapability), { status: 200 })
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            wanLiveOpusUri: "wss://media.example/audio/gateway-1",
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const onTalkingChange = vi.fn();

    render(
      <RhombusTalkback
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="ft"
        onTalkingChange={onTalkingChange}
      />
    );

    const button = await screen.findByRole("button", {
      name: "Hold to talk",
    });
    fireEvent.pointerDown(button);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(MockAudioContext.instances).toHaveLength(1));

    act(() => MockWebSocket.instances[0].open());
    await screen.findByRole("button", { name: "Talking" });
    processMicrophoneFrame();

    expect(MockWebSocket.instances[0].send).toHaveBeenCalledTimes(2);
    expect([
      ...(MockWebSocket.instances[0].send.mock.calls[0][0] as Uint8Array),
    ]).toEqual([
      0x63, 0x74, 0x72, 0x6c,
      0, 0, 0, 8,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
    expect(
      MockWebSocket.instances[0].send.mock.calls[1][0]
    ).toBeInstanceOf(Int16Array);
    expect(
      (MockWebSocket.instances[0].send.mock.calls[1][0] as Int16Array)
        .byteLength
    ).toBe(1_920);

    fireEvent.pointerUp(button);
    expect(trackStop).toHaveBeenCalled();
    expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    expect(onTalkingChange).toHaveBeenCalledWith(true);
    expect(onTalkingChange).toHaveBeenLastCalledWith(false);
  });

  it("uses toggle interaction when effective device AEC is enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            wanLiveOpusUri: "wss://media.example/audio/dr40-1/ws",
          }),
          { status: 200 }
        )
      )
    );
    const capability: RhombusTalkbackCapability = {
      ...allowedHoldCapability,
      interactionMode: "toggle",
    };
    render(
      <RhombusTalkback
        source={{ type: "dr40", uuid: "dr40-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="ft"
        capability={capability}
      />
    );

    const start = await screen.findByRole("button", {
      name: "Click to talk",
    });
    fireEvent.click(start);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => MockWebSocket.instances[0].open());
    const stop = await screen.findByRole("button", {
      name: "Click to end talk",
    });
    fireEvent.click(stop);

    expect(trackStop).toHaveBeenCalled();
    expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
  });

  it("allows talkback while viewing VOD by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            wanLiveOpusUri: "wss://media.example/audio/gateway-1",
          }),
          { status: 200 }
        )
      )
    );
    render(
      <RhombusTalkback
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="ft"
        capability={allowedHoldCapability}
        viewingMode="vod"
      />
    );

    const button = await screen.findByRole("button", {
      name: "Hold to talk",
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks and stops talkback when VOD policy is enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            wanLiveOpusUri: "wss://media.example/audio/gateway-1",
          }),
          { status: 200 }
        )
      )
    );
    const view = render(
      <RhombusTalkback
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="ft"
        capability={allowedHoldCapability}
        viewingMode="live"
        disableTalkbackInVod
      />
    );
    const button = await screen.findByRole("button", {
      name: "Hold to talk",
    });
    fireEvent.pointerDown(button);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    view.rerender(
      <RhombusTalkback
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="ft"
        capability={allowedHoldCapability}
        viewingMode="vod"
        disableTalkbackInVod
      />
    );

    const blocked = await screen.findByRole("button", {
      name: "Talk unavailable",
    });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Unavailable while viewing history")).toBeTruthy();
    expect(trackStop).toHaveBeenCalled();
    expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
  });

  it("does not request microphone access when the capability proxy denies talkback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...allowedHoldCapability,
            canTalk: false,
            authorized: false,
            reason: "not-authorized",
          }),
          { status: 200 }
        )
      )
    );
    render(
      <RhombusTalkback
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="ft"
      />
    );

    const button = await screen.findByRole("button", {
      name: "Talk unavailable",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Role lacks device access")).toBeTruthy();
    fireEvent.pointerDown(button);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("reconnects with a rotated token and sends a fresh control prefix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            wanLiveOpusUri: "wss://media.example/audio/gateway-1",
          }),
          { status: 200 }
        )
      )
    );
    const view = render(
      <RhombusTalkback
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="token-one"
        capability={allowedHoldCapability}
      />
    );
    const button = await screen.findByRole("button", {
      name: "Hold to talk",
    });
    fireEvent.pointerDown(button);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => MockWebSocket.instances[0].open());
    processMicrophoneFrame();

    view.rerender(
      <RhombusTalkback
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="token-two"
        capability={allowedHoldCapability}
      />
    );
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(MockWebSocket.instances[1].url).toContain("x-auth-ft=token-two");
    act(() => MockWebSocket.instances[1].open());
    processMicrophoneFrame();

    expect(MockWebSocket.instances[1].send).toHaveBeenCalledTimes(2);
    expect([
      ...(MockWebSocket.instances[1].send.mock.calls[0][0] as Uint8Array),
    ]).toEqual([
      0x63, 0x74, 0x72, 0x6c,
      0, 0, 0, 8,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("cannot transmit to a previous device while a changed source resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          source: { uuid: string };
        };
        if (body.source.uuid === "dr40-2") {
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              wanLiveOpusUri: "wss://media.example/audio/gateway-1",
            }),
            { status: 200 }
          )
        );
      })
    );
    const view = render(
      <RhombusTalkback
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="ft"
        capability={allowedHoldCapability}
      />
    );
    await screen.findByRole("button", { name: "Hold to talk" });

    view.rerender(
      <RhombusTalkback
        source={{ type: "dr40", uuid: "dr40-2" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="ft"
        capability={allowedHoldCapability}
      />
    );

    const button = screen.getByRole("button", { name: "Talk unavailable" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Checking access…")).toBeTruthy();
    fireEvent.pointerDown(button);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("allows inline slot styles to override the default presentation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            wanLiveOpusUri: "wss://media.example/audio/gateway-1",
          }),
          { status: 200 }
        )
      )
    );
    render(
      <RhombusTalkback
        source={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="https://app.example"
        federatedSessionToken="ft"
        capability={allowedHoldCapability}
        styles={{ button: { background: "rgb(1, 2, 3)", borderRadius: 4 } }}
      />
    );

    const button = await screen.findByRole("button", {
      name: "Hold to talk",
    });
    expect(button.style.background).toBe("rgb(1, 2, 3)");
    expect(button.style.borderRadius).toBe("4px");
  });
});
