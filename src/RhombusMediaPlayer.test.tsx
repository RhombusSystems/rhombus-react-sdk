import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RhombusMediaPlayer } from "./RhombusMediaPlayer.js";
import type { RhombusMediaPlayerHandle } from "./types.js";

const mocks = vi.hoisted(() => ({
  videoProps: [] as Array<Record<string, unknown>>,
  audioProps: [] as Array<Record<string, unknown>>,
  talkbackProps: [] as Array<Record<string, unknown>>,
  videoHandle: { kind: "video" },
  audioHandle: { kind: "audio" },
  talkbackHandle: { kind: "talkback" },
}));

vi.mock("./RhombusPlayer.js", async () => {
  const React = await import("react");
  return {
    RhombusPlayer: React.forwardRef(
      (props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
        mocks.videoProps.push(props);
        React.useImperativeHandle(ref, () => mocks.videoHandle);
        return React.createElement("div", { "data-testid": "video-player" });
      }
    ),
  };
});

vi.mock("./RhombusAudioPlayer.js", async () => {
  const React = await import("react");
  return {
    RhombusAudioPlayer: React.forwardRef(
      (props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
        mocks.audioProps.push(props);
        React.useImperativeHandle(ref, () => mocks.audioHandle);
        return React.createElement("div", { "data-testid": "audio-player" });
      }
    ),
  };
});

vi.mock("./RhombusTalkback.js", async () => {
  const React = await import("react");
  return {
    RhombusTalkback: React.forwardRef(
      (props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
        mocks.talkbackProps.push(props);
        React.useImperativeHandle(ref, () => mocks.talkbackHandle);
        return React.createElement("div", { "data-testid": "talkback" });
      }
    ),
  };
});

afterEach(() => {
  cleanup();
  mocks.videoProps.length = 0;
  mocks.audioProps.length = 0;
  mocks.talkbackProps.length = 0;
  vi.restoreAllMocks();
});

function last<T>(values: T[]): T | undefined {
  return values[values.length - 1];
}

describe("RhombusMediaPlayer", () => {
  it("coordinates video, audio, and talkback with sensible paired defaults", () => {
    render(
      <RhombusMediaPlayer
        cameraUuid="camera-1"
        audioSource={{ type: "audio-gateway", uuid: "gateway-1" }}
        apiOverrideBaseUrl="/"
        connectionMode="wan"
        federatedSessionToken="token"
      />
    );

    expect(screen.getByTestId("video-player")).toBeTruthy();
    expect(screen.getByTestId("audio-player")).toBeTruthy();
    expect(screen.getByTestId("talkback")).toBeTruthy();

    const video = last(mocks.videoProps);
    const audio = last(mocks.audioProps);
    const talkback = last(mocks.talkbackProps);
    expect(video?.cameraUuid).toBe("camera-1");
    expect(audio?.source).toEqual({
      type: "audio-gateway",
      uuid: "gateway-1",
    });
    expect(talkback?.source).toEqual(audio?.source);
    expect(audio?.controls).toEqual(["volume"]);
    expect(video?.playbackController).toBe(audio?.playbackController);
    expect(talkback?.playbackController).toBe(audio?.playbackController);
    expect(talkback?.disableTalkbackInVod).toBe(false);
    expect(video?.apiOverrideBaseUrl).toBe("/");
    expect(audio?.connectionMode).toBe("wan");
    expect(talkback?.federatedSessionToken).toBe("token");
  });

  it("renders full audio controls without video and can disable talkback", () => {
    const view = render(
      <RhombusMediaPlayer
        audioSource={{ type: "dr40", uuid: "dr40-1" }}
        talkback={false}
        className="consumer-root"
        classNames={{ root: "design-root", audio: "audio-slot" }}
        styles={{ root: { gap: 24 }, audio: { padding: 4 } }}
        style={{ gap: 32 }}
      />
    );

    expect(screen.queryByTestId("video-player")).toBeNull();
    expect(screen.getByTestId("audio-player")).toBeTruthy();
    expect(screen.queryByTestId("talkback")).toBeNull();
    expect(last(mocks.audioProps)?.controls).toBeUndefined();

    const root = view.container.firstElementChild as HTMLElement;
    expect(root.className).toContain("rhombus-media-player");
    expect(root.className).toContain("design-root");
    expect(root.className).toContain("consumer-root");
    expect(root.style.gap).toBe("32px");
    const audioSlot = root.querySelector(".audio-slot") as HTMLElement;
    expect(audioSlot.style.padding).toBe("4px");
  });

  it("honors nested overrides without allowing them to break coordination", () => {
    render(
      <RhombusMediaPlayer
        cameraUuid="camera-1"
        audioSource={{ type: "dr40", uuid: "dr40-1" }}
        disableTalkbackInVod
        videoProps={{ videoFit: "contain", controls: [] }}
        audioProps={{ controls: ["play", "volume"], vodWindowSec: 1_800 }}
        talkbackProps={{ interactionMode: "hold", microphoneGain: 4 }}
      />
    );

    expect(last(mocks.videoProps)?.videoFit).toBe("contain");
    expect(last(mocks.videoProps)?.controls).toEqual([]);
    expect(last(mocks.audioProps)?.controls).toEqual(["play", "volume"]);
    expect(last(mocks.audioProps)?.vodWindowSec).toBe(1_800);
    expect(last(mocks.talkbackProps)?.interactionMode).toBe("hold");
    expect(last(mocks.talkbackProps)?.microphoneGain).toBe(4);
    expect(last(mocks.talkbackProps)?.disableTalkbackInVod).toBe(true);
  });

  it("exposes the controller and participant handles", () => {
    const ref = createRef<RhombusMediaPlayerHandle>();
    render(
      <RhombusMediaPlayer
        ref={ref}
        cameraUuid="camera-1"
        audioSource={{ type: "audio-gateway", uuid: "gateway-1" }}
      />
    );

    expect(ref.current?.playbackController).toBe(
      last(mocks.audioProps)?.playbackController
    );
    expect(ref.current?.getVideoPlayer()).toBe(mocks.videoHandle);
    expect(ref.current?.getAudioPlayer()).toBe(mocks.audioHandle);
    expect(ref.current?.getTalkback()).toBe(mocks.talkbackHandle);
  });
});
