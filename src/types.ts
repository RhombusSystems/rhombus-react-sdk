import type {
  CanvasHTMLAttributes,
  CSSProperties,
  ReactNode,
  VideoHTMLAttributes,
} from "react";
import type { MediaPlayerClass } from "dashjs";

/** Live buffered DASH: server downscale via `_ds` on segment URLs (Rhombus Console `BufferedResolutionQuality`). */
export type RhombusBufferedStreamQuality = "HIGH" | "MEDIUM" | "LOW";

/** Live realtime WebSocket: SD uses `/wsl` instead of `/ws` (Rhombus Console `RealtimeResolutionQuality`). */
export type RhombusRealtimeStreamQuality = "HD" | "SD";

/** WAN vs LAN media selection from `getMediaUris` (buffered DASH and realtime WebSocket). */
export type RhombusConnectionMode = "wan" | "lan";

export type RhombusPlayerPaths = {
  /**
   * POST path for federated session token. Resolved against `apiOverrideBaseUrl` when set, otherwise against
   * `window.location.origin` (same-origin). Default `/api/federated-token` (matches Rhombus player-example).
   * If you see 404 in the console for this URL, implement the route or set this to your server path.
   */
  federatedToken?: string;
  /**
   * POST path for media URIs. When `apiOverrideBaseUrl` is set, resolved against that base (default `/api/media-uris`).
   * When omitted on `RhombusBufferedPlayer`, resolved against `rhombusApiBaseUrl` (default `/camera/getMediaUris`).
   */
  mediaUris?: string;
  /**
   * POST path for footage seekpoints (`/camera/getFootageSeekpointsV2`). Used by {@link Timeline} when
   * `fetchSeekPoints` is enabled. In proxy mode resolved against `apiOverrideBaseUrl` (default
   * `/api/footage-seekpoints`); in direct Rhombus mode resolved against `rhombusApiBaseUrl`
   * (default `/camera/getFootageSeekpointsV2`).
   */
  footageSeekpoints?: string;
  /**
   * POST path for footage availability (`/camera/getPresenceWindows`). Used by {@link Timeline} when
   * `fetchAvailability` is enabled and by the built-in Save Clip pre-check. In proxy mode resolved
   * against `apiOverrideBaseUrl` (default `/api/presence-windows`); in direct Rhombus mode resolved
   * against `rhombusApiBaseUrl` (default `/camera/getPresenceWindows`).
   */
  presenceWindows?: string;
};

/**
 * Auth, endpoint, and resilience props shared by every Rhombus player
 * (`RhombusBufferedPlayer`, `RhombusRealtimePlayer`, and the unified `RhombusPlayer`).
 */
