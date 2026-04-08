import { useEffect, useRef } from "react";
import type { ErrorEvent as DashJSErrorEvent, MediaPlayerClass } from "dashjs";
import type { RhombusDashQualityCallbacks } from "./rhombusPlayback.js";
import {
  createRhombusDashPlayer,
  DEFAULT_RHOMBUS_API_BASE_URL,
  destroyRhombusDashPlayer,
  fetchFederatedSessionToken,
  fetchWanLiveMpdUriDirect,
  fetchWanLiveMpdUriViaOverride,
  getBrowserOrigin,
  mergeRequestHeaders,
} from "./rhombusPlayback.js";
import type { RhombusBufferedStreamQuality, RhombusBufferedPlayerProps } from "./types.js";
import { joinUrl } from "./urlAuth.js";

const DEFAULT_FEDERATED_PATH = "/api/federated-token";
const DEFAULT_MEDIA_PATH_OVERRIDE = "/api/media-uris";
const DEFAULT_MEDIA_PATH_DIRECT = "/camera/getMediaUris";

export function RhombusBufferedPlayer({
  cameraUuid,
  apiOverrideBaseUrl,
  rhombusApiBaseUrl,
  paths,
  federatedSessionToken,
  tokenDurationSec = 86_400,
  headers,
  getRequestHeaders,
  videoProps,
  className,
  style,
  bufferedStreamQuality,
  applyBufferedStreamQuality,
  onReady,
  onError,
}: RhombusBufferedPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<MediaPlayerClass | null>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const headersRef = useRef(headers);
  const getRequestHeadersRef = useRef(getRequestHeaders);

  const bufferedQRef = useRef<RhombusBufferedStreamQuality>("HIGH");
  const applyBQRef = useRef(true);
  const dashQualityCallbacksRef = useRef<RhombusDashQualityCallbacks>({
    getBufferedStreamQuality: () => bufferedQRef.current,
    getApplyBufferedStreamQuality: () => applyBQRef.current,
  });

  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  headersRef.current = headers;
  getRequestHeadersRef.current = getRequestHeaders;

  bufferedQRef.current = bufferedStreamQuality ?? "HIGH";
  applyBQRef.current = applyBufferedStreamQuality !== false;

  const effectiveBufferedQuality = bufferedStreamQuality ?? "HIGH";
  const effectiveApplyBuffered = applyBufferedStreamQuality !== false;

  const overrideBase = apiOverrideBaseUrl?.trim() || undefined;
  const useDirectRhombusApi = overrideBase === undefined;
  const federatedPath = paths?.federatedToken ?? DEFAULT_FEDERATED_PATH;
  const mediaPath = useDirectRhombusApi
    ? paths?.mediaUris ?? DEFAULT_MEDIA_PATH_DIRECT
    : paths?.mediaUris ?? DEFAULT_MEDIA_PATH_OVERRIDE;
  const usedDefaultFederatedPath = paths?.federatedToken === undefined;
  const usedDefaultMediaPath = paths?.mediaUris === undefined;
  const resolvedRhombusBase =
    rhombusApiBaseUrl?.trim() || DEFAULT_RHOMBUS_API_BASE_URL;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let player: MediaPlayerClass | null = null;

    const handleDashError = (e: DashJSErrorEvent) => {
      const payload = "error" in e ? e.error : undefined;
      const message =
        payload != null && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: unknown }).message)
          : `Dash.js error (${e.type})`;
      onErrorRef.current?.(new Error(message));
    };

    (async () => {
      try {
        const requestHeaders = await mergeRequestHeaders(
          headersRef.current,
          getRequestHeadersRef.current
        );

        let resolvedToken: string;
        if (federatedSessionToken !== undefined) {
          if (!federatedSessionToken) {
            throw new Error("federatedSessionToken must be a non-empty string");
          }
          resolvedToken = federatedSessionToken;
        } else {
          const tokenUrl = useDirectRhombusApi
            ? joinUrl(getBrowserOrigin(), federatedPath)
            : joinUrl(overrideBase!, federatedPath);
          resolvedToken = await fetchFederatedSessionToken(
            tokenUrl,
            requestHeaders,
            tokenDurationSec,
            usedDefaultFederatedPath
          );
        }

        let wanLiveMpdUri: string;
        if (useDirectRhombusApi) {
          wanLiveMpdUri = await fetchWanLiveMpdUriDirect(
            resolvedRhombusBase,
            mediaPath,
            resolvedToken,
            cameraUuid
          );
        } else {
          wanLiveMpdUri = await fetchWanLiveMpdUriViaOverride(
            joinUrl(overrideBase!, mediaPath),
            requestHeaders,
            cameraUuid,
            usedDefaultMediaPath
          );
        }

        if (cancelled) return;

        const el = videoRef.current;
        if (!el) return;

        player = createRhombusDashPlayer(
          el,
          wanLiveMpdUri,
          resolvedToken,
          handleDashError,
          dashQualityCallbacksRef.current
        );
        playerRef.current = player;

        onReadyRef.current?.();
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        onErrorRef.current?.(err);
      }
    })();

    return () => {
      cancelled = true;
      if (player) {
        destroyRhombusDashPlayer(player, handleDashError);
      }
      playerRef.current = null;
    };
  }, [
    cameraUuid,
    overrideBase,
    federatedPath,
    mediaPath,
    resolvedRhombusBase,
    tokenDurationSec,
    federatedSessionToken,
  ]);

  useEffect(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (!isRhombusSafariDash() || !player || !video) {
      return;
    }
    try {
      if (player.isReady()) {
        player.pause();
        player.attachView(video);
        player.play();
      }
    } catch {
      /* ignore */
    }
  }, [effectiveBufferedQuality, effectiveApplyBuffered]);

  return (
    <video
      ref={videoRef}
      className={className}
      style={style}
      playsInline
      controls
      muted
      {...videoProps}
    />
  );
}

function isRhombusSafariDash(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return !!(
    ua &&
    (/\b(iPad|iPhone|iPod)\b/.test(ua) ||
      (!!/Safari/.exec(ua) && !/Chrome/.exec(ua)))
  );
}
