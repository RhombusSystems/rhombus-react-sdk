import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RhombusBufferedPlayerHandle,
  RhombusBufferedPlayerProps,
  RhombusPlayerHandle,
  RhombusRealtimePlayerHandle,
  RhombusRealtimePlayerProps,
} from "./types.js";
import { RhombusPlayer } from "./RhombusPlayer.js";
import { useRhombusPlaybackController } from "./useRhombusPlaybackController.js";

vi.mock("./RhombusRealtimePlayer.js", async () => {
  const React = await import("react");
  return {
    RhombusRealtimePlayer: React.forwardRef<
      RhombusRealtimePlayerHandle,
      RhombusRealtimePlayerProps
    >(function MockRhombusRealtimePlayer(_props, ref) {
      const canvasRef = React.useRef<HTMLCanvasElement>(null);
      React.useImperativeHandle(
        ref,
        () => ({ getCanvasElement: () => canvasRef.current }),
        []
      );
      return <canvas ref={canvasRef} width={1920} height={1080} />;
    }),
  };
});

vi.mock("./RhombusBufferedPlayer.js", async () => {
  const React = await import("react");
  return {
    RhombusBufferedPlayer: React.forwardRef<
      RhombusBufferedPlayerHandle,
      RhombusBufferedPlayerProps
    >(function MockRhombusBufferedPlayer(props, ref) {
      const videoRef = React.useRef<HTMLVideoElement>(null);
      React.useImperativeHandle(
        ref,
        () => ({
          getVideoElement: () => videoRef.current,
          getDashPlayer: () => null,
        }),
        []
      );
      React.useEffect(() => {
        const timer = setTimeout(() => props.onReady?.(), 0);
        return () => clearTimeout(timer);
      }, [props.onReady]);
      return <video ref={videoRef} {...props.videoProps} />;
    }),
  };
});

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RhombusPlayer shared buffering", () => {
  it("clears a video waiting state when the buffered element can play", async () => {
    const targetMs = 1_700_000_000_000;

    function Harness() {
      const playback = useRhombusPlaybackController({
        initialMode: "vod",
        initialPositionMs: targetMs,
      });
      return (
        <>
          <output data-testid="status">{playback.state.status}</output>
          <RhombusPlayer
            cameraUuid="camera-1"
            playbackController={playback}
            initialMode="vod"
            initialStartTimeMs={targetMs}
            controls={[]}
            federatedSessionToken="token"
          />
        </>
      );
    }

    const view = render(<Harness />);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ready")
    );

    const video = view.container.querySelector("video");
    expect(video).not.toBeNull();
    fireEvent.waiting(video!);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("buffering")
    );

    Object.defineProperty(video!, "readyState", {
      configurable: true,
      value: HTMLMediaElement.HAVE_FUTURE_DATA,
    });
    fireEvent.canPlay(video!);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ready")
    );
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});

describe("RhombusPlayer freeze-frame overlay", () => {
  it("covers the realtime→VOD swap on pause and clears once the video has a frame", async () => {
    // Realtime transport requires WebCodecs; jsdom has none, so stub it.
    vi.stubGlobal("VideoDecoder", class {});
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,frozen-frame");

    const ref = createRef<RhombusPlayerHandle>();
    const view = render(
      <RhombusPlayer
        ref={ref}
        cameraUuid="camera-1"
        controls={[]}
        federatedSessionToken="token"
      />
    );

    // Live realtime: canvas mounted, no overlay.
    expect(view.container.querySelector("canvas")).not.toBeNull();
    expect(
      view.container.querySelector("[data-rhombus-freeze-frame]")
    ).toBeNull();

    // First pause drops realtime live into paused VOD, swapping canvas → <video>.
    act(() => {
      ref.current!.pause();
    });

    expect(toDataURL).toHaveBeenCalled();
    const video = view.container.querySelector("video");
    expect(video).not.toBeNull();
    const overlay = view.container.querySelector<HTMLImageElement>(
      "[data-rhombus-freeze-frame]"
    );
    expect(overlay).not.toBeNull();
    expect(overlay!.src).toBe("data:image/jpeg;base64,frozen-frame");
    // Pause is a deliberate freeze — no loading indicator.
    expect(
      view.container.querySelector("[data-rhombus-loading-indicator]")
    ).toBeNull();

    // The overlay holds until the fresh <video> actually presents a frame.
    fireEvent.loadedData(video!);
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-rhombus-freeze-frame]")
      ).toBeNull()
    );

    vi.unstubAllGlobals();
  });

  it("shows the loading indicator only while a playing transition is loading", async () => {
    vi.stubGlobal("VideoDecoder", class {});
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/jpeg;base64,frozen-frame"
    );

    const ref = createRef<RhombusPlayerHandle>();
    const view = render(
      <RhombusPlayer
        ref={ref}
        cameraUuid="camera-1"
        controls={[]}
        federatedSessionToken="token"
      />
    );

    // Seeking into VOD while playing: overlay + loading indicator.
    act(() => {
      ref.current!.seekTo(Date.now() - 3_600_000);
    });
    expect(
      view.container.querySelector("[data-rhombus-freeze-frame]")
    ).not.toBeNull();
    expect(
      view.container.querySelector("[data-rhombus-loading-indicator]")
    ).not.toBeNull();

    // Pausing mid-load keeps the frozen frame but drops the indicator.
    act(() => {
      ref.current!.pause();
    });
    expect(
      view.container.querySelector("[data-rhombus-freeze-frame]")
    ).not.toBeNull();
    expect(
      view.container.querySelector("[data-rhombus-loading-indicator]")
    ).toBeNull();

    // First presented frame clears both.
    const video = view.container.querySelector("video");
    fireEvent.loadedData(video!);
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-rhombus-freeze-frame]")
      ).toBeNull()
    );
    expect(
      view.container.querySelector("[data-rhombus-loading-indicator]")
    ).toBeNull();

    vi.unstubAllGlobals();
  });
});
