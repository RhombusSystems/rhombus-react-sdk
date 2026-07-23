import { useCallback, useRef, useState } from "react";
import type {
  RhombusAudioSource,
  RhombusAudioTransport,
  RhombusLiveTransport,
  RhombusPlaybackController,
  RhombusPlaybackControllerOptions,
  RhombusPlaybackControllerState,
  RhombusPlayerMode,
} from "./types.js";

const DEFAULT_REWIND_SEC = 15;
const DEFAULT_LIVE_EDGE_TOLERANCE_SEC = 5;

type Participant = {
  id: string;
  kind: "video" | "audio";
  sourceUuid: string;
  audioSource?: RhombusAudioSource;
  mode: RhombusPlayerMode;
  videoTransport?: RhombusLiveTransport;
  audioTransport?: RhombusAudioTransport;
};

type PlaybackControllerInternals = {
  registerParticipant: (participant: Participant) => () => void;
  updateParticipant: (id: string, update: Partial<Participant>) => void;
  reportProgress: (id: string, wallClockMs: number, mode: RhombusPlayerMode) => void;
  reportStatus: (
    id: string,
    status: RhombusPlaybackControllerState["status"]
  ) => void;
  hasMatchingDr40VideoOwner: (uuid: string) => boolean;
  subscribeParticipants: (listener: () => void) => () => void;
};

const controllerInternals = new WeakMap<RhombusPlaybackController, PlaybackControllerInternals>();

export function getRhombusPlaybackControllerInternals(
  controller: RhombusPlaybackController
): PlaybackControllerInternals {
  const value = controllerInternals.get(controller);
  if (!value) {
    throw new Error("Invalid Rhombus playback controller");
  }
  return value;
}

/**
 * Creates the shared wall-clock controller accepted by Rhombus video, audio, and Timeline.
 * The returned object has stable identity; its `state` field is refreshed on every render.
 */