export type RhombusPlayerBaseProps = {
  /** Camera UUID from Rhombus (safe to use in the browser). */
  cameraUuid: string;
  /**
   * `wan`: use the WAN media URIs from `getMediaUris`.
   * `lan`: use the LAN media URIs (first entry wins). Default `wan`.
   * Changing mode re-initializes the underlying transport.
   */
  connectionMode?: RhombusConnectionMode;
  /**
   * Optional base URL for HTTP requests that **override** the defaults. When **set**, both the federated-token
   * request and the media-URIs request use this base: `joinUrl(apiOverrideBaseUrl, paths.federatedToken)` and
   * `joinUrl(apiOverrideBaseUrl, paths.mediaUris)`. Use when your backend is on another origin/port, or all
   * browser traffic should go through your server (e.g. no domain-scoped federated token).
   *
   * When **omitted**, the token is fetched from `window.location.origin` + `paths.federatedToken`, and media
   * URIs are requested from the Rhombus API (`rhombusApiBaseUrl`) with federated auth — requires a token
   * created with a matching Rhombus `domain` field so the browser may call `api2.rhombussystems.com`.
   */
  apiOverrideBaseUrl?: string;
  /**
   * Rhombus REST API base (no trailing slash required). Default `https://api2.rhombussystems.com/api`.
   * Only used for media requests when `apiOverrideBaseUrl` is omitted.
   */
  rhombusApiBaseUrl?: string;
  /** Path segments for token, media, and seekpoints endpoints. Defaults match player-example or Rhombus paths by mode. */
  paths?: RhombusPlayerPaths;
  /**
   * When set, this token is used for media requests and the SDK does not call the federated-token endpoint.
   * Must be non-empty. You are responsible for minting and refreshing the token; when it changes the player
   * re-resolves media with the new token (realtime reconnects; buffered updates segment URLs without remount).
   */
  federatedSessionToken?: string;
  /**
   * Federated token duration in seconds (sent to your token endpoint when the SDK fetches or re-fetches the token).
   * Default: 86400 (24h). Ignored when `federatedSessionToken` is provided.
   */
  tokenDurationSec?: number;
  /** Static headers for your token endpoint `fetch` (and for media when using `apiOverrideBaseUrl`). */
  headers?: HeadersInit;
  /**
   * Async headers merged after `headers`. Applied to the federated-token request always; to the media-URIs
   * request only when `apiOverrideBaseUrl` is set. Not sent to `api2.rhombussystems.com` in direct Rhombus mode.
   */
  getRequestHeaders?: () => HeadersInit | Promise<HeadersInit>;
  /**
   * Ceiling for the auto-recovery retry interval in milliseconds. On a recoverable failure the SDK tears the
   * transport down and rebuilds it with exponential backoff (2s → 4s → 8s → … up to this cap), retrying
   * indefinitely; after ~30s of healthy playback the backoff resets. Default `30000`. Set to `0` to disable.
   */
  maxRetryIntervalMs?: number;
  /**
   * Stall watchdog timeout in milliseconds. If no playback progress / decoded frames are observed for this
   * duration (and the stream is not intentionally paused), the transport is rebuilt. Default `12000`.
   * Set to `0` to disable the watchdog.
   */
  stallTimeoutMs?: number;
  /**
   * Called on each auto-recovery attempt so the consumer can show "reconnecting…" UI.
   * `attempt` is the 1-based consecutive failure count (resets after sustained healthy playback).
   */
  onRecoveryAttempt?: (attempt: number, error: Error) => void;
  className?: string;
  style?: CSSProperties;
  /** Called when token fetch, media URI fetch, or transport setup fails. */
  onError?: (error: Error) => void;
};

export type RhombusBufferedPlayerProps = RhombusPlayerBaseProps & {
  /**
   * Unix epoch **seconds** for the start of the VOD (historical footage) manifest window.
   * When set, the player uses VOD MPD URI templates (`wanVodMpdUriTemplate` / `lanVodMpdUrisTemplates`)
   * instead of live URIs. When omitted, the player operates in live mode (default).
   *
   * Changing this value tears down the current Dash.js instance and attaches a new manifest.
   *
   * @example
   * ```ts
   * // Play footage starting at midnight UTC on 2025-04-15
   * startTimeSec={Math.floor(new Date("2025-04-15T00:00:00Z").getTime() / 1000)}
   * ```
   */
  startTimeSec?: number;
  /**
   * Length of the VOD manifest window in seconds. Controls the `{DURATION}` template parameter
   * and how far forward the user can seek within the manifest before a new one is needed.
   *
   * Default `7200` (2 hours). Only used when `startTimeSec` is set.
   */
  vodDurationSec?: number;
  /**
   * Offset in seconds from `startTimeSec` at which Dash.js should begin playback.
   * For example, if `startTimeSec` points to midnight and `seekOffsetSec` is `300`,
   * playback starts at 00:05:00.
   *
   * Default `0` (start of window). Only used when `startTimeSec` is set.
   */
  seekOffsetSec?: number;
  /**
   * Live buffered DASH quality: adds `_ds` query params so Rhombus can downscale on the server.
   * Default `HIGH` (no extra modifiers). Changing this updates segment URLs without re-fetching the manifest.
   */
  bufferedStreamQuality?: RhombusBufferedStreamQuality;
  /**
   * When `false`, omit `_ds` modifiers. Default `true`.
   * Applies on both WAN and LAN manifests/segments when `true` (Rhombus Console often omits LAN downscale in the UI;
   * use `false` if you want full-resolution LAN only).
   */
  applyBufferedStreamQuality?: boolean;
  /** Extra props passed to the underlying `<video>` element. `controls` overrides the SDK default (controls in VOD). */
  videoProps?: VideoHTMLAttributes<HTMLVideoElement>;
  /** Called when playback is ready (Dash.js initialized and manifest loaded). */
  onReady?: () => void;
};

export type RhombusRealtimeConnectionMode = RhombusConnectionMode;

