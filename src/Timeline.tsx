import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { DEFAULT_RHOMBUS_API_BASE_URL, mergeRequestHeaders } from "./rhombusPlayback.js";
import { appendFederatedAuthQueryParams, joinUrl } from "./urlAuth.js";
import type { RhombusFootageSeekPoint, TimelineColors, TimelineProps } from "./types.js";

const DEFAULT_FOOTAGE_PATH_OVERRIDE = "/api/footage-seekpoints";
const DEFAULT_FOOTAGE_PATH_DIRECT = "/camera/getFootageSeekpointsV2";
const DEFAULT_HEIGHT = 56;
const MAX_SEEKPOINT_ROWS = 5;
const SEEKPOINT_MERGE_PX = 6;
const ZOOM_ANIM_MS = 220;
const WHEEL_THROTTLE_MS = 130;

const TICK_INCREMENTS_MS = [
  60_000, 5 * 60_000, 10 * 60_000, 20 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000,
  6 * 60 * 60_000,
];

/** A subset of the Console event-type → color map (`a` field from getFootageSeekpointsV2). */
const DEFAULT_EVENT_COLORS: Record<string, string> = {
  MOTION: "#c321e6",
  MOTION_HUMAN: "#fbad00",
  MOTION_CAR: "#9c6a33",
  MOTION_ANIMAL: "#b3b492",
  FACE: "#3b9640",
  FACE_BLACKLISTED: "#ff0000",
  SOUND_LOUD: "#0cadae",
  SOUND_GUN_SHOT: "#222",
  TAMPER: "#888",
};

/** Resolved (non-optional) colors used by the draw code. */
type ResolvedTimelineColors = Required<Omit<TimelineColors, "background" | "eventColors">> & {
  background?: string;
  eventColors: Record<string, string>;
};

const DEFAULT_COLORS: ResolvedTimelineColors = {
  background: undefined,
  availabilityActive: "rgba(120,200,80,0.85)",
  availabilityInactive: "rgba(255,255,255,0.16)",
  playhead: "#3b82f6",
  hover: "rgba(255,255,255,0.55)",
  tick: "rgba(255,255,255,0.28)",
  tickLabel: "rgba(255,255,255,0.5)",
  seekpointDefault: "#7ab8ff",
  seekpointAlert: "#ff5a4d",
  eventColors: DEFAULT_EVENT_COLORS,
  buttonBackground: "#1e1e1e",
  buttonBorder: "#3a3a3a",
  buttonText: "#eee",
};

function resolveColors(colors: TimelineColors | undefined): ResolvedTimelineColors {
  if (!colors) return DEFAULT_COLORS;
  return {
    ...DEFAULT_COLORS,
    ...colors,
    eventColors: { ...DEFAULT_EVENT_COLORS, ...colors.eventColors },
  };
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function pickIncrementMs(durationMs: number): number {
  const target = durationMs / 6;
  let best = TICK_INCREMENTS_MS[0];
  let bestDiff = Infinity;
  for (const inc of TICK_INCREMENTS_MS) {
    const diff = Math.abs(target - inc);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = inc;
    }
  }
  return best;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function tickTimes(start: number, end: number, incMs: number): number[] {
  const dayStart = startOfLocalDay(start);
  const first = dayStart + Math.ceil((start - dayStart) / incMs) * incMs;
  const out: number[] = [];
  for (let t = first; t <= end; t += incMs) out.push(t);
  return out;
}

function fmtTickLabel(ms: number, durationMs: number): string {
  const d = new Date(ms);
  if (durationMs <= 4 * 60 * 60_000) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleTimeString([], { hour: "numeric" });
}

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
    if (cfg.federatedSessionToken) url = appendFederatedAuthQueryParams(url, cfg.federatedSessionToken);
  } else {
    url = joinUrl(overrideBase!, path);
  }

  const res = await fetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`getFootageSeekpointsV2 failed with ${res.status}`);
  const data = (await res.json()) as { footageSeekPoints?: Array<Record<string, unknown>> };
  return (data.footageSeekPoints ?? []).map(p => ({
    // `ts` may be epoch seconds or milliseconds depending on the endpoint/version — normalize.
    timestampMs: typeof p.ts === "number" ? (p.ts < 1e12 ? p.ts * 1000 : p.ts) : 0,
    activity: typeof p.a === "string" ? p.a : undefined,
    alerted: p.al === true,
    raw: p,
  }));
}

