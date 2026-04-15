import type { CanvasHTMLAttributes, CSSProperties, VideoHTMLAttributes } from "react";

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
};

export type RhombusBufferedPlayerProps = {
  /** Camera UUID from Rhombus (safe to use in the browser). */
  cameraUuid: string;
  /**
   * `wan`: use `wanLiveMpdUri` from `getMediaUris`.
   * `lan`: use `lanLiveMpdUris` (or `lanLiveMpdUri` if present). First entry wins; same idea as realtime LAN.
   * Default `wan`. Changing mode re-initializes Dash.js.
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
   * Only used for the media-URIs request when `apiOverrideBaseUrl` is omitted.
   */
  rhombusApiBaseUrl?: string;
  /** Path segments for token and media endpoints. Defaults match player-example or Rhombus paths by mode. */
  paths?: RhombusPlayerPaths;
  /**
   * When set, this token is used for media requests and the SDK does not call the federated-token endpoint.
   * Must be non-empty. Updates apply without tearing down Dash.js (segment URLs read the latest token).
   * You are responsible for minting and refreshing the token; when it changes, realtime WebSocket reconnects.
   */
  federatedSessionToken?: string;
  /**
   * Federated token duration in seconds (sent to your token endpoint when the SDK fetches or re-fetches the token).
   * Default: 86400 (24h). Ignored when `federatedSessionToken` is provided.
   * Changing this re-mints with the new duration without resetting the DASH player (SDK-managed mode only).
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
  /** Extra props passed to the underlying `<video>` element. */
  videoProps?: VideoHTMLAttributes<HTMLVideoElement>;
  className?: string;
  style?: CSSProperties;
  /** Called when playback is ready (Dash.js initialized and manifest loaded). */
  onReady?: () => void;
  /** Called when token fetch, media URI fetch, or player setup fails. */
  onError?: (error: Error) => void;
};

export type RhombusRealtimeConnectionMode = RhombusConnectionMode;

export type RhombusRealtimePlayerProps = {
  cameraUuid: string;
  /**
   * `wan`: use `wanLiveH264Uri` / `wanLiveH264Uris` from `getMediaUris`.
   * `lan`: use `lanLiveH264Uri` / `lanLiveH264Uris`.
   * Both modes append `x-auth-scheme=federated-token` and `x-auth-ft` on the WebSocket URL (same as DASH segment auth).
   */
  connectionMode: RhombusRealtimeConnectionMode;
  apiOverrideBaseUrl?: string;
  rhombusApiBaseUrl?: string;
  paths?: RhombusPlayerPaths;
  /**
   * When set, skips the token `fetch`. Rotate by passing a new string; realtime reconnects, DASH does not remount.
   */
  federatedSessionToken?: string;
  /**
   * Same as buffered player: SDK-managed token TTL and refresh schedule. Ignored when `federatedSessionToken` is set.
   */
  tokenDurationSec?: number;
  headers?: HeadersInit;
  getRequestHeaders?: () => HeadersInit | Promise<HeadersInit>;
  /**
   * Realtime WebSocket resolution: `SD` uses the `/wsl` path; `HD` keeps `/ws`.
   * Changing this reconnects the WebSocket. Default `HD`.
   */
  realtimeStreamQuality?: RhombusRealtimeStreamQuality;
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>;
  className?: string;
  style?: CSSProperties;
  onReady?: () => void;
  onError?: (error: Error) => void;
};
