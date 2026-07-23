import { DEFAULT_RHOMBUS_API_BASE_URL, mergeRequestHeaders } from "./rhombusPlayback.js";
import { appendFederatedAuthQueryParams, joinUrl } from "./urlAuth.js";
import type {
  RhombusFootageAvailability,
  RhombusFootageGap,
  RhombusFootageWindow,
  RhombusRangeCoverage,
} from "./types.js";

/**
 * Footage-availability client + math for `/camera/getPresenceWindows`.
 *
 * Vocabulary note: the Rhombus endpoint is named "presence windows" (so the fetch function and
 * `paths.presenceWindows` follow the endpoint, like `footageSeekpoints`); the Timeline surface
 * calls the same concept "availability" (matching its `availability*` color keys); and the
 * normalized data type is {@link RhombusFootageWindow}. All three refer to recorded-footage
 * coverage.
 *
 * Rhombus serves "VIDEO NOT AVAILABLE" placeholder frames (as a normal 200 video stream) for
 * time ranges with no recorded footage, and `/video/spliceV3` happily renders clips over such
 * ranges. Presence windows are the reliable way to know footage actually exists: the camera
 * reports its recorded-segment ranges, retention-trimmed, split into cloud-archived
 * (`VideoCloud`) and on-camera (`VideoLocal`) coverage.
 */

const DEFAULT_PRESENCE_PATH_OVERRIDE = "/api/presence-windows";
const DEFAULT_PRESENCE_PATH_DIRECT = "/camera/getPresenceWindows";

/**
 * Adjacent presence windows commonly have sub-second seams between 2-second media segments;
 * windows closer than this are merged so hairline seams never register as gaps.
 */
export const FOOTAGE_JOIN_TOLERANCE_MS = 2_000;
/** Gaps shorter than this are ignored (below the seam/quantization noise floor). */
export const FOOTAGE_MIN_GAP_MS = 2_000;
/**
 * Presence ingest lags wall-clock (the camera reports coverage periodically), so the most
 * recent moments look uncovered even though footage exists. Time within this window of "now"
 * is treated as covered/unknown rather than as a gap.
 */
export const FOOTAGE_LIVE_GRACE_MS = 120_000;

/** Options for {@link fetchPresenceWindows}. */
export type FetchPresenceWindowsOptions = {
  /** Proxy base URL; when set the request goes to `paths.presenceWindows` on your server. */
  apiOverrideBaseUrl?: string;
  /** Rhombus REST API base for direct mode. Default `https://api2.rhombussystems.com/api`. */
  rhombusApiBaseUrl?: string;
  /** Path override. Defaults: proxy `/api/presence-windows`, direct `/camera/getPresenceWindows`. */
  presenceWindowsPath?: string;
  /** Federated session token appended as query params in direct mode. */
  federatedSessionToken?: string;
  /** Static headers for the `fetch`. */
  headers?: HeadersInit;
  /** Async headers merged after `headers`. */
  getRequestHeaders?: () => HeadersInit | Promise<HeadersInit>;
  cameraUuid: string;
  /** Range start, epoch seconds. */
  startTimeSec: number;
  /** Range length in seconds. */
  durationSec: number;
  /** Optional abort signal (e.g. a pre-export check with a timeout). */
  signal?: AbortSignal;
};

type WirePresenceWindow = { startSeconds?: number; durationSeconds?: number };

/**
 * Fetches recorded-footage coverage for a camera + range and normalizes it to
 * {@link RhombusFootageAvailability}.
 *
 * Throws on non-2xx responses **and on a 200 body without a `presenceWindows` key** — a body
 * missing the key is a mis-routed/error response, not "no footage". Only an empty
 * `presenceWindows` map (or empty window lists) means the range genuinely has no footage.
 * Callers treat a throw as "availability unknown" (fail open), never as "no footage".
 *
 * Caveat carried on each window's `source`: `local` windows are on the camera's SD card and
 * are only retrievable while the camera is online/reachable; `cloud` windows are always
 * retrievable.
 */