/** Points grouped by activity and sorted (computed once per fetch, re-clustered cheaply per draw). */
type GroupedPoints = Array<{ activity: string; points: RhombusFootageSeekPoint[] }>;

function groupByType(points: RhombusFootageSeekPoint[]): GroupedPoints {
  const byType = new Map<string, RhombusFootageSeekPoint[]>();
  for (const p of points) {
    const key = p.activity ?? "OTHER";
    const arr = byType.get(key);
    if (arr) arr.push(p);
    else byType.set(key, [p]);
  }
  const out: GroupedPoints = [];
  for (const [key, pts] of byType) {
    if (out.length >= MAX_SEEKPOINT_ROWS) break;
    pts.sort((a, b) => a.timestampMs - b.timestampMs);
    out.push({ activity: key, points: pts });
  }
  return out;
}

type Cluster = { start: number; end: number; alerted: boolean };

function clusterRow(points: RhombusFootageSeekPoint[], tolMs: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const p of points) {
    const last = clusters[clusters.length - 1];
    if (last && p.timestampMs - last.end <= tolMs) {
      last.end = Math.max(last.end, p.timestampMs);
      last.alerted = last.alerted || !!p.alerted;
    } else {
      clusters.push({ start: p.timestampMs, end: p.timestampMs, alerted: !!p.alerted });
    }
  }
  return clusters;
}

const NAV_BTN_STYLE: React.CSSProperties = {
  cursor: "pointer",
  borderWidth: 1,
  borderStyle: "solid",
  borderRadius: 6,
  width: 26,
  minWidth: 26,
  alignSelf: "stretch",
  font: "14px system-ui, sans-serif",
  lineHeight: 1,
  padding: 0,
};

