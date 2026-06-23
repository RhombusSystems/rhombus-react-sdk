import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { RhombusBufferedPlayer } from "./RhombusBufferedPlayer.js";
import { RhombusRealtimePlayer } from "./RhombusRealtimePlayer.js";
import { RhombusPlayerControls } from "./RhombusPlayerControls.js";
import { Timeline } from "./Timeline.js";
import { snapshotCanvasElement, snapshotVideoElement } from "./playerSnapshot.js";
import {
  buildClipDownloadUrl,
  fetchClipProgress,
  requestClipSplice,
} from "./rhombusClip.js";
import { chooseVodAnchor, isAtLiveEdge, isWithinWindow, shouldSwitchToLive } from "./playerVodTime.js";
import { joinUrl } from "./urlAuth.js";
import type {
  RhombusBufferedPlayerHandle,
  RhombusClipExportStatus,
  RhombusClipRange,
  RhombusLiveTransport,
  RhombusPlayerHandle,
  RhombusPlayerMode,
  RhombusPlayerProps,
  RhombusPlayerState,
  RhombusRealtimePlayerHandle,
  RhombusSnapshotResult,
} from "./types.js";

const MAX_ZOOM = 4;
const MIN_ZOOM = 1;
const ZOOM_STEP = 0.5;
const DEFAULT_VOD_WINDOW_SEC = 7200;
const DEFAULT_REWIND_SEC = 15;
const DEFAULT_LIVE_EDGE_TOLERANCE_SEC = 5;
const DEFAULT_TIMELINE_WINDOW_SEC = 3600;
const CLIP_POLL_INTERVAL_MS = 2_000;
const WALLCLOCK_TICK_MS = 250;
/** While a seek is settling, treat the video as "caught up" once it is within this of the target. */
const SEEK_SETTLE_THRESHOLD_MS = 1_500;
/** Safety cap: stop pinning to the seek target after this long even if the video never reports caught up. */
const SEEK_SETTLE_MAX_MS = 8_000;

const cx = (...xs: Array<string | undefined | false>) => xs.filter(Boolean).join(" ");

function hasWebCodecs(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { VideoDecoder?: unknown }).VideoDecoder !== "undefined"
  );
}

const fillStyle = { width: "100%", height: "100%", display: "block", objectFit: "contain" } as const;

