import type { CSSProperties, VideoHTMLAttributes } from "react";

export type RhombusPlayerPaths = {
  /** POST path for federated session token (appended to `proxyBaseUrl`). Default: `/api/federated-token` */
  federatedToken?: string;
  /** POST path for media URIs (appended to `proxyBaseUrl`). Default: `/api/media-uris` */
  mediaUris?: string;
};

export type RhombusPlayerProps = {
  /** Camera UUID from Rhombus (safe to use in the browser). */
  cameraUuid: string;
  /** Base URL of your backend proxy (no trailing slash required). */
  proxyBaseUrl: string;
  /** Path segments for proxy endpoints. Defaults match the Rhombus player-example proxy. */
  paths?: RhombusPlayerPaths;
  /** Federated token duration in seconds. Default: 86400 (24h). */
  tokenDurationSec?: number;
  /** Static headers for proxy `fetch` calls. */
  headers?: HeadersInit;
  /** Async headers for proxy `fetch` calls (merged after `headers` if both are set). */
  getRequestHeaders?: () => HeadersInit | Promise<HeadersInit>;
  /** Extra props passed to the underlying `<video>` element. */
  videoProps?: VideoHTMLAttributes<HTMLVideoElement>;
  className?: string;
  style?: CSSProperties;
  /** Called when playback is ready (Dash.js initialized and manifest loaded). */
  onReady?: () => void;
  /** Called when token fetch, media URI fetch, or player setup fails. */
  onError?: (error: Error) => void;
};
