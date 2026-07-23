import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RhombusBufferedPlayerHandle,
  RhombusBufferedPlayerProps,
} from "./types.js";
import { RhombusPlayer } from "./RhombusPlayer.js";
import { useRhombusPlaybackController } from "./useRhombusPlaybackController.js";

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