export const RhombusPlayer = forwardRef<RhombusPlayerHandle, RhombusPlayerProps>(
  function RhombusPlayer(props, ref) {
    const {
      cameraUuid,
      connectionMode = "wan",
      liveTransport: liveTransportProp,
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
    const [clipRange, setClipRange] = useState<{ startMs: number | null; endMs: number | null }>({
      startMs: null,
      endMs: null,
    });
    const [clipExport, setClipExport] = useState<RhombusClipExportStatus | undefined>(undefined);
    const [timelineRange, setTimelineRange] = useState<{ startMs: number; endMs: number }>(() => {
      const now = Date.now();
      const win = (timeline?.windowSec ?? DEFAULT_TIMELINE_WINDOW_SEC) * 1000;
      return { startMs: now - win, endMs: now };
    });

    // ---- child handles ----
    const realtimeHandleRef = useRef<RhombusRealtimePlayerHandle>(null);
    const bufferedHandleRef = useRef<RhombusBufferedPlayerHandle>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const readyFiredRef = useRef(false);
    const pauseOnReadyRef = useRef(false);
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
    const clipRangeRef = useRef(clipRange);
    clipRangeRef.current = clipRange;

    const cfg = { vodWindowSec, defaultRewindSec, liveEdgeToleranceSec, autoGoLiveAtEdge };
    const cfgRef = useRef(cfg);
    cfgRef.current = cfg;

    const cbRef = useRef(props);
    cbRef.current = props;

    const prevModeRef = useRef(mode);

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
      pauseOnReadyRef.current = false;
      seekTargetRef.current = null;
      lastShownWallClockRef.current = null;
      setVodAnchorMs(null);
      setVodSeekOffsetSec(0);
      setPlaybackRate(1);
      setCurrentWallClockMs(null);
      setPlaying(true);
      setMode("live");
    }, []);

    const seekTo = useCallback(
      (targetMs: number) => {
        const now = Date.now();
        if (shouldSwitchToLive(targetMs, now, cfgRef.current.liveEdgeToleranceSec)) {
          goLive();
          return;
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
      [enterVod, goLive, getVideo]
    );

    const play = useCallback(() => {
      if (modeRef.current === "vod" || liveTransportRef.current === "buffered") {
        void getVideo()?.play();
        setPlaying(true);
      } else {
        // realtime live is always playing; if we had paused into VOD, return to live
        if (modeRef.current !== "live") goLive();
        setPlaying(true);
      }
    }, [getVideo, goLive]);

    const pause = useCallback(() => {
      if (modeRef.current === "vod" || liveTransportRef.current === "buffered") {
        getVideo()?.pause();
        setPlaying(false);
        return;
      }
      // realtime live: freeze by dropping into VOD at ~now, paused once the <video> is ready
      pauseOnReadyRef.current = true;
      setPlaying(false);
      enterVod(Date.now());
    }, [enterVod, getVideo]);

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
        if (modeRef.current !== "vod") return; // ignored while live
        const v = getVideo();
        if (v) v.playbackRate = rate;
        setPlaybackRate(rate);
      },
      [getVideo]
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

    const startClipExport = useCallback(
      async (range?: RhombusClipRange): Promise<RhombusClipExportStatus> => {
        const r =
          range ??
          (clipRangeRef.current.startMs != null && clipRangeRef.current.endMs != null
            ? {
                startMs: Math.min(clipRangeRef.current.startMs, clipRangeRef.current.endMs),
                endMs: Math.max(clipRangeRef.current.startMs, clipRangeRef.current.endMs),
                cameraUuid,
              }
            : null);
        const fail = (error: string): RhombusClipExportStatus => {
          const s: RhombusClipExportStatus = { phase: "error", error };
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

        clipExportCancelRef.current = false;
        const auth = { headers: props.headers, getRequestHeaders: props.getRequestHeaders };
        const spliceUrl = joinUrl(overrideBase, saveClip?.paths?.splice ?? "/api/save-clip");
        const progressUrl = joinUrl(overrideBase, saveClip?.paths?.progress ?? "/api/clip-progress");
        const downloadUrl = joinUrl(overrideBase, saveClip?.paths?.download ?? "/api/clip-download");

        const emit = (s: RhombusClipExportStatus) => {
          setClipExport(s);
          cbRef.current.onClipExport?.(s);
        };

        emit({ phase: "submitting" });
        try {
          const { clipUuid } = await requestClipSplice({
            ...auth,
            url: spliceUrl,
            cameraUuid,
            startTimeMillis: r.startMs,
            durationSec,
            title: saveClip?.defaultTitle ?? `Clip ${new Date(r.startMs).toISOString()}`,
          });
          emit({ phase: "rendering", clipUuid, percentComplete: 0 });

          // poll until complete
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (clipExportCancelRef.current) {
              const s: RhombusClipExportStatus = { phase: "canceled", clipUuid };
              emit(s);
              return s;
            }
            const progress = await fetchClipProgress({ ...auth, url: progressUrl, clipUuid });
            if (progress.failed) return fail(progress.currentOperation ?? "Clip render failed");
            if (progress.complete) {
              const url = buildClipDownloadUrl({ url: downloadUrl, clipUuid, region: progress.region });
              const s: RhombusClipExportStatus = {
                phase: "complete",
                clipUuid,
                percentComplete: 100,
                downloadUrl: url,
              };
              emit(s);
              return s;
            }
            emit({
              phase: "rendering",
              clipUuid,
              percentComplete: progress.percentComplete,
              currentOperation: progress.currentOperation,
            });
            await new Promise(res => setTimeout(res, CLIP_POLL_INTERVAL_MS));
          }
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
      [cameraUuid, clipEnabled, overrideBase, props.headers, props.getRequestHeaders, saveClip]
    );

    useEffect(() => () => {
      clipExportCancelRef.current = true;
    }, []);

    // ---- child ready ----
    const handleChildReady = useCallback(() => {
      if (!readyFiredRef.current) {
        readyFiredRef.current = true;
        cbRef.current.onReady?.();
      }
      if (pauseOnReadyRef.current) {
        pauseOnReadyRef.current = false;
        const v = getVideo();
        if (v) {
          v.pause();
          setPlaying(false);
        }
      }
    }, [getVideo]);

    // ---- keep `playing` and `playbackRate` in sync with the <video> element ----
    useEffect(() => {
      const v = getVideo();
      if (!v) return;
      const onPlay = () => setPlaying(true);
      const onPause = () => setPlaying(false);
      const onRate = () => setPlaybackRate(v.playbackRate);
      v.addEventListener("play", onPlay);
      v.addEventListener("pause", onPause);
      v.addEventListener("ratechange", onRate);
      return () => {
        v.removeEventListener("play", onPlay);
        v.removeEventListener("pause", onPause);
        v.removeEventListener("ratechange", onRate);
      };
    }, [getVideo, mode, liveTransportState, vodAnchorMs]);

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
          if (cfgRef.current.autoGoLiveAtEdge) {
            if (isAtLiveEdge(wc, Date.now(), cfgRef.current.liveEdgeToleranceSec)) goLive();
          }
        }
      }, WALLCLOCK_TICK_MS);
      return () => clearInterval(id);
    }, [mode, computeWallClock, goLive, getVideo]);

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

    // ---- timeline display window ----
    // Live: pin the window to [now - W, now] (playhead rides the right edge).
    // VOD: keep the window STABLE so a clicked time stays under the cursor; only scroll once
    // the playhead leaves the visible window (normal scrubber behavior). Re-centering on every
    // seek/tick would move the clicked time off the pixel the user clicked.
    useEffect(() => {
      const win = (timeline?.windowSec ?? DEFAULT_TIMELINE_WINDOW_SEC) * 1000;
      const recompute = () => {
        const now = Date.now();
        if (modeRef.current === "live") {
          setTimelineRange({ startMs: now - win, endMs: now });
          return;
        }
        const cur = computeWallClock() ?? vodAnchorRef.current ?? now;
        setTimelineRange(prev => {
          const margin = win * 0.05;
          // Keep the window unchanged while the playhead is comfortably inside it.
          if (cur >= prev.startMs + margin && cur <= prev.endMs - margin) return prev;
          // Otherwise scroll so the playhead is centered (never showing the future).
          const endMs = Math.min(now, cur + win / 2);
          return { startMs: endMs - win, endMs };
        });
      };
      recompute();
      const id = setInterval(recompute, 1_000);
      return () => clearInterval(id);
    }, [mode, timeline?.windowSec, computeWallClock]);

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

    const child = showRealtime ? (
      <RhombusRealtimePlayer
        ref={realtimeHandleRef}
        {...baseChildProps}
        connectionMode={connectionMode}
        realtimeStreamQuality={realtimeQuality}
        canvasProps={{ style: fillStyle }}
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
        videoProps={{ controls: false, style: fillStyle }}
        onReady={handleChildReady}
      />
    );

    const transform = zoom > 1 ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` : undefined;

    return (
      <div className={className} style={{ display: "flex", flexDirection: "column", ...style }}>
        <div
          ref={stageRef}
          style={{
            position: "relative",
            overflow: "hidden",
            background: "#000",
            flex: "1 1 auto",
            minHeight: 0,
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
          clipRange={clipRange}
          onSetClipStart={() => {
            const t = computeWallClock();
            if (t != null) {
              const next = { ...clipRangeRef.current, startMs: t };
              setClipRange(next);
              emitClipRange(next);
            }
          }}
          onSetClipEnd={() => {
            const t = computeWallClock();
            if (t != null) {
              const next = { ...clipRangeRef.current, endMs: t };
              setClipRange(next);
              emitClipRange(next);
            }
          }}
          onClearClip={() => setClipRange({ startMs: null, endMs: null })}
          onExportClip={() => void startClipExport()}
        >
          {(controls === undefined || controls.includes("timeline")) && (
            <Timeline
              cameraUuid={cameraUuid}
              className={cx("rhombus-player-timeline", classNames?.timeline)}
              apiOverrideBaseUrl={props.apiOverrideBaseUrl}
              rhombusApiBaseUrl={props.rhombusApiBaseUrl}
              paths={props.paths}
              federatedSessionToken={props.federatedSessionToken}
              headers={props.headers}
              getRequestHeaders={props.getRequestHeaders}
              rangeStartMs={timelineRange.startMs}
              rangeEndMs={timelineRange.endMs}
              currentTimeMs={mode === "live" ? Date.now() : currentWallClockMs}
              onSeek={seekTo}
              fetchSeekPoints={timeline?.fetchSeekPoints ?? true}
              includeAnyMotion={timeline?.includeAnyMotion ?? true}
              marks={timeline?.marks}
              height={timeline?.height}
              onError={props.onError}
            />
          )}
        </RhombusPlayerControls>
      </div>
    );

    function emitClipRange(next: { startMs: number | null; endMs: number | null }) {
      if (next.startMs != null && next.endMs != null) {
        cbRef.current.onClipRangeSelect?.({
          startMs: Math.min(next.startMs, next.endMs),
          endMs: Math.max(next.startMs, next.endMs),
          cameraUuid,
        });
      }
    }
  }
);
