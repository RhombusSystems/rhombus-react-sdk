import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { DEFAULT_RHOMBUS_API_BASE_URL, mergeRequestHeaders } from "./rhombusPlayback.js";
import { appendFederatedAuthQueryParams, joinUrl } from "./urlAuth.js";
import type { RhombusFootageSeekPoint, TimelineProps } from "./types.js";

const DEFAULT_FOOTAGE_PATH_OVERRIDE = "/api/footage-seekpoints";
const DEFAULT_FOOTAGE_PATH_DIRECT = "/camera/getFootageSeekpointsV2";
const DEFAULT_HEIGHT = 48;

/** Imperative handle for {@link Timeline}: force a seekpoint refetch. */
export type TimelineHandle = { refresh: () => void };

type SeekpointFetchConfig = {
  apiOverrideBaseUrl?: string;
  rhombusApiBaseUrl?: string;
  footageSeekpointsPath?: string;
  federatedSessionToken?: string;
  headers?: HeadersInit;
  getRequestHeaders?: () => HeadersInit | Promise<HeadersInit>;
  cameraUuid: string;
  startTimeSec: number;
  durationSec: number;
  includeAnyMotion: boolean;
};

async function fetchFootageSeekpoints(cfg: SeekpointFetchConfig): Promise<RhombusFootageSeekPoint[]> {
  const overrideBase = cfg.apiOverrideBaseUrl?.trim() || undefined;
  const useDirect = overrideBase === undefined;
  const path =
    cfg.footageSeekpointsPath ??
    (useDirect ? DEFAULT_FOOTAGE_PATH_DIRECT : DEFAULT_FOOTAGE_PATH_OVERRIDE);

  const requestHeaders = await mergeRequestHeaders(cfg.headers, cfg.getRequestHeaders);
  const body = {
    cameraUuid: cfg.cameraUuid,
    startTime: cfg.startTimeSec,
    duration: cfg.durationSec,
    includeAnyMotion: cfg.includeAnyMotion,
  };

  let url: string;
  if (useDirect) {
    const base = cfg.rhombusApiBaseUrl?.trim() || DEFAULT_RHOMBUS_API_BASE_URL;
    url = joinUrl(base, path);
    // Direct Rhombus calls authenticate the federated token via query params (same as media).
    if (cfg.federatedSessionToken) url = appendFederatedAuthQueryParams(url, cfg.federatedSessionToken);
  } else {
    url = joinUrl(overrideBase!, path);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`getFootageSeekpointsV2 failed with ${res.status}`);
  const data = (await res.json()) as { footageSeekPoints?: Array<Record<string, unknown>> };
  return (data.footageSeekPoints ?? []).map(p => ({
    timestampMs: (typeof p.ts === "number" ? p.ts : 0) * 1000,
    activity: typeof p.a === "string" ? p.a : undefined,
    alerted: p.al === true,
    raw: p,
  }));
}

/**
 * A vendor-neutral canvas scrubber. Renders an availability bar, event seekpoints
 * (optionally fetched from `/camera/getFootageSeekpointsV2`), static marks, a playhead, and a
 * hover line; emits `onSeek(wallClockMs)` on click/drag. It does **not** embed a player —
 * pair it with `RhombusBufferedPlayer` / `RhombusPlayer` or any video source.
 */
