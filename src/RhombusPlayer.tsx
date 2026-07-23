import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { RhombusBufferedPlayer } from "./RhombusBufferedPlayer.js";
import { RhombusRealtimePlayer } from "./RhombusRealtimePlayer.js";
import { RhombusPlayerControls } from "./RhombusPlayerControls.js";
import { RhombusDateTimePicker } from "./RhombusDateTimePicker.js";
import { Timeline } from "./Timeline.js";
import { snapshotCanvasElement, snapshotVideoElement } from "./playerSnapshot.js";
import {
  buildClipDownloadUrl,
  fetchClipProgress,
  requestClipSplice,
} from "./rhombusClip.js";
import { chooseVodAnchor, isAtLiveEdge, isWithinWindow, shouldSwitchToLive } from "./playerVodTime.js";
import { computeRangeCoverage, fetchPresenceWindows } from "./rhombusPresence.js";
import { joinUrl } from "./urlAuth.js";
import { getRhombusPlaybackControllerInternals } from "./useRhombusPlaybackController.js";
import type {
  RhombusBufferedPlayerHandle,
  RhombusClipExportOptions,
  RhombusClipExportStatus,
  RhombusClipRange,
  RhombusFootageAvailability,
  RhombusLiveTransport,
  RhombusPlayerHandle,
  RhombusPlayerMode,
  RhombusPlayerProps,
  RhombusPlayerState,
  RhombusRangeCoverage,
  RhombusRealtimePlayerHandle,
  RhombusSnapshotResult,
} from "./types.js";

const MAX_ZOOM = 4;
const MIN_ZOOM = 1;
const ZOOM_STEP = 0.5;
const DEFAULT_VOD_WINDOW_SEC = 7200;
const DEFAULT_REWIND_SEC = 15;
const DEFAULT_LIVE_EDGE_TOLERANCE_SEC = 5;
const DEFAULT_TIMELINE_WINDOW_SEC = 86_400;
const HOUR_MS = 60 * 60_000;
/** Timeline zoom steps (visible-window span), widest → narrowest. Index 0 is the default day view. */
const ZOOM_STEPS_MS = [24 * HOUR_MS, 8 * HOUR_MS, 3 * HOUR_MS, HOUR_MS, 20 * 60_000, 5 * 60_000];

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
const CLIP_POLL_INTERVAL_MS = 2_000;
/** Ceiling on the pre-export footage check; past it the export proceeds ungated (fail open). */
const FOOTAGE_CHECK_TIMEOUT_MS = 6_000;
const WALLCLOCK_TICK_MS = 250;
/** While a seek is settling, treat the video as "caught up" once it is within this of the target. */
const SEEK_SETTLE_THRESHOLD_MS = 1_500;
/** Safety cap: stop pinning to the seek target after this long even if the video never reports caught up. */
const SEEK_SETTLE_MAX_MS = 8_000;
/** A controlled `positionMs` within this of the current playhead is treated as "no change" (no re-seek). */
const POSITION_DRIFT_MS = 1_500;

const cx = (...xs: Array<string | undefined | false>) => xs.filter(Boolean).join(" ");

function hasWebCodecs(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { VideoDecoder?: unknown }).VideoDecoder !== "undefined"
  );
}