export type RhombusRealtimePlayerProps = RhombusPlayerBaseProps & {
  /**
   * `wan`: use `wanLiveH264Uri` / `wanLiveH264Uris` from `getMediaUris`.
   * `lan`: use `lanLiveH264Uri` / `lanLiveH264Uris`.
   * Both modes append `x-auth-scheme=federated-token` and `x-auth-ft` on the WebSocket URL (same as DASH segment auth).
   *
   * **Required** on the realtime player (no `wan` default — pick the network explicitly).
   */
  connectionMode: RhombusRealtimeConnectionMode;
  /**
   * Realtime WebSocket resolution: `SD` uses the `/wsl` path; `HD` keeps `/ws`.
   * Changing this reconnects the WebSocket. Default `HD`.
   */
  realtimeStreamQuality?: RhombusRealtimeStreamQuality;
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>;
  /**
   * Called every time the realtime WebSocket transitions to `OPEN` — both on the initial
   * connect and on each successful auto-reconnect. Pair with {@link onRecoveryAttempt} to
   * clear "reconnecting…" UI when the stream recovers.
   */
  onReady?: () => void;
};

/** Imperative handle exposed by {@link RhombusBufferedPlayer} via `ref`. */
export type RhombusBufferedPlayerHandle = {
  /** The underlying `<video>` element, or `null` before mount. */
  getVideoElement: () => HTMLVideoElement | null;
  /** The dash.js `MediaPlayerClass` driving playback, or `null` before init / after teardown. */
  getDashPlayer: () => MediaPlayerClass | null;
};

/** Imperative handle exposed by {@link RhombusRealtimePlayer} via `ref`. */
export type RhombusRealtimePlayerHandle = {
  /** The underlying `<canvas>` element, or `null` before mount. */
  getCanvasElement: () => HTMLCanvasElement | null;
};

/* ------------------------------------------------------------------------------------------ *
 * Unified player (`RhombusPlayer`)
 * ------------------------------------------------------------------------------------------ */

/** Underlying live transport: low-latency WebCodecs canvas, or buffered DASH `<video>`. */
export type RhombusLiveTransport = "realtime" | "buffered";

/**
 * How the video fills its area (mirrors the Rhombus Console video-wall "Video Display" options):
 * - `contain` — **Default Aspect Ratio**: full frame, letter/pillar-boxed (`object-fit: contain`).
 * - `cover` — **Full View Cropped**: fills the box, crops overflow (`object-fit: cover`).
 * - `fill` — **Stretch to Fit**: distorts to fill, no cropping (`object-fit: fill`).
 * - `auto` — **Auto-Size**: the player box takes the video's intrinsic aspect ratio, so there are
 *   no bars and no cropping. In this mode the player sizes by **width** (its height is derived), so
 *   give it a width and don't impose a fixed height.
 */
export type RhombusVideoFit = "contain" | "cover" | "fill" | "auto";

/** Whether the unified player is showing the live edge or past (VOD) footage. */
export type RhombusPlayerMode = "live" | "vod";

/**
 * Built-in controls that {@link RhombusPlayer} can render.
 *
 * Exported both as a **named constant** (enum-style, refactor-safe) and as a **string union**,
 * so either call style works:
 *
 * ```tsx
 * controls={["play", "timeline"]}                                    // plain strings
 * controls={[RhombusPlayerControl.Play, RhombusPlayerControl.Timeline]} // named members
 * ```
 *
 * (A `const` object rather than a TS `enum` so the raw strings stay assignable and there's no
 * runtime `enum` emit.)
 */
export const RhombusPlayerControl = {
  Play: "play",
  GoLive: "goLive",
  Rewind: "rewind",
  Speed: "speed",
  Zoom: "zoom",
  Snapshot: "snapshot",
  SaveClip: "saveClip",
  Timeline: "timeline",
  LiveType: "liveType",
  /** The date/time jump picker ({@link RhombusDateTimePicker} wired to `seekTo`). */
  GoToDate: "goToDate",
  /** The video-display / fit picker (Default Aspect Ratio / Cropped / Stretch / Auto-Size). */
  VideoFit: "videoFit",
} as const;

/** A built-in control identifier — see {@link RhombusPlayerControl}. */
export type RhombusPlayerControl =
  (typeof RhombusPlayerControl)[keyof typeof RhombusPlayerControl];

