import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  getRhombusPlaybackControllerInternals,
  useRhombusPlaybackController,
} from "./useRhombusPlaybackController.js";

describe("useRhombusPlaybackController", () => {
  it("broadcasts shared playhead actions through reactive state", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { result } = renderHook(() =>
      useRhombusPlaybackController({ initialPositionMs: now })
    );
    act(() => result.current.pause());
    expect(result.current.state.playing).toBe(false);
    act(() => result.current.rewind(30));
    expect(result.current.state.mode).toBe("vod");
    expect(result.current.state.positionMs).toBe(now - 30_000);
    act(() => result.current.goLive());
    expect(result.current.state.mode).toBe("live");
    expect(result.current.state.playing).toBe(true);
  });

  it("elects video progress as authoritative when video is registered", () => {
    const { result } = renderHook(() =>
      useRhombusPlaybackController({
        initialMode: "vod",
        initialPositionMs: 1_000,
      })
    );
    const internals = getRhombusPlaybackControllerInternals(result.current);
    const unregisterVideo = internals.registerParticipant({
      id: "video",
      kind: "video",
      sourceUuid: "camera",
      mode: "vod",
      videoTransport: "buffered",
    });
    const unregisterAudio = internals.registerParticipant({
      id: "audio",
      kind: "audio",
      sourceUuid: "gateway",
      audioSource: { type: "audio-gateway", uuid: "gateway" },
      mode: "vod",
      audioTransport: "dash-vod",
    });
    act(() => internals.reportProgress("audio", 2_000, "vod"));
    expect(result.current.state.positionMs).toBe(1_000);
    act(() => internals.reportProgress("video", 3_000, "vod"));
    expect(result.current.state.positionMs).toBe(3_000);
    unregisterAudio();
    unregisterVideo();
  });

  it("hands matching DR40 buffered audio to its video participant", () => {
    const { result } = renderHook(() => useRhombusPlaybackController());
    const internals = getRhombusPlaybackControllerInternals(result.current);
    const unregisterVideo = internals.registerParticipant({
      id: "video",
      kind: "video",
      sourceUuid: "dr40",
      mode: "vod",
      videoTransport: "realtime",
    });
    const unregisterAudio = internals.registerParticipant({
      id: "audio",
      kind: "audio",
      sourceUuid: "dr40",
      audioSource: { type: "dr40", uuid: "dr40" },
      mode: "vod",
      audioTransport: "opus-live",
    });
    expect(internals.hasMatchingDr40VideoOwner("dr40")).toBe(true);
    internals.updateParticipant("video", {
      mode: "live",
      videoTransport: "realtime",
    });
    expect(internals.hasMatchingDr40VideoOwner("dr40")).toBe(false);
    unregisterAudio();
    unregisterVideo();
  });

  it("aggregates buffering across required participants without clearing play intent", () => {
    const { result } = renderHook(() => useRhombusPlaybackController());
    const internals = getRhombusPlaybackControllerInternals(result.current);
    const unregisterVideo = internals.registerParticipant({
      id: "video",
      kind: "video",
      sourceUuid: "camera",
      mode: "vod",
      videoTransport: "buffered",
    });
    const unregisterAudio = internals.registerParticipant({
      id: "audio",
      kind: "audio",
      sourceUuid: "gateway",
      audioSource: { type: "audio-gateway", uuid: "gateway" },
      mode: "vod",
      audioTransport: "dash-vod",
    });
    act(() => {
      internals.reportStatus("video", "ready");
      internals.reportStatus("audio", "buffering");
    });
    expect(result.current.state.status).toBe("buffering");
    expect(result.current.state.playing).toBe(true);
    act(() => internals.reportStatus("audio", "ready"));
    expect(result.current.state.status).toBe("ready");
    unregisterAudio();
    unregisterVideo();
  });
});