export const RhombusPlayer = forwardRef<RhombusPlayerHandle, RhombusPlayerProps>(
  function RhombusPlayer(props, ref) {
    const {
      cameraUuid,
      connectionMode = "wan",
      playbackController,
      liveTransport: liveTransportProp,
      videoFit: videoFitProp = "auto",
      playing: playingPropInput,
      playbackRate: playbackRatePropInput,
      zoom: zoomProp,
      positionMs: positionMsPropInput,
      showLiveTypeSwitcher = false,
      realtimeStreamQuality: realtimeQualityProp = "HD",
      bufferedStreamQuality: bufferedQualityProp = "HIGH",
      applyBufferedStreamQuality,
      initialMode = "live",
      initialStartTimeMs,
      vodWindowSec = DEFAULT_VOD_WINDOW_SEC,
      defaultRewindSec = DEFAULT_REWIND_SEC,
      liveEdgeToleranceSec = DEFAULT_LIVE_EDGE_TOLERANCE_SEC,
      autoGoLiveAtEdge = false,
      controls,
      classNames,
      renderControls,
      saveClip,
      timeline,
      className,
      style,
    } = props;
    const playingProp = playbackController
      ? playbackController.state.playing &&
        playbackController.state.status !== "buffering"
      : playingPropInput;
    const playbackRateProp =
      playbackController?.state.playbackRate ?? playbackRatePropInput;
    const positionMsProp =
      playbackController?.state.positionMs ?? positionMsPropInput;
    const participantId = useId();
    const playbackInternals = playbackController
      ? getRhombusPlaybackControllerInternals(playbackController)
      : null;
    const [, setParticipantRevision] = useState(0);

    // ---- resolved live transport (realtime requires WebCodecs) ----
    const requestedTransport: RhombusLiveTransport = liveTransportProp ?? "realtime";
    const initialTransport: RhombusLiveTransport =
      requestedTransport === "realtime" && !hasWebCodecs() ? "buffered" : requestedTransport;
    const [liveTransportState, setLiveTransportState] = useState<RhombusLiveTransport>(initialTransport);

    // ---- core state ----
    const initialVod = useMemo(() => {
      if (initialMode === "vod" && initialStartTimeMs != null) {
        return chooseVodAnchor({
          targetMs: initialStartTimeMs,
          windowSec: vodWindowSec,
          nowMs: Date.now(),
        });
      }
      return null;
    }, [initialMode, initialStartTimeMs, vodWindowSec]);

    const [mode, setMode] = useState<RhombusPlayerMode>(initialMode);
    const [vodAnchorMs, setVodAnchorMs] = useState<number | null>(initialVod?.anchorMs ?? null);
    const [vodSeekOffsetSec, setVodSeekOffsetSec] = useState<number>(initialVod?.seekOffsetSec ?? 0);
    const [playing, setPlaying] = useState(true);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [zoom, setZoomState] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [currentWallClockMs, setCurrentWallClockMs] = useState<number | null>(null);
    const [realtimeQuality, setRealtimeQuality] = useState(realtimeQualityProp);
    const [bufferedQuality, setBufferedQuality] = useState(bufferedQualityProp);
    // Clip selection range (epoch ms), or null when not in clip mode.
    const [clipSelection, setClipSelection] = useState<{ startMs: number; endMs: number } | null>(null);
    const [clipExport, setClipExport] = useState<RhombusClipExportStatus | undefined>(undefined);
    // Latest footage availability from the Timeline's fetch; null when unknown (timeline
    // hidden, fetch disabled, or nothing fetched yet).
    const [footageAvailability, setFootageAvailability] = useState<RhombusFootageAvailability | null>(null);
    // Timeline window is modeled as center + span (zoom step). `timelineCenterMs === null` ⇒
    // auto-follow (day-center when zoomed out, the playhead when zoomed in). Chevrons pan the
    // center; the zoom buttons / wheel change the zoom step. Both reset on Go Live.
    const [timelineCenterMs, setTimelineCenterMs] = useState<number | null>(null);
    const [timelineZoomIndex, setTimelineZoomIndex] = useState(0);
    // Intrinsic video aspect ratio, measured for `videoFit="auto"` (defaults to 16:9 until known).
    const [intrinsicAspect, setIntrinsicAspect] = useState({ w: 16, h: 9 });
    // videoFit is "controllable": the prop seeds it and re-syncs when changed; the built-in
    // "videoFit" control mutates it internally and fires `onVideoFitChange`.
    const [videoFit, setVideoFit] = useState(videoFitProp);
    useEffect(() => {
      setVideoFit(videoFitProp);
    }, [videoFitProp]);

    // ---- child handles ----
    const realtimeHandleRef = useRef<RhombusRealtimePlayerHandle>(null);
    const bufferedHandleRef = useRef<RhombusBufferedPlayerHandle>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const readyFiredRef = useRef(false);
    // Whether the user wants playback. Reconciled onto the <video> when a transport becomes ready
    // (VOD dash inits paused, so a live→VOD seek must explicitly resume to match this intent).
    const desiredPlayingRef = useRef(true);
    const panDragRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });
    // Intended wall-clock of an in-flight seek; the playhead pins here until the video catches up.
    const seekTargetRef = useRef<number | null>(null);
    const lastSeekAtRef = useRef(0);
    // Last wall-clock shown by the playhead; VOD tracking is monotonic (forward-only) between
    // seeks, so transient/stale `video.currentTime` reads can never make the playhead jump back.
    const lastShownWallClockRef = useRef<number | null>(null);

    // ---- refs mirroring state for stable callbacks ----
    const modeRef = useRef(mode);
    modeRef.current = mode;
    const liveTransportRef = useRef(liveTransportState);
    liveTransportRef.current = liveTransportState;
    const vodAnchorRef = useRef(vodAnchorMs);
    vodAnchorRef.current = vodAnchorMs;
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const panRef = useRef(pan);
    panRef.current = pan;
    const playingRef = useRef(playing);
    playingRef.current = playing;
    const playbackRateRef = useRef(playbackRate);
    playbackRateRef.current = playbackRate;
    const clipSelectionRef = useRef(clipSelection);
    clipSelectionRef.current = clipSelection;

    const cfg = { vodWindowSec, defaultRewindSec, liveEdgeToleranceSec, autoGoLiveAtEdge };
    const cfgRef = useRef(cfg);
    cfgRef.current = cfg;

    const cbRef = useRef(props);
    cbRef.current = props;

    const prevModeRef = useRef(mode);

    useEffect(() => {
      if (!playbackController) return;
      const conflicts = [
        playingPropInput !== undefined ? "playing" : "",
        playbackRatePropInput !== undefined ? "playbackRate" : "",
        positionMsPropInput !== undefined ? "positionMs" : "",
      ].filter(Boolean);
      if (conflicts.length > 0) {
        console.warn(
          `[RhombusPlayer] playbackController overrides: ${conflicts.join(", ")}`
        );
      }
    }, [
      playbackController,
      playbackRatePropInput,
      playingPropInput,
      positionMsPropInput,
    ]);

    useEffect(() => {
      if (!playbackInternals) return;
      return playbackInternals.subscribeParticipants(() =>
        setParticipantRevision(value => value + 1)
      );
    }, [playbackInternals]);

    useEffect(() => {
      if (!playbackInternals) return;
      return playbackInternals.registerParticipant({
        id: participantId,
        kind: "video",
        sourceUuid: cameraUuid,
        mode,
        videoTransport: liveTransportState,
      });
    }, [cameraUuid, participantId, playbackInternals]);

    useEffect(() => {
      playbackInternals?.updateParticipant(participantId, {
        sourceUuid: cameraUuid,
        mode,
        videoTransport: liveTransportState,
      });
    }, [
      cameraUuid,
      liveTransportState,
      mode,
      participantId,
      playbackInternals,
    ]);

    // ---- element accessors ----
    const getVideo = useCallback(() => bufferedHandleRef.current?.getVideoElement() ?? null, []);
    const getCanvas = useCallback(() => realtimeHandleRef.current?.getCanvasElement() ?? null, []);

    const computeWallClock = useCallback((): number | null => {
      if (modeRef.current === "live") return Date.now();
      const v = getVideo();
      const anchor = vodAnchorRef.current;
      if (v && anchor != null) return anchor + v.currentTime * 1000;
      return anchor;
    }, [getVideo]);

    // ---- transport ----
    const setLiveTransport = useCallback((t: RhombusLiveTransport) => {
      const resolved = t === "realtime" && !hasWebCodecs() ? "buffered" : t;
      setLiveTransportState(prev => {
        if (prev !== resolved) cbRef.current.onTransportChange?.(resolved);
        return resolved;
      });
    }, []);

    // notify on initial fallback
    useEffect(() => {
      if (initialTransport !== requestedTransport) {
        cbRef.current.onTransportChange?.(initialTransport);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- mode transitions ----
    const enterVod = useCallback((targetMs: number) => {
      const { anchorMs, seekOffsetSec } = chooseVodAnchor({
        targetMs,
        windowSec: cfgRef.current.vodWindowSec,
        nowMs: Date.now(),
      });
      seekTargetRef.current = targetMs;
      lastSeekAtRef.current = Date.now();
      lastShownWallClockRef.current = targetMs;
      setVodAnchorMs(anchorMs);
      setVodSeekOffsetSec(seekOffsetSec);
      setCurrentWallClockMs(targetMs);
      setMode("vod");
    }, []);

    const goLive = useCallback(() => {
      if (playbackController && playbackController.state.mode !== "live") {
        playbackController.goLive();
        return;
      }
      desiredPlayingRef.current = true;
      seekTargetRef.current = null;
      lastShownWallClockRef.current = null;
      setTimelineCenterMs(null); // resume auto-following
      setTimelineZoomIndex(0); // back to the day view
      setVodAnchorMs(null);
      setVodSeekOffsetSec(0);
      setPlaybackRate(1);
      setCurrentWallClockMs(null);
      setPlaying(true);
      setMode("live");
    }, [playbackController]);

    const seekTo = useCallback(
      (targetMs: number) => {
        if (
          playbackController &&
          Math.abs(playbackController.state.positionMs - targetMs) > POSITION_DRIFT_MS
        ) {
          playbackController.seekTo(targetMs);
          return;
        }
        const now = Date.now();
        // A seek preserves the user's play/pause intent: playing keeps playing at the new time,
        // paused stays paused there (reconciled when the possibly-fresh transport becomes ready).
        // `desiredPlayingRef` already holds that intent, so it is deliberately left untouched.
        if (shouldSwitchToLive(targetMs, now, cfgRef.current.liveEdgeToleranceSec)) {
          goLive();
          return;
        }
        // Bring the timeline view along when the target lands outside the visible window
        // (date-picker jumps, ref seeks): resume auto-follow, which re-centers on the target's
        // day (day view) or the playhead (zoomed). Timeline-click seeks are always inside the
        // window (the pointer math clamps to it), so scrubbing never moves the window.
        if (Math.abs(targetMs - tlCenterRef.current) > tlSpanRef.current / 2) {
          setTimelineCenterMs(null);
        }
        const anchor = vodAnchorRef.current;
        if (
          modeRef.current === "vod" &&
          anchor != null &&
          isWithinWindow(targetMs, anchor, cfgRef.current.vodWindowSec)
        ) {
          const v = getVideo();
          if (v) {
            seekTargetRef.current = targetMs;
            lastSeekAtRef.current = Date.now();
            lastShownWallClockRef.current = targetMs;
            v.currentTime = Math.max(0, (targetMs - anchor) / 1000);
            setCurrentWallClockMs(targetMs);
            cbRef.current.onSeek?.(targetMs, "vod");
            return;
          }
        }
        enterVod(targetMs);
        cbRef.current.onSeek?.(targetMs, "vod");
      },
      [enterVod, goLive, getVideo, playbackController]
    );

    const play = useCallback(() => {
      if (playbackController && !playbackController.state.playing) {
        playbackController.play();
        return;
      }
      desiredPlayingRef.current = true;
      if (modeRef.current === "vod" || liveTransportRef.current === "buffered") {
        getVideo()?.play().catch(() => {});
        setPlaying(true);
      } else {
        // realtime live is always playing; if we had paused into VOD, return to live
        if (modeRef.current !== "live") goLive();
        setPlaying(true);
      }
    }, [getVideo, goLive, playbackController]);

    const pause = useCallback(() => {
      if (
        playbackController &&
        playbackController.state.playing &&
        playbackController.state.status !== "buffering"
      ) {
        playbackController.pause();
        return;
      }
      desiredPlayingRef.current = false;
      if (modeRef.current === "vod" || liveTransportRef.current === "buffered") {
        getVideo()?.pause();
        setPlaying(false);
        return;
      }
      // realtime live: freeze by dropping into VOD at ~now, paused once the <video> is ready
      setPlaying(false);
      enterVod(Date.now());
    }, [enterVod, getVideo, playbackController]);

    const rewind = useCallback(
      (seconds?: number) => {
        const sec = seconds ?? cfgRef.current.defaultRewindSec;
        const cur = computeWallClock() ?? Date.now();
        seekTo(cur - sec * 1000);
      },
      [computeWallClock, seekTo]
    );

    const setPlaybackRateImpl = useCallback(
      (rate: number) => {
        if (
          playbackController &&
          playbackController.state.playbackRate !== rate
        ) {
          playbackController.setPlaybackRate(rate);
          return;
        }
        if (modeRef.current !== "vod") return; // ignored while live
        const v = getVideo();
        if (v) v.playbackRate = rate;
        setPlaybackRate(rate);
      },
      [getVideo, playbackController]
    );

    // ---- zoom / pan ----
    const clampPan = useCallback((next: { x: number; y: number }, z: number) => {
      const stage = stageRef.current;
      if (!stage || z <= 1) return { x: 0, y: 0 };
      const maxX = (stage.clientWidth * (z - 1)) / 2;
      const maxY = (stage.clientHeight * (z - 1)) / 2;
      return {
        x: Math.max(-maxX, Math.min(maxX, next.x)),
        y: Math.max(-maxY, Math.min(maxY, next.y)),
      };
    }, []);

    const applyZoom = useCallback(
      (z: number, panX?: number, panY?: number) => {
        const clampedZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
        setZoomState(clampedZ);
        const nextPan = clampPan({ x: panX ?? panRef.current.x, y: panY ?? panRef.current.y }, clampedZ);
        setPan(nextPan);
        cbRef.current.onZoomChange?.(clampedZ, nextPan.x, nextPan.y);
      },
      [clampPan]
    );

    const zoomIn = useCallback((step?: number) => applyZoom(zoomRef.current + (step ?? ZOOM_STEP)), [applyZoom]);
    const zoomOut = useCallback((step?: number) => applyZoom(zoomRef.current - (step ?? ZOOM_STEP)), [applyZoom]);
    const setZoom = useCallback((z: number, px?: number, py?: number) => applyZoom(z, px, py), [applyZoom]);
    const resetZoom = useCallback(() => applyZoom(1, 0, 0), [applyZoom]);

    // ---- snapshot ----
    const snapshot = useCallback(async (): Promise<RhombusSnapshotResult> => {
      const wallClockMs = computeWallClock() ?? Date.now();
      if (modeRef.current === "live" && liveTransportRef.current === "realtime") {
        const canvas = getCanvas();
        if (!canvas) throw new Error("No realtime canvas available to snapshot");
        const result = await snapshotCanvasElement(canvas, { wallClockMs, mode: modeRef.current });
        cbRef.current.onSnapshot?.(result);
        return result;
      }
      const video = getVideo();
      if (!video) throw new Error("No video available to snapshot");
      const result = await snapshotVideoElement(video, { wallClockMs, mode: modeRef.current });
      cbRef.current.onSnapshot?.(result);
      return result;
    }, [computeWallClock, getCanvas, getVideo]);

    // ---- save clip ----
    const overrideBase = props.apiOverrideBaseUrl?.trim() || undefined;
    const clipEnabled = (saveClip?.enabled ?? overrideBase !== undefined) && overrideBase !== undefined;
    const clipExportCancelRef = useRef(false);

    // ---- footage availability (timeline fetch + clip coverage) ----
    // Default ON only in proxy mode (the proxy attaches the API key, mirroring `clipEnabled`);
    // direct-mode federated auth for getPresenceWindows is unverified, so it is opt-in there.
    const fetchAvailabilityEnabled = timeline?.fetchAvailability ?? overrideBase !== undefined;
    const handleAvailabilityLoaded = useCallback((availability: RhombusFootageAvailability) => {
      setFootageAvailability(availability);
      cbRef.current.timeline?.onAvailabilityLoaded?.(availability);
    }, []);
    // Coverage of the current selection; null when unknown (no data, or the selection extends
    // outside the fetched range — e.g. after panning the timeline away). Unknown never warns.
    const clipSelectionCoverage = useMemo(() => {
      if (!clipSelection) return null;
      const lo = Math.min(clipSelection.startMs, clipSelection.endMs);
      const hi = Math.max(clipSelection.startMs, clipSelection.endMs);
      return computeRangeCoverage(footageAvailability, lo, hi);
    }, [clipSelection, footageAvailability]);

    const startClipExport = useCallback(
      async (
        range?: RhombusClipRange,
        options?: RhombusClipExportOptions
      ): Promise<RhombusClipExportStatus> => {
        const sel = clipSelectionRef.current;
        const r =
          range ??
          (sel
            ? { startMs: Math.min(sel.startMs, sel.endMs), endMs: Math.max(sel.startMs, sel.endMs), cameraUuid }
            : null);
        const fail = (
          error: string,
          extra?: Pick<RhombusClipExportStatus, "errorCode" | "coverage">
        ): RhombusClipExportStatus => {
          const s: RhombusClipExportStatus = { phase: "error", error, ...extra };
          setClipExport(s);
          cbRef.current.onClipExport?.(s);
          return s;
        };
        if (!r) return fail("No clip range selected");
        if (!overrideBase || !clipEnabled) {
          return fail("Built-in clip export requires apiOverrideBaseUrl (proxy mode)");
        }
        const durationSec = Math.max(1, Math.round((r.endMs - r.startMs) / 1000));
        const maxDur = saveClip?.maxDurationSec ?? 3600;
        if (durationSec > maxDur) return fail(`Clip exceeds max duration of ${maxDur}s`);

        // Pre-export footage check: Rhombus renders no-footage ranges as "VIDEO NOT AVAILABLE"
        // placeholder frames and the clip still completes, so confirmed-empty ranges are blocked
        // up front. Fails open — an unreachable availability endpoint never blocks an export.
        const requireFootage = saveClip?.requireFootage ?? "any";
        let coverage: RhombusRangeCoverage | undefined;
        const checkEndMs = Math.min(r.endMs, Date.now());
        if (requireFootage !== "off" && checkEndMs > r.startMs) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FOOTAGE_CHECK_TIMEOUT_MS);
            try {
              const startSec = Math.floor(r.startMs / 1000);
              const availability = await fetchPresenceWindows({
                apiOverrideBaseUrl: overrideBase,
                rhombusApiBaseUrl: props.rhombusApiBaseUrl,
                presenceWindowsPath: props.paths?.presenceWindows,
                federatedSessionToken: props.federatedSessionToken,
                headers: props.headers,
                getRequestHeaders: props.getRequestHeaders,
                cameraUuid,
                startTimeSec: startSec,
                durationSec: Math.ceil(checkEndMs / 1000) - startSec,
                signal: controller.signal,
              });
              coverage = computeRangeCoverage(availability, r.startMs, checkEndMs) ?? undefined;
            } finally {
              clearTimeout(timer);
            }
          } catch (e) {
            cbRef.current.onError?.(e instanceof Error ? e : new Error(String(e)));
          }
          if (coverage) {
            if (coverage.coveredMs <= 0) {
              return fail("No recorded footage in the selected range", {
                errorCode: "no-footage",
                coverage,
              });
            }
            if (requireFootage === "full" && coverage.coverageRatio < 1) {
              return fail("The selected range has gaps with no recorded footage", {
                errorCode: "partial-footage",
                coverage,
              });
            }
          }
        }

        clipExportCancelRef.current = false;
        const auth = { headers: props.headers, getRequestHeaders: props.getRequestHeaders };
        const spliceUrl = joinUrl(overrideBase, saveClip?.paths?.splice ?? "/api/save-clip");
        const progressUrl = joinUrl(overrideBase, saveClip?.paths?.progress ?? "/api/clip-progress");
        const downloadUrl = joinUrl(overrideBase, saveClip?.paths?.download ?? "/api/clip-download");

        const emit = (s: RhombusClipExportStatus) => {
          setClipExport(s);
          cbRef.current.onClipExport?.(s);
        };

        emit({ phase: "submitting", coverage });
        try {
          const { clipUuid } = await requestClipSplice({
            ...auth,
            url: spliceUrl,
            cameraUuid,
            startTimeMillis: r.startMs,
            durationSec,
            title:
              options?.title?.trim() ||
              saveClip?.defaultTitle ||
              `Clip ${new Date(r.startMs).toLocaleString()}`,
            description: options?.description,
            clipVisibility: options?.visibility ?? saveClip?.defaultVisibility ?? "ORG_WIDE",
            audioIncluded: options?.audioIncluded,
            saveToConsole: options?.saveToConsole,
          });
          emit({ phase: "rendering", clipUuid, percentComplete: 0, coverage });

          // poll until complete, or give up after progressTimeoutMs so the UI never hangs.
          const renderStartedAt = Date.now();
          const timeoutMs = saveClip?.progressTimeoutMs ?? 300_000;
          let lastStatus = "INITIATING";
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (clipExportCancelRef.current) {
              const s: RhombusClipExportStatus = { phase: "canceled", clipUuid, coverage };
              emit(s);
              return s;
            }
            if (timeoutMs > 0 && Date.now() - renderStartedAt > timeoutMs) {
              return fail(
                `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the clip to render ` +
                  `(last status: ${lastStatus}). The render may be stuck server-side.`
              );
            }
            const progress = await fetchClipProgress({ ...auth, url: progressUrl, clipUuid });
            lastStatus = progress.status ?? lastStatus;
            if (progress.failed) return fail(progress.currentOperation ?? "Clip render failed");
            if (progress.complete) {
              const url = buildClipDownloadUrl({ url: downloadUrl, clipUuid, region: progress.region });
              const s: RhombusClipExportStatus = {
                phase: "complete",
                clipUuid,
                percentComplete: 100,
                downloadUrl: url,
                coverage,
              };
              emit(s);
              return s;
            }
            emit({
              phase: "rendering",
              clipUuid,
              percentComplete: progress.percentComplete,
              currentOperation: progress.currentOperation,
              coverage,
            });
            await new Promise(res => setTimeout(res, CLIP_POLL_INTERVAL_MS));
          }
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
      [
        cameraUuid,
        clipEnabled,
        overrideBase,
        props.headers,
        props.getRequestHeaders,
        props.rhombusApiBaseUrl,
        props.paths,
        props.federatedSessionToken,
        saveClip,
      ]
    );

    useEffect(() => () => {
      clipExportCancelRef.current = true;
    }, []);

    // ---- clip selection (enter/exit clip mode, seeded at the playhead) ----
    const clipDefaultDurMs = (saveClip?.defaultDurationSec ?? 60) * 1000;
    const clipMinMs = (saveClip?.minDurationSec ?? 5) * 1000;
    const clipMaxMs = (saveClip?.maxDurationSec ?? 3600) * 1000;

    const toggleClipSelection = useCallback(() => {
      if (clipSelectionRef.current) {
        setClipSelection(null); // exit clip mode
        setClipExport(undefined);
        return;
      }
      const now = Date.now();
      const ref = modeRef.current === "live" ? now : computeWallClock() ?? now;
      const hi = now - 10_000; // never select into the (near) future
      let end = Math.min(ref + clipDefaultDurMs / 2, hi);
      let start = end - clipDefaultDurMs;
      if (start < 0) start = 0;
      if (end <= start) end = start + clipDefaultDurMs;
      const next = { startMs: start, endMs: end };
      // Zoom/center the timeline so the (small) selection is comfortably draggable.
      const targetSpan = clipDefaultDurMs * 4;
      let idx = 0;
      for (let i = ZOOM_STEPS_MS.length - 1; i >= 0; i--) {
        if (ZOOM_STEPS_MS[i] >= targetSpan) {
          idx = i;
          break;
        }
      }
      setTimelineZoomIndex(idx);
      setTimelineCenterMs((start + end) / 2);
      setClipSelection(next);
      setClipExport(undefined);
      cbRef.current.onClipRangeSelect?.({ ...next, cameraUuid });
    }, [cameraUuid, clipDefaultDurMs, computeWallClock]);

    const handleSelectionChange = useCallback(
      (next: { startMs: number; endMs: number }) => {
        setClipSelection(next);
        cbRef.current.onClipRangeSelect?.({
          startMs: Math.min(next.startMs, next.endMs),
          endMs: Math.max(next.startMs, next.endMs),
          cameraUuid,
        });
      },
      [cameraUuid]
    );

    // ---- child ready ----
    const handleChildReady = useCallback(() => {
      playbackInternals?.reportStatus(participantId, "ready");
      if (!readyFiredRef.current) {
        readyFiredRef.current = true;
        cbRef.current.onReady?.();
      }
      // Reconcile the (possibly freshly-mounted) <video> with the desired play state. VOD dash
      // initializes paused, so a live→VOD seek must resume here; a pause-into-VOD freezes here.
      const v = getVideo();
      if (v) {
        if (desiredPlayingRef.current) {
          v.play().catch(() => {});
          setPlaying(true);
        } else {
          v.pause();
          setPlaying(false);
        }
      }
    }, [getVideo, participantId, playbackInternals]);

    // ---- keep `playing` and `playbackRate` in sync with the <video> element ----
    useEffect(() => {
      const v = getVideo();
      if (!v) return;
      const onPlay = () => setPlaying(true);
      const onPause = () => setPlaying(false);
      const onRate = () => setPlaybackRate(v.playbackRate);
      const onWaiting = () =>
        playbackInternals?.reportStatus(participantId, "buffering");
      const onReadyToPlay = () =>
        playbackInternals?.reportStatus(participantId, "ready");
      v.addEventListener("play", onPlay);
      v.addEventListener("pause", onPause);
      v.addEventListener("ratechange", onRate);
      v.addEventListener("waiting", onWaiting);
      v.addEventListener("canplay", onReadyToPlay);
      v.addEventListener("canplaythrough", onReadyToPlay);
      v.addEventListener("playing", onReadyToPlay);
      if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        playbackInternals?.reportStatus(participantId, "ready");
      }
      return () => {
        v.removeEventListener("play", onPlay);
        v.removeEventListener("pause", onPause);
        v.removeEventListener("ratechange", onRate);
        v.removeEventListener("waiting", onWaiting);
        v.removeEventListener("canplay", onReadyToPlay);
        v.removeEventListener("canplaythrough", onReadyToPlay);
        v.removeEventListener("playing", onReadyToPlay);
      };
    }, [
      getVideo,
      mode,
      liveTransportState,
      participantId,
      playbackInternals,
      vodAnchorMs,
    ]);

    // ---- wall-clock ticker (VOD) ----
    useEffect(() => {
      if (mode !== "vod") return;
      const id = setInterval(() => {
        const target = seekTargetRef.current;
        if (target != null) {
          // A seek is settling: keep the playhead pinned at the intended time and ignore the
          // still-stale `video.currentTime` until the video reports it has caught up (or we hit
          // the safety cap). This prevents the "playhead jumps behind the click, then snaps" jank.
          const v = getVideo();
          const anchor = vodAnchorRef.current;
          const actual = v && anchor != null ? anchor + v.currentTime * 1000 : null;
          const caughtUp =
            v != null &&
            !v.seeking &&
            actual != null &&
            Math.abs(actual - target) <= SEEK_SETTLE_THRESHOLD_MS;
          const timedOut = Date.now() - lastSeekAtRef.current > SEEK_SETTLE_MAX_MS;
          if (!caughtUp && !timedOut) {
            setCurrentWallClockMs(target);
            return;
          }
          seekTargetRef.current = null;
        }
        const wc = computeWallClock();
        if (wc != null) {
          // Monotonic: only advance the playhead. A stale/backward `currentTime` read between
          // seeks is ignored, so the playhead never jumps backward during playback.
          const last = lastShownWallClockRef.current;
          if (last == null || wc >= last) {
            lastShownWallClockRef.current = wc;
            setCurrentWallClockMs(wc);
          }
          cbRef.current.onProgress?.(wc, "vod");
          playbackInternals?.reportProgress(participantId, wc, "vod");
          if (cfgRef.current.autoGoLiveAtEdge) {
            if (isAtLiveEdge(wc, Date.now(), cfgRef.current.liveEdgeToleranceSec)) goLive();
          }
        }
      }, WALLCLOCK_TICK_MS);
      return () => clearInterval(id);
    }, [mode, computeWallClock, goLive, getVideo, participantId, playbackInternals]);

    // ---- progress while live (~1Hz; the VOD ticker handles vod) ----
    useEffect(() => {
      if (mode !== "live") return;
      const id = setInterval(() => {
        const now = Date.now();
        cbRef.current.onProgress?.(now, "live");
        playbackInternals?.reportProgress(participantId, now, "live");
      }, 1_000);
      return () => clearInterval(id);
    }, [mode, participantId, playbackInternals]);

    // ---- onPlaybackRateChange (fires for the built-in control, ref, and native ratechange) ----
    useEffect(() => {
      cbRef.current.onPlaybackRateChange?.(playbackRate);
    }, [playbackRate]);

    // ---- controlled props: reconcile internal state to the prop when it is provided + changes ----
    // (Mirrors the `videoFit` controllable pattern. Each guards against its current effective value
    //  via a ref so there is no feedback loop with the matching `on*Change` callback.)
    useEffect(() => {
      if (playingProp === undefined || playingProp === playingRef.current) return;
      if (playingProp) play();
      else pause();
    }, [playingProp, play, pause]);

    useEffect(() => {
      if (playbackRateProp === undefined || playbackRateProp === playbackRateRef.current) return;
      setPlaybackRateImpl(playbackRateProp);
    }, [playbackRateProp, setPlaybackRateImpl]);

    useEffect(() => {
      if (zoomProp === undefined || zoomProp === zoomRef.current) return;
      applyZoom(zoomProp);
    }, [zoomProp, applyZoom]);

    useEffect(() => {
      if (liveTransportProp === undefined || liveTransportProp === liveTransportRef.current) return;
      setLiveTransport(liveTransportProp);
    }, [liveTransportProp, setLiveTransport]);

    // Controlled playhead: seek when `positionMs` *changes* beyond normal playback drift, so
    // echoed/progress values don't cause a re-seek loop. Live/VOD is derived by `seekTo`.
    useEffect(() => {
      if (positionMsProp === undefined) return;
      const current = computeWallClock();
      if (current != null && Math.abs(positionMsProp - current) <= POSITION_DRIFT_MS) return;
      seekTo(positionMsProp);
    }, [positionMsProp, computeWallClock, seekTo]);

    // ---- measure intrinsic video aspect ratio (only needed for videoFit="auto") ----
    useEffect(() => {
      if (videoFit !== "auto") return;
      const read = () => {
        const v = getVideo();
        if (v && v.videoWidth && v.videoHeight) {
          setIntrinsicAspect(prev =>
            prev.w === v.videoWidth && prev.h === v.videoHeight ? prev : { w: v.videoWidth, h: v.videoHeight }
          );
          return;
        }
        const c = getCanvas();
        if (c && c.width && c.height) {
          setIntrinsicAspect(prev =>
            prev.w === c.width && prev.h === c.height ? prev : { w: c.width, h: c.height }
          );
        }
      };
      read();
      const id = setInterval(read, 500);
      return () => clearInterval(id);
    }, [videoFit, getVideo, getCanvas, mode, liveTransportState]);

    // ---- onModeChange ----
    useEffect(() => {
      if (prevModeRef.current !== mode) {
        prevModeRef.current = mode;
        cbRef.current.onModeChange?.(mode, computeWallClock() ?? Date.now());
      }
    }, [mode, computeWallClock]);

    // ---- onPlayingChange ----
    useEffect(() => {
      cbRef.current.onPlayingChange?.(playing);
    }, [playing]);

    // ---- timeline display window (center + span/zoom, Console-style) ----
    // Zoom step 0 = a full day aligned to local midnight (the default). Zooming in narrows the
    // window around a focus (cursor/playhead). When the center is `null` the window auto-follows
    // (day-center when zoomed out, the playhead when zoomed in). Chevrons pan by ±half-span; the
    // zoom buttons / wheel change the step. Go Live resets to the day view.
    const dayMs = (timeline?.windowSec ?? DEFAULT_TIMELINE_WINDOW_SEC) * 1000;
    // Step 0 uses the configured window (default a full day); deeper steps use the fixed ladder.
    const tlSpanMs = timelineZoomIndex === 0 ? dayMs : ZOOM_STEPS_MS[timelineZoomIndex];
    const tlRefMs = mode === "live" ? Date.now() : currentWallClockMs ?? Date.now();
    const tlAutoCenterMs =
      timelineZoomIndex === 0 ? startOfLocalDay(tlRefMs) + dayMs / 2 : tlRefMs;
    // User-set center is clamped so the window never sits entirely in the future.
    const tlCenterMs =
      timelineCenterMs == null ? tlAutoCenterMs : Math.min(timelineCenterMs, Date.now());
    const tlRangeStartMs = tlCenterMs - tlSpanMs / 2;
    const tlRangeEndMs = tlCenterMs + tlSpanMs / 2;
    const tlCanShiftForward = tlRangeEndMs < Date.now() - 1;
    const tlCanZoomIn = timelineZoomIndex < ZOOM_STEPS_MS.length - 1;
    const tlCanZoomOut = timelineZoomIndex > 0;

    const tlSpanRef = useRef(tlSpanMs);
    tlSpanRef.current = tlSpanMs;
    const tlCenterRef = useRef(tlCenterMs);
    tlCenterRef.current = tlCenterMs;
    const tlZoomIndexRef = useRef(timelineZoomIndex);
    tlZoomIndexRef.current = timelineZoomIndex;

    const shiftTimelineWindow = useCallback((dir: -1 | 1) => {
      // Pan the window by half its width (±12h at the day view, smaller when zoomed in).
      setTimelineCenterMs(tlCenterRef.current + dir * (tlSpanRef.current / 2));
    }, []);

    const zoomTimeline = useCallback((zoomIn: boolean, centerMs: number) => {
      const next = clampNum(tlZoomIndexRef.current + (zoomIn ? 1 : -1), 0, ZOOM_STEPS_MS.length - 1);
      if (next === tlZoomIndexRef.current) return;
      setTimelineZoomIndex(next);
      // Zooming all the way out returns to the auto day view; otherwise focus on the given time.
      setTimelineCenterMs(next === 0 ? null : centerMs);
    }, []);

    // ---- observable state snapshot ----
    const buildState = useCallback((): RhombusPlayerState => {
      const wc = mode === "live" ? Date.now() : currentWallClockMs;
      return {
        cameraUuid,
        mode,
        liveTransport: liveTransportState,
        playing,
        playbackRate,
        currentWallClockMs: wc,
        zoom,
        isAtLiveEdge: isAtLiveEdge(mode === "live" ? null : wc, Date.now(), liveEdgeToleranceSec),
        canSaveClip: clipEnabled,
        clipSelection,
        clipSelectionCoverage,
        clipExport,
      };
    }, [
      cameraUuid,
      mode,
      liveTransportState,
      playing,
      playbackRate,
      currentWallClockMs,
      zoom,
      clipEnabled,
      clipSelection,
      clipSelectionCoverage,
      clipExport,
      liveEdgeToleranceSec,
    ]);
    const buildStateRef = useRef(buildState);
    buildStateRef.current = buildState;

    // ---- imperative handle (stable; getState reads the latest snapshot via ref) ----
    const handle = useMemo<RhombusPlayerHandle>(
      () => ({
        play,
        pause,
        goLive,
        seekTo,
        rewind,
        setPlaybackRate: setPlaybackRateImpl,
        zoomIn,
        zoomOut,
        setZoom,
        resetZoom,
        snapshot,
        setLiveTransport,
        startClipExport,
        getState: () => buildStateRef.current(),
      }),
      [
        play,
        pause,
        goLive,
        seekTo,
        rewind,
        setPlaybackRateImpl,
        zoomIn,
        zoomOut,
        setZoom,
        resetZoom,
        snapshot,
        setLiveTransport,
        startClipExport,
      ]
    );
    useImperativeHandle(ref, () => handle, [handle]);

    const state = buildState();

    // ---- render the active child ----
    const showRealtime = mode === "live" && liveTransportState === "realtime";
    const videoOwnsDr40Audio =
      playbackInternals?.hasMatchingDr40VideoOwner(cameraUuid) ?? false;
    useEffect(() => {
      const video = getVideo();
      if (!video) return;
      video.muted = videoOwnsDr40Audio
        ? playbackController?.state.muted ?? true
        : true;
      video.volume = videoOwnsDr40Audio
        ? playbackController?.state.volume ?? 1
        : 0;
    }, [
      getVideo,
      mode,
      playbackController?.state.muted,
      playbackController?.state.volume,
      videoOwnsDr40Audio,
    ]);
    const bufferedStartTimeSec =
      mode === "vod" && vodAnchorMs != null ? Math.floor(vodAnchorMs / 1000) : undefined;

    const baseChildProps = {
      cameraUuid,
      apiOverrideBaseUrl: props.apiOverrideBaseUrl,
      rhombusApiBaseUrl: props.rhombusApiBaseUrl,
      paths: props.paths,
      federatedSessionToken: props.federatedSessionToken,
      tokenDurationSec: props.tokenDurationSec,
      headers: props.headers,
      getRequestHeaders: props.getRequestHeaders,
      maxRetryIntervalMs: props.maxRetryIntervalMs,
      stallTimeoutMs: props.stallTimeoutMs,
      onRecoveryAttempt: props.onRecoveryAttempt,
      onError: props.onError,
    };

    // videoFit → object-fit on the media (auto uses contain inside an aspect-ratio'd stage).
    const isAutoFit = videoFit === "auto";
    const mediaStyle = {
      width: "100%",
      height: "100%",
      display: "block",
      objectFit: isAutoFit ? "contain" : videoFit,
    } as const;

    const child = showRealtime ? (
      <RhombusRealtimePlayer
        ref={realtimeHandleRef}
        {...baseChildProps}
        connectionMode={connectionMode}
        realtimeStreamQuality={realtimeQuality}
        canvasProps={{ style: mediaStyle }}
        onReady={handleChildReady}
      />
    ) : (
      <RhombusBufferedPlayer
        ref={bufferedHandleRef}
        {...baseChildProps}
        connectionMode={connectionMode}
        startTimeSec={bufferedStartTimeSec}
        vodDurationSec={vodWindowSec}
        seekOffsetSec={vodSeekOffsetSec}
        bufferedStreamQuality={bufferedQuality}
        applyBufferedStreamQuality={applyBufferedStreamQuality}
        videoProps={{
          controls: false,
          style: mediaStyle,
          muted: videoOwnsDr40Audio
            ? playbackController?.state.muted ?? true
            : true,
        }}
        onReady={handleChildReady}
      />
    );

    const transform = zoom > 1 ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` : undefined;

    // Auto-Size: the player box hugs the video (sized by width via aspect-ratio, height auto).
    const rootStyle = isAutoFit
      ? { display: "flex", flexDirection: "column", ...style, height: "auto" }
      : { display: "flex", flexDirection: "column", ...style };
    const stageStyle = isAutoFit
      ? {
          position: "relative",
          overflow: "hidden",
          background: "#000",
          width: "100%",
          aspectRatio: `${intrinsicAspect.w} / ${intrinsicAspect.h}`,
        }
      : { position: "relative", overflow: "hidden", background: "#000", flex: "1 1 auto", minHeight: 0 };

    return (
      <div className={className} style={rootStyle as CSSProperties}>
        <div
          ref={stageRef}
          style={{
            ...(stageStyle as CSSProperties),
            cursor: zoom > 1 ? (panDragRef.current.active ? "grabbing" : "grab") : "default",
            touchAction: zoom > 1 ? "none" : undefined,
          }}
          onPointerDown={e => {
            if (zoomRef.current <= 1) return;
            panDragRef.current = { active: true, x: e.clientX, y: e.clientY };
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={e => {
            const d = panDragRef.current;
            if (!d.active) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            d.x = e.clientX;
            d.y = e.clientY;
            applyZoom(zoomRef.current, panRef.current.x + dx, panRef.current.y + dy);
          }}
          onPointerUp={() => {
            panDragRef.current.active = false;
          }}
          onPointerCancel={() => {
            panDragRef.current.active = false;
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              transform,
              transformOrigin: "center center",
              transition: "transform 80ms linear",
            }}
          >
            {child}
          </div>
        </div>

        <RhombusPlayerControls
          api={handle}
          state={state}
          controls={controls}
          classNames={classNames}
          renderControls={renderControls}
          showLiveTypeSwitcher={showLiveTypeSwitcher}
          connectionMode={connectionMode}
          realtimeQuality={realtimeQuality}
          bufferedQuality={bufferedQuality}
          onChangeRealtimeQuality={setRealtimeQuality}
          onChangeBufferedQuality={setBufferedQuality}
          videoFit={videoFit}
          onChangeVideoFit={f => {
            setVideoFit(f);
            cbRef.current.onVideoFitChange?.(f);
          }}
          clipSelection={clipSelection}
          showClipOptionsForm={saveClip?.showOptionsForm ?? true}
          defaultClipVisibility={saveClip?.defaultVisibility ?? "ORG_WIDE"}
          requireFootage={saveClip?.requireFootage ?? "any"}
          onToggleClipSelection={toggleClipSelection}
          onExportClip={options => void startClipExport(undefined, options)}
          dateTimePicker={
            <RhombusDateTimePicker
              // While live the label would only update on incidental re-renders (and "now" is
              // implicit), so show the placeholder; opening the picker still seeds Date.now().
              value={mode === "live" ? null : state.currentWallClockMs}
              onChange={seekTo}
              cameraUuid={cameraUuid}
              apiOverrideBaseUrl={props.apiOverrideBaseUrl}
              rhombusApiBaseUrl={props.rhombusApiBaseUrl}
              paths={props.paths}
              federatedSessionToken={props.federatedSessionToken}
              headers={props.headers}
              getRequestHeaders={props.getRequestHeaders}
              disableFootageCheck={!fetchAvailabilityEnabled}
              direction="up"
              onError={props.onError}
            />
          }
        >
          {(controls === undefined || controls.includes("timeline")) && (
            <Timeline
              cameraUuid={cameraUuid}
              playbackController={playbackController}
              className={cx("rhombus-player-timeline", classNames?.timeline)}
              apiOverrideBaseUrl={props.apiOverrideBaseUrl}
              rhombusApiBaseUrl={props.rhombusApiBaseUrl}
              paths={props.paths}
              federatedSessionToken={props.federatedSessionToken}
              headers={props.headers}
              getRequestHeaders={props.getRequestHeaders}
              rangeStartMs={tlRangeStartMs}
              rangeEndMs={tlRangeEndMs}
              currentTimeMs={mode === "live" ? Date.now() : currentWallClockMs}
              onSeek={seekTo}
              selection={clipSelection}
              onSelectionChange={handleSelectionChange}
              selectionMinDurationMs={clipMinMs}
              selectionMaxDurationMs={clipMaxMs}
              onShiftWindow={shiftTimelineWindow}
              canShiftForward={tlCanShiftForward}
              onZoom={zoomTimeline}
              canZoomIn={tlCanZoomIn}
              canZoomOut={tlCanZoomOut}
              fetchSeekPoints={timeline?.fetchSeekPoints ?? true}
              includeAnyMotion={timeline?.includeAnyMotion ?? true}
              fetchAvailability={fetchAvailabilityEnabled}
              onAvailabilityLoaded={handleAvailabilityLoaded}
              marks={timeline?.marks}
              colors={timeline?.colors}
              height={timeline?.height}
              onSeekPointsLoaded={timeline?.onSeekPointsLoaded}
              onError={props.onError}
            />
          )}
        </RhombusPlayerControls>
      </div>
    );
  }
);