/** A captured still frame returned by {@link RhombusPlayerHandle.snapshot}. */
export type RhombusSnapshotResult = {
  /** `data:` URL of the captured frame. */
  dataUrl: string;
  /** Frame as a `Blob` (may be `null` if `toBlob` is unavailable). */
  blob: Blob | null;
  /** Wall-clock time (epoch ms) represented by the frame. */
  wallClockMs: number;
  /** Mode the player was in when captured. */
  mode: RhombusPlayerMode;
  width: number;
  height: number;
};

/** A clip time range selected for export. */
export type RhombusClipRange = { startMs: number; endMs: number; cameraUuid: string };

/** Who can see a saved clip (mirrors Rhombus `ClipVisibility`). */
export type RhombusClipVisibility = "ORG_WIDE" | "PRIVATE" | "ROLE_RESTRICTED";

/** Options collected for a clip export (sent to `/video/spliceV3`). */
export type RhombusClipExportOptions = {
  /** Clip title. Falls back to a timestamp-based default when empty. */
  title?: string;
  /** Optional description. */
  description?: string;
  /** Who can see the clip. Default `ORG_WIDE`. */
  visibility?: RhombusClipVisibility;
  /** Persist to Rhombus Console storage. Default `true`. */
  saveToConsole?: boolean;
  /** Include the camera's audio facet. Default `false`. */
  audioIncluded?: boolean;
};

/** Lifecycle phase of a built-in clip export. */
export type RhombusClipExportPhase =
  | "selecting"
  | "submitting"
  | "rendering"
  | "complete"
  | "error"
  | "canceled";

/** Progress/result of a built-in clip export, surfaced via `onClipExport`. */
export type RhombusClipExportStatus = {
  phase: RhombusClipExportPhase;
  clipUuid?: string;
  /** 0–100 while rendering. */
  percentComplete?: number;
  /** Server-reported operation string (e.g. "Processing video"). */
  currentOperation?: string;
  /** Resolved download URL once complete. */
  downloadUrl?: string;
  error?: string;
  /**
   * Machine-readable reason when the footage pre-check blocked the export (`phase: "error"`):
   * `"no-footage"` — zero recorded footage in the range; `"partial-footage"` — the range has
   * gaps and `requireFootage: "full"` is set. Absent on ordinary errors.
   */
  errorCode?: "no-footage" | "partial-footage";
  /**
   * Footage coverage of the export range, when the pre-check ran. Present on the blocking
   * error and carried on subsequent phases of a proceeding export so UIs can warn about
   * partial footage. Absent when the check was off or failed open.
   */
  coverage?: RhombusRangeCoverage;
};

/**
 * Built-in Save Clip configuration. Clip endpoints (`/video/spliceV3` etc.) are **API-key /
 * session authed, not federated-token compatible**, so built-in export requires proxy mode
 * (`apiOverrideBaseUrl` set) where your server attaches the API key. Without a proxy, the
 * player hides the built-in export and only fires `onClipRangeSelect`.
 */
export type RhombusSaveClipConfig = {
  /** Enable built-in export. Default `true` when `apiOverrideBaseUrl` is set, else `false`. */
  enabled?: boolean;
  /** Override the proxy paths. Defaults: splice `/api/save-clip`, progress `/api/clip-progress`, download `/api/clip-download`. */
  paths?: { splice?: string; progress?: string; download?: string };
  /** Default clip title when the user does not provide one. */
  defaultTitle?: string;
  /** Width of the selection seeded when the user enters clip mode, in seconds. Default `60`. */
  defaultDurationSec?: number;
  /** Minimum selectable clip duration in seconds. Default `5`. */
  minDurationSec?: number;
  /** Maximum selectable clip duration in seconds. Default `3600` (server caps at 60 min). */
  maxDurationSec?: number;
  /**
   * Give up polling clip-render progress after this long (ms) and report an error, so the UI
   * doesn't poll forever on a stuck render. Default `300000` (5 min). Set to `0` to never time out.
   */
  progressTimeoutMs?: number;
  /** Default visibility for exported clips. Default `ORG_WIDE`. */
  defaultVisibility?: RhombusClipVisibility;
  /**
   * Show the built-in title/description/visibility form when the user clicks "Save clip".
   * When `false`, "Save clip" exports immediately with defaults. Default `true`.
   */
  showOptionsForm?: boolean;
  /**
   * Footage pre-check policy for exports (Rhombus renders clips over no-footage ranges as
   * "VIDEO NOT AVAILABLE" placeholder frames, so an unchecked export can "succeed" with no
   * real video). Before submitting, the player fetches `/camera/getPresenceWindows` for the
   * selected range:
   * - `"any"` (default) — block only when the range has **zero** recorded footage.
   * - `"full"` — block when the range has **any** confirmed gap.
   * - `"off"` — no pre-check (legacy behavior).
   * The check fails open: if availability can't be fetched (missing proxy route, timeout),
   * the export proceeds ungated. Blocked exports emit `phase: "error"` with `errorCode` and
   * `coverage` set.
   */
  requireFootage?: "any" | "full" | "off";
};