/**
 * A vendor-neutral canvas scrubber. Renders an availability bar, a time axis with tick labels,
 * event seekpoints (optionally fetched from `/camera/getFootageSeekpointsV2`, grouped into
 * colored rows by activity), static marks, a playhead, and a hover line; emits
 * `onSeek(wallClockMs)` on click/drag. Optional ‹/› chevrons (`onShiftWindow`) shift the window,
 * and optional −/+ buttons + mouse-wheel (`onZoom`) zoom the window with an animated transition.
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
    onShiftWindow,
    canShiftBack = true,
    canShiftForward = true,
    onZoom,
    canZoomIn = true,
    canZoomOut = true,
    fetchSeekPoints = false,
    includeAnyMotion = true,
    marks,
    onSeekPointsLoaded,
    onError,
    colors,
    height = DEFAULT_HEIGHT,
    className,
    style,
  },
  ref
) {
  const theme = useMemo(() => resolveColors(colors), [colors]);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [seekpoints, setSeekpoints] = useState<RhombusFootageSeekPoint[]>([]);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // --- refs the (stable) draw() reads, so it never goes stale ---
  const widthRef = useRef(width);
  widthRef.current = width;
  const heightRef = useRef(height);
  heightRef.current = height;
  const hoverRef = useRef(hoverMs);
  hoverRef.current = hoverMs;
  const currentTimeRef = useRef(currentTimeMs);
  currentTimeRef.current = currentTimeMs;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const rangeStartRef = useRef(rangeStartMs);
  rangeStartRef.current = rangeStartMs;
  const rangeEndRef = useRef(rangeEndMs);
  rangeEndRef.current = rangeEndMs;
  const groupedRef = useRef<GroupedPoints>([]);
  // The currently-drawn (animated) range — lerps toward [rangeStartMs, rangeEndMs].
  const drawRangeRef = useRef({ start: rangeStartMs, end: rangeEndMs });

  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onHoverRef = useRef(onHoverTimeChange);
  onHoverRef.current = onHoverTimeChange;
  const onLoadedRef = useRef(onSeekPointsLoaded);
  onLoadedRef.current = onSeekPointsLoaded;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;

  useImperativeHandle(ref, () => ({ refresh: () => setRefreshKey(k => k + 1) }), []);

  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-group seekpoints whenever they change (sort once; cluster cheaply per draw/frame).
  useEffect(() => {
    groupedRef.current = groupByType(seekpoints);
  }, [seekpoints]);

  // --- seekpoint fetch (quantized to 60s buckets so smooth scrolling doesn't refetch) ---
  const fetchBucketSec = 60;
  const fetchStartSec = Math.floor(rangeStartMs / 1000 / fetchBucketSec) * fetchBucketSec;
  const fetchDurationSec = Math.max(
    fetchBucketSec,
    Math.ceil((rangeEndMs - rangeStartMs) / 1000 / fetchBucketSec) * fetchBucketSec + fetchBucketSec
  );

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

  // --- draw (reads refs + drawRangeRef so it is stable across renders) ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const w = widthRef.current;
    const h = heightRef.current;
    if (!canvas || w === 0) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const c = themeRef.current;
    if (c.background) {
      ctx.fillStyle = c.background;
      ctx.fillRect(0, 0, w, h);
    }

    const start = drawRangeRef.current.start;
    const end = drawRangeRef.current.end;
    const durationMs = end - start;
    if (durationMs <= 0) return;
    const timeToX = (t: number) => ((t - start) / durationMs) * w;

    const now = Date.now();
    const labelH = 14;
    const axisY = h - labelH - 4;
    const barH = 3;
    const spTop = 4;
    const spBottom = axisY - 6;
    const rowGap = 2;

    // Availability bar.
    ctx.fillStyle = c.availabilityInactive;
    ctx.fillRect(0, axisY, w, barH);
    const activeEnd = Math.min(end, now);
    if (activeEnd > start) {
      ctx.fillStyle = c.availabilityActive;
      const x = timeToX(start);
      ctx.fillRect(x, axisY, timeToX(activeEnd) - x, barH);
    }

    // Tick marks + labels.
    const incMs = pickIncrementMs(durationMs);
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "alphabetic";
    for (const t of tickTimes(start, end, incMs)) {
      const x = timeToX(t);
      ctx.fillStyle = c.tick;
      ctx.fillRect(Math.round(x), axisY - 5, 1, 5);
      ctx.fillStyle = c.tickLabel;
      ctx.textAlign = x < 24 ? "left" : x > w - 24 ? "right" : "center";
      ctx.fillText(fmtTickLabel(t, durationMs), Math.min(w - 1, Math.max(1, x)), h - 3);
    }

    // Static marks.
    for (const m of marksRef.current ?? []) {
      const x = timeToX(m.startMs);
      const mw = Math.max(2, timeToX(m.endMs) - x);
      if (m.kind === "gap") {
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(x, axisY, mw, barH);
      } else {
        ctx.fillStyle = m.color ?? c.seekpointDefault;
        ctx.fillRect(x, spTop, mw, 6);
      }
    }

    // Seekpoint rows (clustered colored dashes per activity type).
    const grouped = groupedRef.current;
    if (grouped.length) {
      const tol = (durationMs / w) * SEEKPOINT_MERGE_PX;
      const bandH = spBottom - spTop;
      const rowH = Math.max(3, Math.min(6, (bandH - rowGap * (grouped.length - 1)) / grouped.length));
      grouped.forEach((row, i) => {
        const rowColor = c.eventColors[row.activity] ?? c.seekpointDefault;
        const rowY = spTop + i * (rowH + rowGap);
        const clusters = clusterRow(row.points, tol);
        for (const cl of clusters) {
          const x = timeToX(cl.start);
          const xe = timeToX(cl.end);
          if (x > w || xe < 0) continue;
          ctx.fillStyle = cl.alerted ? c.seekpointAlert : rowColor;
          ctx.fillRect(Math.max(0, x), rowY, Math.max(2, xe - x), rowH);
        }
      });
    }

    // Hover line.
    const hover = hoverRef.current;
    if (hover != null) {
      const x = timeToX(hover);
      ctx.fillStyle = c.hover;
      ctx.fillRect(Math.round(x), 0, 1, axisY + barH);
    }

    // Playhead.
    const cur = currentTimeRef.current;
    if (cur != null) {
      const x = timeToX(cur);
      ctx.fillStyle = c.playhead;
      ctx.fillRect(Math.round(x) - 1, 0, 2, axisY + barH);
    }
  }, []);

  // Redraw on non-range state changes (uses the current animated range).
  useEffect(() => {
    draw();
  }, [draw, width, height, currentTimeMs, hoverMs, seekpoints, marks, theme]);

  // Animate the drawn range toward the target range whenever the props change.
  useEffect(() => {
    const from = { ...drawRangeRef.current };
    const to = { start: rangeStartMs, end: rangeEndMs };
    if (from.start === to.start && from.end === to.end) {
      drawRangeRef.current = to;
      draw();
      return;
    }
    const t0 = Date.now();
    let raf = 0;
    const stepFn = () => {
      const e = easeOutCubic(Math.min(1, (Date.now() - t0) / ZOOM_ANIM_MS));
      drawRangeRef.current = {
        start: from.start + (to.start - from.start) * e,
        end: from.end + (to.end - from.end) * e,
      };
      draw();
      if (e < 1) raf = requestAnimationFrame(stepFn);
    };
    raf = requestAnimationFrame(stepFn);
    return () => cancelAnimationFrame(raf);
  }, [rangeStartMs, rangeEndMs, draw]);

  // Interaction maps against the TARGET range (where the window will settle).
  const clampSeek = useCallback(
    (t: number) => Math.max(rangeStartMs, Math.min(Math.min(rangeEndMs, Date.now()), t)),
    [rangeStartMs, rangeEndMs]
  );
  const xToTimeTarget = useCallback(
    (x: number) => rangeStartMs + (x / Math.max(1, width)) * (rangeEndMs - rangeStartMs),
    [rangeStartMs, rangeEndMs, width]
  );

  const draggingRef = useRef(false);

  const pointerTime = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return clampSeek(xToTimeTarget(clientX - rect.left));
    },
    [clampSeek, xToTimeTarget]
  );

  // Mouse-wheel zoom (native listener so we can preventDefault), centered on the cursor.
  const lastWheelRef = useRef(0);
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!onZoomRef.current || e.deltaY === 0) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheelRef.current < WHEEL_THROTTLE_MS) return;
      lastWheelRef.current = now;
      const rect = el.getBoundingClientRect();
      const w = widthRef.current || rect.width;
      const span = rangeEndRef.current - rangeStartRef.current;
      const center = rangeStartRef.current + ((e.clientX - rect.left) / Math.max(1, w)) * span;
      onZoomRef.current(e.deltaY < 0, center);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const navBtn = (
    key: string,
    enabled: boolean,
    label: string,
    title: string,
    onClick: () => void
  ) => (
    <button
      key={key}
      type="button"
      className={`rhombus-timeline-${key}`}
      style={{
        ...NAV_BTN_STYLE,
        background: theme.buttonBackground,
        borderColor: theme.buttonBorder,
        color: theme.buttonText,
        opacity: enabled ? 1 : 0.35,
        cursor: enabled ? "pointer" : "default",
      }}
      disabled={!enabled}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );

  // Center used by the zoom buttons: the playhead if it's in view, else the window midpoint.
  const zoomButtonCenter = () => {
    const cur = currentTimeMs;
    if (cur != null && cur >= rangeStartMs && cur <= rangeEndMs) return cur;
    return (rangeStartMs + rangeEndMs) / 2;
  };

  return (
    <div
      className={className}
      style={{ display: "flex", alignItems: "stretch", gap: 4, width: "100%", height, ...style }}
    >
      {onShiftWindow && navBtn("nav-back", canShiftBack, "‹", "Earlier", () => onShiftWindow(-1))}
      <div
        ref={canvasWrapRef}
        style={{ position: "relative", flex: "1 1 auto", minWidth: 0, cursor: "pointer", touchAction: "none" }}
        onPointerDown={e => {
          draggingRef.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          const t = pointerTime(e.clientX);
          if (t != null) {
            setHoverMs(t);
            onHoverRef.current?.(t);
          }
        }}
        onPointerMove={e => {
          const t = pointerTime(e.clientX);
          if (t == null) return;
          setHoverMs(t);
          onHoverRef.current?.(t);
          if (draggingRef.current) onSeekRef.current(t);
        }}
        onPointerUp={e => {
          const wasDragging = draggingRef.current;
          draggingRef.current = false;
          const t = pointerTime(e.clientX);
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
      {onShiftWindow && navBtn("nav-fwd", canShiftForward, "›", "Later", () => onShiftWindow(1))}
      {onZoom && (
        <span style={{ display: "flex", alignItems: "stretch", gap: 4 }}>
          {navBtn("zoom-out", canZoomOut, "−", "Zoom out", () => onZoom(false, zoomButtonCenter()))}
          {navBtn("zoom-in", canZoomIn, "+", "Zoom in", () => onZoom(true, zoomButtonCenter()))}
        </span>
      )}
    </div>
  );
});
