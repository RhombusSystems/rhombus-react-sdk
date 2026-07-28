import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RhombusBufferedPlayer } from "./RhombusBufferedPlayer.js";

const hoisted = vi.hoisted(() => ({
  bufferLoadedHandlers: [] as Array<() => void>,
}));

vi.mock("./dashjsRuntime.js", () => ({
  MediaPlayer: { events: { BUFFER_LOADED: "bufferLoaded" } },
}));

vi.mock("./rhombusPlayback.js", () => {
  const makeFakePlayer = () => ({
    on: (eventName: string, handler: () => void) => {
      if (eventName === "bufferLoaded") hoisted.bufferLoadedHandlers.push(handler);
    },
    off: vi.fn(),
  });
  return {
    DEFAULT_RHOMBUS_API_BASE_URL: "https://api2.rhombussystems.com/api",
    createRhombusDashPlayer: vi.fn(() => makeFakePlayer()),
    createRhombusVodDashPlayer: vi.fn(() => makeFakePlayer()),
    destroyRhombusDashPlayer: vi.fn(),
    fetchFederatedSessionToken: vi.fn(async () => ({ federatedSessionToken: "test-token" })),
    fetchLiveMpdUriDirect: vi.fn(async () => "https://media.test/live.mpd"),
    fetchLiveMpdUriViaOverride: vi.fn(async () => "https://media.test/live.mpd"),
    fetchVodMpdUriDirect: vi.fn(async () => "https://media.test/vod.mpd"),
    fetchVodMpdUriViaOverride: vi.fn(async () => "https://media.test/vod.mpd"),
    getBrowserOrigin: vi.fn(() => "https://app.test"),
    getDashErrorMessage: vi.fn(() => "dash error"),
    getFederatedTokenRefreshDelayMs: vi.fn(() => 3_600_000),
    isRecoverableDashError: vi.fn(() => false),
    mergeRequestHeaders: vi.fn(async () => ({})),
  };
});

let visibilityState: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibilityState = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Overrides the read-only media getters so tests can script playback state. */
function scriptVideo(video: HTMLVideoElement) {
  const state = { paused: false, currentTime: 5 };
  Object.defineProperty(video, "paused", { configurable: true, get: () => state.paused });
  Object.defineProperty(video, "ended", { configurable: true, get: () => false });
  Object.defineProperty(video, "seeking", { configurable: true, get: () => false });
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => state.currentTime,
    set: value => {
      state.currentTime = value;
    },
  });
  return state;
}

async function mountPlayer(onError: (e: Error) => void) {
  const onReady = vi.fn();
  const rendered = render(
    <RhombusBufferedPlayer
      cameraUuid="test-camera"
      apiOverrideBaseUrl="https://proxy.test"
      onReady={onReady}
      onError={onError}
    />
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(onReady).toHaveBeenCalled();
  const video = rendered.container.querySelector("video");
  if (!video) throw new Error("video element not rendered");
  return { video: scriptVideo(video) };
}

async function fireBufferLoaded() {
  const handler = hoisted.bufferLoadedHandlers[hoisted.bufferLoadedHandlers.length - 1];
  if (!handler) throw new Error("BUFFER_LOADED handler was not registered");
  await act(async () => {
    handler();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.bufferLoadedHandlers.length = 0;
  visibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
});

afterEach(() => {
  cleanup();
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  vi.useRealTimers();
});

describe("RhombusBufferedPlayer stall watchdog and hidden tabs", () => {
  it("does not declare a playback stall while the document is hidden, but still catches real stalls once visible", async () => {
    const onError = vi.fn();
    await mountPlayer(onError);
    await fireBufferLoaded();

    // Playing, then the tab goes to the background: currentTime freezes with paused=false
    // (browser suspends the pipeline). Far past stallTimeoutMs, no error may fire.
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(onError).not.toHaveBeenCalled();

    // Back to visible with playback still frozen: the watchdog gets a fresh full window…
    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(onError).not.toHaveBeenCalled();

    // …and only after that window elapses does a real stall surface.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("playback stalled") })
    );
  });

  it("does not declare an initial-buffer stall for a player created in a hidden tab", async () => {
    setVisibility("hidden");
    const onError = vi.fn();
    await mountPlayer(onError);

    // Chrome defers MSE pipeline startup in hidden tabs: readyState stays 0 and no
    // buffer ever loads. The watchdog must wait for visibility, not recreate-loop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(onError).not.toHaveBeenCalled();

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("initial buffer stalled") })
    );
  });

  it("resumes playback on return when the browser paused the video while hidden", async () => {
    const onError = vi.fn();
    const { video } = await mountPlayer(onError);
    await fireBufferLoaded();

    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      video.paused = false;
      return Promise.resolve();
    });

    setVisibility("hidden");
    const videoEl = document.querySelector("video");
    await act(async () => {
      video.paused = true;
      videoEl?.dispatchEvent(new Event("pause"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(onError).not.toHaveBeenCalled();

    await act(async () => {
      setVisibility("visible");
    });
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("does not auto-resume a video the user paused while the tab was visible", async () => {
    const onError = vi.fn();
    const { video } = await mountPlayer(onError);
    await fireBufferLoaded();

    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

    const videoEl = document.querySelector("video");
    await act(async () => {
      video.paused = true;
      videoEl?.dispatchEvent(new Event("pause"));
    });
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(playSpy).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