/**
 * A recorded-footage coverage window from `/camera/getPresenceWindows`, normalized to epoch ms.
 * `source: "cloud"` footage is archived and always retrievable; `source: "local"` footage lives
 * on the camera's SD card and is only retrievable while the camera is online/reachable.
 */
export type RhombusFootageWindow = {
  startMs: number;
  endMs: number;
  source: "cloud" | "local";
};

/**
 * Footage coverage for a fetched time range. `fetchedStartMs`/`fetchedEndMs` bound where the
 * answer is known: outside them, availability is **unknown** (not a gap). An empty `windows`
 * array inside the fetched range means confirmed no footage there.
 */
export type RhombusFootageAvailability = {
  windows: RhombusFootageWindow[];
  fetchedStartMs: number;
  fetchedEndMs: number;
};

/** A confirmed no-footage range (the stream would play "VIDEO NOT AVAILABLE" placeholders here). */
export type RhombusFootageGap = { startMs: number; endMs: number };

/**
 * Footage coverage of a specific range (e.g. a clip selection). `coverageRatio` is
 * `coveredMs / totalMs`; `gaps` lists the confirmed no-footage sub-ranges.
 */
export type RhombusRangeCoverage = {
  coveredMs: number;
  totalMs: number;
  coverageRatio: number;
  gaps: RhombusFootageGap[];
};

/** A drawable region on the {@link Timeline}: an event band or an unavailable-footage gap. */
export type TimelineMark = {
  startMs: number;
  endMs: number;
  /** `event` draws a colored band; `gap` greys the availability bar. Default `event`. */
  kind?: "event" | "gap";
  /** CSS color for the band (events only). */
  color?: string;
  label?: string;
};

/** A footage seekpoint returned by `/camera/getFootageSeekpointsV2` (normalized to ms). */
export type RhombusFootageSeekPoint = {
  /** Timestamp in epoch **milliseconds** (the API returns seconds in `ts`). */
  timestampMs: number;
  /** Activity enum string (`a`). */
  activity?: string;
  /** Whether this seekpoint was alerted on (`al`). */
  alerted?: boolean;
  /** Raw server record for advanced consumers. */
  raw: Record<string, unknown>;
};

/**
 * Colors for the canvas-drawn parts of the {@link Timeline} (CSS can't reach canvas pixels).
 * Every field is optional and merged over the SDK defaults; `eventColors` is merged over the
 * built-in per-activity palette. Keys for `eventColors` are activity strings (e.g. `"MOTION"`,
 * `"MOTION_HUMAN"`, `"FACE"`).
 */
export type TimelineColors = {
  /** Canvas fill behind everything. Default transparent (the wrapper background shows through). */
  background?: string;
  /** Recorded-footage portion of the availability bar. */
  availabilityActive?: string;
  /** Empty / future portion of the availability bar. */
  availabilityInactive?: string;
  /**
   * Confirmed no-footage portion of the availability bar (drawn only when `fetchAvailability`
   * has real coverage data for that region).
   */
  availabilityGap?: string;
  /** The playhead line. */
  playhead?: string;
  /** The hover indicator line. */
  hover?: string;
  /** Tick marks. */
  tick?: string;
  /** Tick labels. */
  tickLabel?: string;
  /** Seekpoint color for activities not present in `eventColors`. */
  seekpointDefault?: string;
  /** Seekpoint color for alerted events. */
  seekpointAlert?: string;
  /** Per-activity seekpoint colors, merged over the built-in palette. */
  eventColors?: Record<string, string>;
  /** ‹/›/−/+ button background. */
  buttonBackground?: string;
  /** ‹/›/−/+ button border. */
  buttonBorder?: string;
  /** ‹/›/−/+ button text/glyph. */
  buttonText?: string;
  /** Clip-selection shaded region fill. */
  selection?: string;
  /** Clip-selection drag handles. */
  selectionHandle?: string;
};

