/**
 * Pure, side-effect-free helpers for mapping wall-clock time onto the buffered (DASH) VOD
 * window that {@link RhombusPlayer} uses when it switches from live into past footage.
 *
 * A VOD manifest window is described by an `anchorMs` (wall-clock origin = dash `startTimeSec`)
 * and a `windowSec` length. The underlying `<video>.currentTime` is relative to that origin,
 * so the current wall-clock during VOD playback is `anchorMs + currentTime*1000`.
 */

/** Options for {@link chooseVodAnchor}. */
export type ChooseVodAnchorOptions = {
  /** The wall-clock time (epoch ms) the user wants to land on. */
  targetMs: number;
  /** Length of the VOD manifest window in seconds. */
  windowSec: number;
  /** Current wall-clock (epoch ms). */
  nowMs: number;
  /**
   * Seconds of headroom to place *before* `targetMs` so the user can rewind a little without
   * immediately rebuilding the manifest. Default: `min(windowSec * 0.1, 300)`.
   */
  leadInSec?: number;
};

/** Result of {@link chooseVodAnchor}: the manifest origin and where to start playback within it. */
export type VodAnchor = {
  /** Wall-clock origin of the manifest window (epoch ms) — becomes dash `startTimeSec`. */
  anchorMs: number;
  /** Offset in seconds from `anchorMs` where playback should begin. */
  seekOffsetSec: number;
};

/**
 * Pick a VOD manifest window that contains `targetMs`, anchored slightly before it for rewind
 * headroom, and never starting in the future.
 */
export function chooseVodAnchor({
  targetMs,
  windowSec,
  nowMs,
  leadInSec,
}: ChooseVodAnchorOptions): VodAnchor {
  const lead = leadInSec ?? Math.min(windowSec * 0.1, 300);
  let anchorMs = targetMs - lead * 1000;
  const maxAnchorMs = nowMs - 1000;
  if (anchorMs > maxAnchorMs) anchorMs = maxAnchorMs;
  if (anchorMs < 0) anchorMs = 0;
  const seekOffsetSec = Math.max(0, (targetMs - anchorMs) / 1000);
  return { anchorMs, seekOffsetSec };
}

/** Whether `targetMs` falls inside the loaded window `[anchorMs, anchorMs + windowSec]`. */
export function isWithinWindow(targetMs: number, anchorMs: number, windowSec: number): boolean {
  return targetMs >= anchorMs && targetMs <= anchorMs + windowSec * 1000;
}

/** Convert a `<video>.currentTime` (seconds, relative to the window origin) to wall-clock ms. */
export function vodOffsetToWallClock(anchorMs: number, currentTimeSec: number): number {
  return anchorMs + currentTimeSec * 1000;
}

/** Convert a wall-clock time to an offset (seconds) within the window, clamped at 0. */
export function wallClockToVodOffset(anchorMs: number, wallClockMs: number): number {
  return Math.max(0, (wallClockMs - anchorMs) / 1000);
}

/** A target within `toleranceSec` of now is treated as "live" rather than a past seek. */
export function shouldSwitchToLive(
  targetMs: number,
  nowMs: number,
  toleranceSec: number
): boolean {
  return targetMs >= nowMs - toleranceSec * 1000;
}

/** Whether a given playback wall-clock is effectively at the live edge. `null` ⇒ live. */
export function isAtLiveEdge(
  wallClockMs: number | null,
  nowMs: number,
  toleranceSec: number
): boolean {
  if (wallClockMs == null) return true;
  return wallClockMs >= nowMs - toleranceSec * 1000;
}