export async function fetchPresenceWindows(
  options: FetchPresenceWindowsOptions
): Promise<RhombusFootageAvailability> {
  const overrideBase = options.apiOverrideBaseUrl?.trim() || undefined;
  const useDirect = overrideBase === undefined;
  const path =
    options.presenceWindowsPath ??
    (useDirect ? DEFAULT_PRESENCE_PATH_DIRECT : DEFAULT_PRESENCE_PATH_OVERRIDE);

  let url: string;
  if (useDirect) {
    const base = options.rhombusApiBaseUrl?.trim() || DEFAULT_RHOMBUS_API_BASE_URL;
    url = joinUrl(base, path);
    if (options.federatedSessionToken) {
      url = appendFederatedAuthQueryParams(url, options.federatedSessionToken);
    }
  } else {
    url = joinUrl(overrideBase!, path);
  }

  const headers = await mergeRequestHeaders(options.headers, options.getRequestHeaders);
  const body = {
    cameraUuid: options.cameraUuid,
    startTimeSec: Math.floor(options.startTimeSec),
    durationSec: Math.ceil(options.durationSec),
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`getPresenceWindows failed with ${res.status}`);
  const data = (await res.json()) as {
    presenceWindows?: Record<string, WirePresenceWindow[] | undefined>;
    error?: boolean;
    errorMsg?: string;
  };
  if (data.error) throw new Error(data.errorMsg || "getPresenceWindows returned an error");
  if (!data.presenceWindows || typeof data.presenceWindows !== "object") {
    throw new Error("getPresenceWindows response has no presenceWindows field");
  }

  const windows: RhombusFootageWindow[] = [];
  const collect = (key: string, source: RhombusFootageWindow["source"]) => {
    for (const w of data.presenceWindows?.[key] ?? []) {
      if (typeof w?.startSeconds !== "number" || typeof w?.durationSeconds !== "number") continue;
      if (w.durationSeconds <= 0) continue;
      windows.push({
        startMs: w.startSeconds * 1000,
        endMs: (w.startSeconds + w.durationSeconds) * 1000,
        source,
      });
    }
  };
  collect("VideoCloud", "cloud");
  collect("VideoLocal", "local");
  windows.sort((a, b) => a.startMs - b.startMs);

  return {
    windows,
    fetchedStartMs: body.startTimeSec * 1000,
    fetchedEndMs: (body.startTimeSec + body.durationSec) * 1000,
  };
}

/** A plain time range (source-agnostic), used for merged coverage. */
type Range = { startMs: number; endMs: number };

/**
 * Merges windows (any mix of sources) into a sorted union of covered ranges, joining windows
 * separated by less than `joinToleranceMs` so sub-second segment seams don't read as gaps.
 */
export function mergeFootageWindows(
  windows: readonly RhombusFootageWindow[],
  joinToleranceMs: number = FOOTAGE_JOIN_TOLERANCE_MS
): Range[] {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const merged: Range[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.startMs <= last.endMs + joinToleranceMs) {
      last.endMs = Math.max(last.endMs, w.endMs);
    } else {
      merged.push({ startMs: w.startMs, endMs: w.endMs });
    }
  }
  return merged;
}

/**
 * Computes confirmed no-footage gaps within `[rangeStartMs, rangeEndMs]`.
 *
 * Gaps are only ever claimed where the answer is actually known: inside the availability's
 * fetched range, in the past, and older than the live-edge grace window. Everything else
 * (future time, time outside the fetched range, time near "now") is unknown — not a gap.
 */
export function computeFootageGaps(
  availability: RhombusFootageAvailability,
  rangeStartMs: number,
  rangeEndMs: number,
  nowMs: number,
  graceMs: number = FOOTAGE_LIVE_GRACE_MS,
  minGapMs: number = FOOTAGE_MIN_GAP_MS
): RhombusFootageGap[] {
  const lo = Math.max(rangeStartMs, availability.fetchedStartMs);
  const hi = Math.min(rangeEndMs, availability.fetchedEndMs, nowMs - graceMs);
  if (hi <= lo) return [];

  const merged = mergeFootageWindows(availability.windows);
  const gaps: RhombusFootageGap[] = [];
  let cursor = lo;
  for (const w of merged) {
    if (w.endMs <= lo) continue;
    if (w.startMs >= hi) break;
    if (w.startMs > cursor) gaps.push({ startMs: cursor, endMs: Math.min(w.startMs, hi) });
    cursor = Math.max(cursor, w.endMs);
    if (cursor >= hi) break;
  }
  if (cursor < hi) gaps.push({ startMs: cursor, endMs: hi });
  return gaps.filter(g => g.endMs - g.startMs >= minGapMs);
}

/**
 * Computes footage coverage of `[startMs, endMs]` (e.g. a clip selection).
 *
 * Returns `null` when coverage cannot be determined: the range extends outside the
 * availability's fetched range (beyond the grace-window allowance at the live edge), or the
 * range is empty. `null` means unknown — callers must not warn or block on it.
 */
export function computeRangeCoverage(
  availability: RhombusFootageAvailability | null | undefined,
  startMs: number,
  endMs: number,
  nowMs: number = Date.now(),
  graceMs: number = FOOTAGE_LIVE_GRACE_MS
): RhombusRangeCoverage | null {
  if (!availability) return null;
  const end = Math.min(endMs, nowMs);
  const totalMs = end - startMs;
  if (totalMs <= 0) return null;
  // Known only when the queried range is inside what was actually fetched. The live-edge
  // grace region counts as covered, so a range ending near "now" is still evaluatable.
  if (startMs < availability.fetchedStartMs) return null;
  if (Math.min(end, nowMs - graceMs) > availability.fetchedEndMs) return null;

  const gaps = computeFootageGaps(availability, startMs, end, nowMs, graceMs);
  const gapMs = gaps.reduce((sum, g) => sum + (g.endMs - g.startMs), 0);
  const coveredMs = Math.max(0, totalMs - gapMs);
  return {
    coveredMs,
    totalMs,
    coverageRatio: totalMs > 0 ? coveredMs / totalMs : 1,
    gaps,
  };
}