export type TimelineProps = RhombusPlayerBaseProps & {
  /** Left edge of the visible time window (epoch ms). */
  rangeStartMs: number;
  /** Right edge of the visible time window (epoch ms). */
  rangeEndMs: number;
  /** Current playhead position (epoch ms); `null`/omitted hides the playhead. */
  currentTimeMs?: number | null;
  /** Called with the wall-clock time when the user clicks/drags to seek. */
  onSeek: (wallClockMs: number) => void;
  /** Called as the pointer hovers the bar (epoch ms), or `null` when it leaves. */
  onHoverTimeChange?: (wallClockMs: number | null) => void;
  /** Clip selection range (epoch ms). When set, draws draggable handles + a shaded region. */
  selection?: { startMs: number; endMs: number } | null;
  /** Called as the user drags the selection handles/body. */
  onSelectionChange?: (selection: { startMs: number; endMs: number }) => void;
  /** Minimum selection duration in ms (drag clamp). Default `5000`. */
  selectionMinDurationMs?: number;
  /** Maximum selection duration in ms (drag clamp). Default `3600000`. */
  selectionMaxDurationMs?: number;
  /** When provided, renders ‹/› chevrons that shift the visible window. `-1` = earlier, `1` = later. */
  onShiftWindow?: (direction: -1 | 1) => void;
  /** Enable/disable the back (‹) chevron. Default `true`. */
  canShiftBack?: boolean;
  /** Enable/disable the forward (›) chevron. Default `true`. */
  canShiftForward?: boolean;
  /**
   * When provided, enables zoom: dedicated −/+ buttons and mouse-wheel zoom (centered on the
   * cursor). `zoomIn` is `true` to narrow the window, `false` to widen it; `centerWallClockMs`
   * is the time to keep centered. Range changes animate.
   */
  onZoom?: (zoomIn: boolean, centerWallClockMs: number) => void;
  /** Enable/disable the zoom-in (+) button. Default `true`. */
  canZoomIn?: boolean;
  /** Enable/disable the zoom-out (−) button. Default `true`. */
  canZoomOut?: boolean;
  /** Fetch event seekpoints for the visible range from `/camera/getFootageSeekpointsV2`. */
  fetchSeekPoints?: boolean;
  /** Include generic motion events in the seekpoint fetch (`includeAnyMotion`). */
  includeAnyMotion?: boolean;
  /**
   * Fetch recorded-footage availability for the visible range from `/camera/getPresenceWindows`
   * and render confirmed no-footage regions on the availability bar in `availabilityGap` color.
   * Default `false` standalone. Requires the `/api/presence-windows` proxy route in proxy mode.
   */
  fetchAvailability?: boolean;
  /** Called with normalized availability whenever an availability fetch completes. */
  onAvailabilityLoaded?: (availability: RhombusFootageAvailability) => void;
  /** Static marks to render in addition to (or instead of) fetched seekpoints. */
  marks?: TimelineMark[];
  /** Called with normalized seekpoints whenever a fetch completes. */
  onSeekPointsLoaded?: (points: RhombusFootageSeekPoint[]) => void;
  /** Override the canvas-drawn colors (background, availability bar, seekpoints, playhead, …). */
  colors?: TimelineColors;
  /** Pixel height of the canvas. Default `56`. */
  height?: number;
};

/** Timeline configuration passed to {@link RhombusPlayer}. */
export type RhombusPlayerTimelineConfig = {
  /**
   * How much time the scrubber spans, in seconds. Default `86400` (a full day, Console-style:
   * the window is aligned to local midnight and the ‹/› chevrons shift it by half a span (±12h)).
   */
  windowSec?: number;
  /** Fetch event seekpoints. Default `true`. */
  fetchSeekPoints?: boolean;
  includeAnyMotion?: boolean;
  /**
   * Fetch recorded-footage availability and render no-footage gaps on the availability bar.
   * Default: enabled when `apiOverrideBaseUrl` is set (proxy mode — the proxy attaches the API
   * key), disabled in direct mode until federated-token auth for `getPresenceWindows` is
   * confirmed for your org. Pass `true`/`false` to override either way.
   */
  fetchAvailability?: boolean;
  /** Called with normalized availability whenever an availability fetch completes. */
  onAvailabilityLoaded?: (availability: RhombusFootageAvailability) => void;
  marks?: TimelineMark[];
  height?: number;
  /** Override the timeline's canvas-drawn colors (seekpoints, availability bar, playhead, …). */
  colors?: TimelineColors;
  /** Called with normalized seekpoints whenever a fetch completes (handy for diagnostics). */
  onSeekPointsLoaded?: (points: RhombusFootageSeekPoint[]) => void;
};