export const Timeline = forwardRef<TimelineHandle, TimelineProps>(function Timeline(
  {
    cameraUuid,
    apiOverrideBaseUrl,
    rhombusApiBaseUrl,
    paths,
    federatedSessionToken,
    headers,
    getRequestHeaders,
    rangeStartMs,
    rangeEndMs,
    currentTimeMs,
    onSeek,
    onHoverTimeChange,
    fetchSeekPoints = false,
    includeAnyMotion = true,
    marks,
    onSeekPointsLoaded,
    onError,
    height = DEFAULT_HEIGHT,
    className,
    style,
  },
  ref
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [seekpoints, setSeekpoints] = useState<RhombusFootageSeekPoint[]>([]);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // keep latest callbacks without retriggering effects
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onHoverRef = useRef(onHoverTimeChange);
  onHoverRef.current = onHoverTimeChange;
  const onLoadedRef = useRef(onSeekPointsLoaded);
  onLoadedRef.current = onSeekPointsLoaded;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useImperativeHandle(ref, () => ({ refresh: () => setRefreshKey(k => k + 1) }), []);

  // Track container width.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Quantize the fetch window to 60s buckets so a smoothly-scrolling display range (which can
  // change every second while live) does not trigger a seekpoint refetch on every tick.
  const fetchBucketSec = 60;
  const fetchStartSec = Math.floor(rangeStartMs / 1000 / fetchBucketSec) * fetchBucketSec;
  const fetchDurationSec = Math.max(
    fetchBucketSec,
    Math.ceil((rangeEndMs - rangeStartMs) / 1000 / fetchBucketSec) * fetchBucketSec + fetchBucketSec
  );

  // Fetch seekpoints for the (bucketed) visible range.
  useEffect(() => {
    if (!fetchSeekPoints) {
      setSeekpoints([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const points = await fetchFootageSeekpoints({
          apiOverrideBaseUrl,
          rhombusApiBaseUrl,
          footageSeekpointsPath: paths?.footageSeekpoints,
          federatedSessionToken,
          headers,
          getRequestHeaders,
          cameraUuid,
          startTimeSec: fetchStartSec,
          durationSec: fetchDurationSec,
          includeAnyMotion,
        });
        if (cancelled) return;
        setSeekpoints(points);
        onLoadedRef.current?.(points);
      } catch (e) {
        if (cancelled) return;
        onErrorRef.current?.(e instanceof Error ? e : new Error(String(e)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    fetchSeekPoints,
    apiOverrideBaseUrl,
    rhombusApiBaseUrl,
    paths?.footageSeekpoints,
    federatedSessionToken,
    headers,
    getRequestHeaders,
    cameraUuid,
    fetchStartSec,
    fetchDurationSec,
    includeAnyMotion,
    refreshKey,
  ]);

  const timeToX = useCallback(
    (t: number) => ((t - rangeStartMs) / (rangeEndMs - rangeStartMs)) * width,
    [rangeStartMs, rangeEndMs, width]
  );
  const xToTime = useCallback(
    (x: number) => rangeStartMs + (x / Math.max(1, width)) * (rangeEndMs - rangeStartMs),
    [rangeStartMs, rangeEndMs, width]
  );

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const now = Date.now();
    const barY = height - 6;
    const barH = 4;
    const eventY = 6;
    const eventH = barY - eventY - 2;

    // Availability bar: inactive (full) then active (up to now within range).
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(0, barY, width, barH);
    const activeEnd = Math.min(rangeEndMs, now);
    if (activeEnd > rangeStartMs) {
      ctx.fillStyle = "rgba(120,200,80,0.85)";
      const x = timeToX(rangeStartMs);
      const w = timeToX(activeEnd) - x;
      ctx.fillRect(x, barY, w, barH);
    }

    // Static marks (events / gaps).
    for (const m of marks ?? []) {
      const x = timeToX(m.startMs);
      const w = Math.max(1, timeToX(m.endMs) - x);
      if (m.kind === "gap") {
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(x, barY, w, barH);
      } else {
        ctx.fillStyle = m.color ?? "rgba(80,150,255,0.7)";
        ctx.fillRect(x, eventY, w, eventH);
      }
    }

    // Event seekpoints as thin ticks.
    for (const p of seekpoints) {
      const x = timeToX(p.timestampMs);
      if (x < 0 || x > width) continue;
      ctx.fillStyle = p.alerted ? "rgba(255,140,40,0.9)" : "rgba(80,200,160,0.8)";
      ctx.fillRect(Math.round(x), eventY, 2, eventH);
    }

    // Hover line.
    if (hoverMs != null) {
      const x = timeToX(hoverMs);
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillRect(Math.round(x), 0, 1, height);
    }

    // Playhead.
    if (currentTimeMs != null) {
      const x = timeToX(currentTimeMs);
      ctx.fillStyle = "#3b82f6";
      ctx.fillRect(Math.round(x) - 1, 0, 2, height);
    }
  }, [width, height, rangeStartMs, rangeEndMs, currentTimeMs, hoverMs, seekpoints, marks, timeToX]);

  const clampSeek = useCallback(
    (t: number) => Math.max(rangeStartMs, Math.min(Math.min(rangeEndMs, Date.now()), t)),
    [rangeStartMs, rangeEndMs]
  );

  const draggingRef = useRef(false);

  const handlePointer = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return clampSeek(xToTime(clientX - rect.left));
    },
    [clampSeek, xToTime]
  );

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{ width: "100%", height, cursor: "pointer", touchAction: "none", ...style }}
      onPointerDown={e => {
        draggingRef.current = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        const t = handlePointer(e.clientX);
        if (t != null) {
          setHoverMs(t);
          onHoverRef.current?.(t);
        }
      }}
      onPointerMove={e => {
        const t = handlePointer(e.clientX);
        if (t == null) return;
        setHoverMs(t);
        onHoverRef.current?.(t);
        if (draggingRef.current) onSeekRef.current(t);
      }}
      onPointerUp={e => {
        const wasDragging = draggingRef.current;
        draggingRef.current = false;
        const t = handlePointer(e.clientX);
        if (t != null && wasDragging) onSeekRef.current(t);
      }}
      onPointerLeave={() => {
        if (draggingRef.current) return;
        setHoverMs(null);
        onHoverRef.current?.(null);
      }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height, display: "block" }} />
    </div>
  );
});