export function useRhombusPlaybackController(
  options: RhombusPlaybackControllerOptions = {}
): RhombusPlaybackController {
  const configRef = useRef({
    defaultRewindSec: options.defaultRewindSec ?? DEFAULT_REWIND_SEC,
    liveEdgeToleranceSec:
      options.liveEdgeToleranceSec ?? DEFAULT_LIVE_EDGE_TOLERANCE_SEC,
    autoGoLiveAtEdge: options.autoGoLiveAtEdge ?? false,
  });
  configRef.current = {
    defaultRewindSec: options.defaultRewindSec ?? DEFAULT_REWIND_SEC,
    liveEdgeToleranceSec:
      options.liveEdgeToleranceSec ?? DEFAULT_LIVE_EDGE_TOLERANCE_SEC,
    autoGoLiveAtEdge: options.autoGoLiveAtEdge ?? false,
  };

  const initialMode = options.initialMode ?? "live";
  const [state, setState] = useState<RhombusPlaybackControllerState>(() => {
    const now = Date.now();
    const positionMs = options.initialPositionMs ?? now;
    return {
      mode: initialMode,
      positionMs,
      playing: options.initialPlaying ?? true,
      playbackRate: options.initialPlaybackRate ?? 1,
      muted: options.initialMuted ?? true,
      volume: clamp(options.initialVolume ?? 1, 0, 1),
      isAtLiveEdge:
        initialMode === "live" ||
        Math.abs(now - positionMs) <=
          (options.liveEdgeToleranceSec ?? DEFAULT_LIVE_EDGE_TOLERANCE_SEC) * 1000,
      status: "idle",
      seekSequence: 0,
    };
  });

  const play = useCallback(() => {
    setState(previous => ({ ...previous, playing: true }));
  }, []);
  const pause = useCallback(() => {
    setState(previous => ({ ...previous, playing: false }));
  }, []);
  const goLive = useCallback(() => {
    setState(previous => ({
      ...previous,
      mode: "live",
      positionMs: Date.now(),
      playing: true,
      playbackRate: 1,
      isAtLiveEdge: true,
      seekSequence: previous.seekSequence + 1,
    }));
  }, []);
  const seekTo = useCallback((wallClockMs: number) => {
    if (!Number.isFinite(wallClockMs)) return;
    const now = Date.now();
    const atLiveEdge =
      Math.abs(now - wallClockMs) <= configRef.current.liveEdgeToleranceSec * 1000;
    setState(previous => ({
      ...previous,
      mode: atLiveEdge ? "live" : "vod",
      positionMs: atLiveEdge ? now : wallClockMs,
      playing: atLiveEdge ? true : previous.playing,
      playbackRate: atLiveEdge ? 1 : previous.playbackRate,
      isAtLiveEdge: atLiveEdge,
      seekSequence: previous.seekSequence + 1,
    }));
  }, []);
  const rewind = useCallback(
    (seconds?: number) => {
      setState(previous => {
        const amount = seconds ?? configRef.current.defaultRewindSec;
        return {
          ...previous,
          mode: "vod",
          positionMs: previous.positionMs - Math.max(0, amount) * 1000,
          isAtLiveEdge: false,
          seekSequence: previous.seekSequence + 1,
        };
      });
    },
    []
  );
  const setPlaybackRate = useCallback((playbackRate: number) => {
    if (!Number.isFinite(playbackRate)) return;
    setState(previous => ({
      ...previous,
      playbackRate: clamp(playbackRate, 0.25, 4),
    }));
  }, []);
  const setMuted = useCallback((muted: boolean) => {
    setState(previous => ({ ...previous, muted }));
  }, []);
  const setVolume = useCallback((volume: number) => {
    if (!Number.isFinite(volume)) return;
    setState(previous => ({ ...previous, volume: clamp(volume, 0, 1) }));
  }, []);

  const participantsRef = useRef(new Map<string, Participant>());
  const participantStatusesRef = useRef(
    new Map<string, RhombusPlaybackControllerState["status"]>()
  );
  const listenersRef = useRef(new Set<() => void>());
  const notifyParticipants = useCallback(() => {
    for (const listener of listenersRef.current) listener();
  }, []);
  const updateAggregateStatus = useCallback(() => {
    const statuses = [...participantStatusesRef.current.values()];
    const resolved =
      statuses.find(value => value === "error") ??
      statuses.find(value => value === "reconnecting") ??
      statuses.find(value => value === "buffering") ??
      statuses.find(value => value === "connecting") ??
      statuses.find(value => value === "ready") ??
      "idle";
    setState(previous =>
      previous.status === resolved
        ? previous
        : { ...previous, status: resolved }
    );
  }, []);

  const internalsRef = useRef<PlaybackControllerInternals>();
  if (!internalsRef.current) {
    internalsRef.current = {
      registerParticipant(participant) {
        participantsRef.current.set(participant.id, participant);
        participantStatusesRef.current.set(participant.id, "idle");
        updateAggregateStatus();
        notifyParticipants();
        return () => {
          participantsRef.current.delete(participant.id);
          participantStatusesRef.current.delete(participant.id);
          updateAggregateStatus();
          notifyParticipants();
        };
      },
      updateParticipant(id, update) {
        const participant = participantsRef.current.get(id);
        if (!participant) return;
        participantsRef.current.set(id, { ...participant, ...update });
        notifyParticipants();
      },
      reportProgress(id, wallClockMs, mode) {
        const participant = participantsRef.current.get(id);
        if (!participant || !Number.isFinite(wallClockMs)) return;
        const hasVideo = [...participantsRef.current.values()].some(p => p.kind === "video");
        if (hasVideo && participant.kind !== "video") return;
        const now = Date.now();
        const isAtLiveEdge =
          mode === "live" ||
          Math.abs(now - wallClockMs) <= configRef.current.liveEdgeToleranceSec * 1000;
        setState(previous => {
          if (
            configRef.current.autoGoLiveAtEdge &&
            previous.mode === "vod" &&
            isAtLiveEdge
          ) {
            return {
              ...previous,
              mode: "live",
              positionMs: now,
              playbackRate: 1,
              isAtLiveEdge: true,
              seekSequence: previous.seekSequence + 1,
            };
          }
          return {
            ...previous,
            mode,
            positionMs: wallClockMs,
            isAtLiveEdge,
          };
        });
      },
      reportStatus(id, status) {
        participantStatusesRef.current.set(id, status);
        updateAggregateStatus();
      },
      hasMatchingDr40VideoOwner(uuid) {
        const participants = [...participantsRef.current.values()];
        const hasDr40Audio = participants.some(
          participant =>
            participant.kind === "audio" &&
            participant.audioSource?.type === "dr40" &&
            participant.sourceUuid === uuid
        );
        return hasDr40Audio && participants.some(
          participant =>
            participant.kind === "video" &&
            participant.sourceUuid === uuid &&
            (participant.mode === "vod" || participant.videoTransport === "buffered")
        );
      },
      subscribeParticipants(listener) {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
    };
  }

  const controllerRef = useRef<RhombusPlaybackController>();
  if (!controllerRef.current) {
    controllerRef.current = {
      state,
      play,
      pause,
      goLive,
      seekTo,
      rewind,
      setPlaybackRate,
      setMuted,
      setVolume,
    };
    controllerInternals.set(controllerRef.current, internalsRef.current);
  }
  controllerRef.current.state = state;
  return controllerRef.current;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