/**
 * Per-slot class names for the built-in control bar. Each is appended to the SDK's own
 * `rhombus-player-*` class on that element, so you can attach utility classes (Tailwind,
 * CSS-modules, etc.) without fighting the defaults. (The defaults themselves are shipped as a
 * zero-specificity `:where()` stylesheet, so plain CSS targeting the `rhombus-player-*` classes
 * also overrides them with no `!important`.)
 */
export type RhombusPlayerClassNames = {
  /** The control bar container (`rhombus-player-controls`). */
  controls?: string;
  /** Every button (`rhombus-player-btn`). */
  button?: string;
  /** The playback-speed `<select>` (`rhombus-player-speed`). */
  speed?: string;
  /** The live-type / quality switcher group (`rhombus-player-livetype`). */
  liveType?: string;
  /** The save-clip group (`rhombus-player-clip`). */
  clip?: string;
  /** The clip export status text (`rhombus-player-clip-status`). */
  clipStatus?: string;
  /** The timeline wrapper (`rhombus-player-timeline`). */
  timeline?: string;
};

/** Live, observable state of {@link RhombusPlayer}, passed to `renderControls` and `getState`. */
export type RhombusPlayerState = {
  /** The camera being played. */
  cameraUuid: string;
  mode: RhombusPlayerMode;
  /** Resolved transport (realtime may have fallen back to buffered). */
  liveTransport: RhombusLiveTransport;
  playing: boolean;
  playbackRate: number;
  /** Best-effort current wall-clock (epoch ms); approx `Date.now()` while live. */
  currentWallClockMs: number | null;
  zoom: number;
  isAtLiveEdge: boolean;
  /** Whether built-in clip export is available (proxy mode + enabled). */
  canSaveClip: boolean;
  /** The current clip selection (when the user is in clip mode), else `null`. */
  clipSelection: { startMs: number; endMs: number } | null;
  /**
   * Footage coverage of the current clip selection, computed from timeline-fetched
   * availability. `null`/absent when unknown (no selection, availability not fetched, or the
   * selection extends outside the fetched range) — unknown must not be treated as "no footage".
   */
  clipSelectionCoverage?: RhombusRangeCoverage | null;
  /** Current clip export status, if one is in progress or finished. */
  clipExport?: RhombusClipExportStatus;
};

/** Imperative handle exposed by {@link RhombusPlayer} via `ref`. */
export type RhombusPlayerHandle = {
  play: () => void;
  pause: () => void;
  goLive: () => void;
  /** Seek to an absolute wall-clock time (epoch ms); auto-switches live ⇄ vod. */
  seekTo: (wallClockMs: number) => void;
  rewind: (seconds?: number) => void;
  /** Set playback speed (VOD only; ignored while live). */
  setPlaybackRate: (rate: number) => void;
  zoomIn: (step?: number) => void;
  zoomOut: (step?: number) => void;
  setZoom: (zoom: number, panX?: number, panY?: number) => void;
  resetZoom: () => void;
  snapshot: () => Promise<RhombusSnapshotResult>;
  /** Switch the live transport (realtime ⇄ buffered); clamps to buffered without WebCodecs. */
  setLiveTransport: (transport: RhombusLiveTransport) => void;
  /** Start a built-in clip export for the given range (or the currently selected range). */
  startClipExport: (
    range?: RhombusClipRange,
    options?: RhombusClipExportOptions
  ) => Promise<RhombusClipExportStatus>;
  getState: () => RhombusPlayerState;
};

