import type { CanvasHTMLAttributes, CSSProperties, VideoHTMLAttributes } from "react";

/** Live buffered DASH: server downscale via `_ds` on segment URLs (Rhombus Console `BufferedResolutionQuality`). */
export type RhombusBufferedStreamQuality = "HIGH" | "MEDIUM" | "LOW";

/** Live realtime WebSocket: SD uses `/wsl` instead of `/ws` (Rhombus Console `RealtimeResolutionQuality`). */
export type RhombusRealtimeStreamQuality = "HD" | "SD";

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
   * Must be non-empty. When the value changes, media URIs are re-fetched and the player is re-created.
   */
  federatedSessionToken?: string;
  /**
   * Federated token duration in seconds (sent to your token endpoint only when the SDK fetches the token).
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
   * Live buffered DASH quality: adds `_ds` query params so Rhombus can downscale on the server.
   * Default `HIGH` (no extra modifiers). Changing this updates segment URLs without re-fetching the manifest.
   */
  bufferedStreamQuality?: RhombusBufferedStreamQuality;
  /**
   * When `false`, omit `_ds` modifiers (e.g. LAN or when server downscale should not be requested).
   * Default `true`.
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

export type RhombusRealtimeConnectionMode = "wan" | "lan";

export type RhombusRealtimePlayerProps = {
  cameraUuid: string;
  /**
   * `wan`: use `wanLiveH264Uris` and append `x-auth-scheme=federated-token` + `x-auth-ft` on the WebSocket URL.
   * `lan`: use `lanLiveH264Uris` without those query params; set an auth cookie when {@link applyLanAuthCookie} is true.
   */
  connectionMode: RhombusRealtimeConnectionMode;
  apiOverrideBaseUrl?: string;
  rhombusApiBaseUrl?: string;
  paths?: RhombusPlayerPaths;
  federatedSessionToken?: string;
  tokenDurationSec?: number;
  headers?: HeadersInit;
  getRequestHeaders?: () => HeadersInit | Promise<HeadersInit>;
  /**
   * Realtime WebSocket resolution: `SD` uses the `/wsl` path; `HD` keeps `/ws`.
   * Changing this reconnects the WebSocket. Default `HD`.
   */
  realtimeStreamQuality?: RhombusRealtimeStreamQuality;
  /**
   * When true (default), LAN mode calls `setRhombusLanAuthCookie` before opening the WebSocket.
   * Disable if your app sets the cookie elsewhere or uses a same-origin proxy.
   */
  applyLanAuthCookie?: boolean;
  /** Cookie name for LAN auth. Default `RFT`. */
  lanAuthCookieName?: string;
  lanAuthCookieDomain?: string;
  lanAuthCookiePath?: string;
  lanAuthCookieSecure?: boolean;
  lanAuthCookieMaxAgeSec?: number;
  lanAuthCookieSameSite?: "strict" | "lax" | "none";
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>;
  className?: string;
  style?: CSSProperties;
  onReady?: () => void;
  onError?: (error: Error) => void;
};