export type RhombusPlayerProps = RhombusPlayerBaseProps & {
  /**
   * Live transport. **Controllable**: seeds the value; the built-in switcher / `ref` update it
   * internally, but if you pass it (and update it from `onTransportChange`) it becomes controlled.
   * Default `realtime` (auto-falls back to `buffered` without WebCodecs).
   */
  liveTransport?: RhombusLiveTransport;
  /**
   * Play/pause. **Controllable**: omit for uncontrolled (internal, starts playing); pass a boolean
   * (and update it from `onPlayingChange`) to control it. `false` in live freezes to a VOD frame.
   */
  playing?: boolean;
  /**
   * Playback speed (VOD only; ignored while live). **Controllable** — pair with `onPlaybackRateChange`.
   */
  playbackRate?: number;
  /**
   * Digital zoom level (1–4). **Controllable** — pair with `onZoomChange`. Out-of-range values clamp.
   */
  zoom?: number;
  /**
   * Controlled playhead, epoch ms. Honored when its value **changes** (the player seeks there and
   * derives live/vod: within `liveEdgeToleranceSec` of now ⇒ live in the current transport, else
   * VOD). The player still advances on its own — mirror `onProgress`/`onSeek` for two-way binding.
   * There is no `mode` prop; mode is derived from `positionMs` vs now.
   */
  positionMs?: number;
  /**
   * How the video fills its area. Default `"auto"` (the player box takes the video's aspect ratio,
   * so there are no bars). See {@link RhombusVideoFit}. Acts as the initial value: the built-in
   * `"videoFit"` control updates it internally; pass it as a controlled value (updating it from
   * `onVideoFitChange`) to drive it externally.
   */
  videoFit?: RhombusVideoFit;
  /** Show the manual Live-type + quality switcher UI (Console-style). Default `false`. */
  showLiveTypeSwitcher?: boolean;
  /** Realtime live quality (used when the resolved transport is realtime). */
  realtimeStreamQuality?: RhombusRealtimeStreamQuality;
  /** Buffered (DASH) live + VOD quality. */
  bufferedStreamQuality?: RhombusBufferedStreamQuality;
  applyBufferedStreamQuality?: boolean;
  /** Start in live (default) or jump straight into past footage. */
  initialMode?: RhombusPlayerMode;
  /** Wall-clock anchor (epoch ms) used when `initialMode === "vod"`. */
  initialStartTimeMs?: number;
  /** VOD manifest window length the SDK requests, in seconds. Default `7200`. */
  vodWindowSec?: number;
  /** Default rewind step in seconds. Default `15`. */
  defaultRewindSec?: number;
  /** A seek within this many seconds of now is treated as live. Default `5`. */
  liveEdgeToleranceSec?: number;
  /** Auto-return to live when VOD playback catches up to the live edge. Default `false`. */
  autoGoLiveAtEdge?: boolean;
  /** Which built-in controls to render. Omit ⇒ all; `[]` ⇒ headless (drive via `ref`). */
  controls?: RhombusPlayerControl[];
  /** Per-slot class names appended to the built-in control bar's elements. */
  classNames?: RhombusPlayerClassNames;
  /** Fully replace the control bar while keeping the imperative API. */
  renderControls?: (api: RhombusPlayerHandle, state: RhombusPlayerState) => ReactNode;
  /** Built-in Save Clip configuration. */
  saveClip?: RhombusSaveClipConfig;
  /** Timeline/scrubber configuration. */
  timeline?: RhombusPlayerTimelineConfig;
  /** Called when the first underlying transport becomes ready. */
  onReady?: () => void;
  onModeChange?: (mode: RhombusPlayerMode, atWallClockMs: number) => void;
  onTransportChange?: (transport: RhombusLiveTransport) => void;
  onSeek?: (wallClockMs: number, mode: RhombusPlayerMode) => void;
  /** Throttled playback progress (~4Hz). Use to mirror playback into a controlled `positionMs`. */
  onProgress?: (wallClockMs: number, mode: RhombusPlayerMode) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** Fired when the playback speed changes (built-in control, `ref`, or settling). */
  onPlaybackRateChange?: (rate: number) => void;
  onSnapshot?: (result: RhombusSnapshotResult) => void;
  onZoomChange?: (zoom: number, panX: number, panY: number) => void;
  /** Fired when the built-in video-display control changes the fit. */
  onVideoFitChange?: (fit: RhombusVideoFit) => void;
  /** Fired whenever the user selects a clip range (regardless of built-in export). */
  onClipRangeSelect?: (range: RhombusClipRange) => void;
  /** Built-in clip export progress/result. */
  onClipExport?: (status: RhombusClipExportStatus) => void;
};
