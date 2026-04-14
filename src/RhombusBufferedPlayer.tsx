import { useEffect, useRef } from "react";
import type { ErrorEvent as DashJSErrorEvent, MediaPlayerClass } from "dashjs";
import type { FederatedTokenFetchResult, RhombusDashPlayerCallbacks } from "./rhombusPlayback.js";
import {
  createRhombusDashPlayer,
  DEFAULT_RHOMBUS_API_BASE_URL,
  destroyRhombusDashPlayer,
  fetchFederatedSessionToken,
  fetchLiveMpdUriDirect,
  fetchLiveMpdUriViaOverride,
  getBrowserOrigin,
  getFederatedTokenRefreshDelayMs,
  mergeRequestHeaders,
} from "./rhombusPlayback.js";
import type { RhombusBufferedStreamQuality, RhombusBufferedPlayerProps } from "./types.js";
import { joinUrl } from "./urlAuth.js";

const DEFAULT_FEDERATED_PATH = "/api/federated-token";
const DEFAULT_MEDIA_PATH_OVERRIDE = "/api/media-uris";
const DEFAULT_MEDIA_PATH_DIRECT = "/camera/getMediaUris";

export function RhombusBufferedPlayer({
  cameraUuid,
  connectionMode,
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
  const tokenRef = useRef("");
  const durationSecRef = useRef(tokenDurationSec);
  durationSecRef.current = tokenDurationSec;

  const sdkRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSdkTokenRefreshRef = useRef<
    (last: FederatedTokenFetchResult, fetchedAtMs: number, durationUsedSec: number) => void
  >(() => {});

  const dashPlayerCallbacksRef = useRef<RhombusDashPlayerCallbacks | null>(null);
  if (dashPlayerCallbacksRef.current === null) {
    dashPlayerCallbacksRef.current = {
      getBufferedStreamQuality: () => bufferedQRef.current,
      getApplyBufferedStreamQuality: () => applyBQRef.current,
      getFederatedSessionToken: () => tokenRef.current,
    };
  }

  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  headersRef.current = headers;
  getRequestHeadersRef.current = getRequestHeaders;

  bufferedQRef.current = bufferedStreamQuality ?? "HIGH";
  applyBQRef.current = applyBufferedStreamQuality !== false;
  const effectiveConnectionMode = connectionMode ?? "wan";

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

  const sdkManagedFederatedToken = federatedSessionToken === undefined;
  const federatedTokenModeKey =
    federatedSessionToken === undefined ? "__sdk_managed__" : "__external__";

  function clearSdkRefreshTimer() {
    if (sdkRefreshTimerRef.current != null) {
      clearTimeout(sdkRefreshTimerRef.current);
      sdkRefreshTimerRef.current = null;
    }
  }

  useEffect(() => {
    if (federatedSessionToken === undefined) return;
    if (typeof federatedSessionToken === "string" && federatedSessionToken) {
      tokenRef.current = federatedSessionToken;
    }
  }, [federatedSessionToken]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let effectCancelled = false;
    let player: MediaPlayerClass | null = null;

    const handleDashError = (e: DashJSErrorEvent) => {
      const payload = "error" in e ? e.error : undefined;
      const message =
        payload != null && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: unknown }).message)
          : `Dash.js error (${e.type})`;
      onErrorRef.current?.(new Error(message));
    };

    const scheduleSdkTokenRefresh = (
      lastResult: FederatedTokenFetchResult,
      fetchedAtMs: number,
      durationUsedSec: number
    ) => {
      clearSdkRefreshTimer();
      const delayMs = getFederatedTokenRefreshDelayMs({
        requestedDurationSec: durationUsedSec,
        fetchedAtMs,
        expiryHint: lastResult,
      });
      sdkRefreshTimerRef.current = setTimeout(() => {
        void (async () => {
          if (effectCancelled) return;
          try {
            const requestHeaders = await mergeRequestHeaders(
              headersRef.current,
              getRequestHeadersRef.current
            );
            const tokenUrl = useDirectRhombusApi
              ? joinUrl(getBrowserOrigin(), federatedPath)
              : joinUrl(overrideBase!, federatedPath);
            const next = await fetchFederatedSessionToken(
              tokenUrl,
              requestHeaders,
              durationSecRef.current,
              usedDefaultFederatedPath
            );
            if (effectCancelled) return;
            tokenRef.current = next.federatedSessionToken;
            const at = Date.now();
            const durUsed = durationSecRef.current;
            scheduleSdkTokenRefresh(next, at, durUsed);
          } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            onErrorRef.current?.(err);
          }
        })();
      }, delayMs);
    };

    scheduleSdkTokenRefreshRef.current = scheduleSdkTokenRefresh;

    (async () => {
      try {
        const requestHeaders = await mergeRequestHeaders(
          headersRef.current,
          getRequestHeadersRef.current
        );

        let initialTokenResult: FederatedTokenFetchResult | null = null;
        if (sdkManagedFederatedToken) {
          const tokenUrl = useDirectRhombusApi
            ? joinUrl(getBrowserOrigin(), federatedPath)
            : joinUrl(overrideBase!, federatedPath);
          initialTokenResult = await fetchFederatedSessionToken(
            tokenUrl,
            requestHeaders,
            durationSecRef.current,
            usedDefaultFederatedPath
          );
          if (effectCancelled) return;
          tokenRef.current = initialTokenResult.federatedSessionToken;
        } else {
          if (!federatedSessionToken) {
            throw new Error("federatedSessionToken must be a non-empty string");
          }
          tokenRef.current = federatedSessionToken;
        }

        let manifestUri: string;
        if (useDirectRhombusApi) {
          manifestUri = await fetchLiveMpdUriDirect(
            resolvedRhombusBase,
            mediaPath,
            tokenRef.current,
            cameraUuid,
            effectiveConnectionMode
          );
        } else {
          manifestUri = await fetchLiveMpdUriViaOverride(
            joinUrl(overrideBase!, mediaPath),
            requestHeaders,
            cameraUuid,
            usedDefaultMediaPath,
            effectiveConnectionMode
          );
        }

        if (effectCancelled) return;

        const el = videoRef.current;
        if (!el) return;

        player = createRhombusDashPlayer(
          el,
          manifestUri,
          handleDashError,
          dashPlayerCallbacksRef.current!
        );
        playerRef.current = player;

        if (sdkManagedFederatedToken && initialTokenResult !== null) {
          scheduleSdkTokenRefresh(initialTokenResult, Date.now(), durationSecRef.current);
        }

        onReadyRef.current?.();
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        onErrorRef.current?.(err);
      }
    })();

    return () => {
      effectCancelled = true;
      clearSdkRefreshTimer();
      scheduleSdkTokenRefreshRef.current = () => {};
      if (player) {
        destroyRhombusDashPlayer(player, handleDashError);
      }
      playerRef.current = null;
    };
  }, [
    federatedTokenModeKey,
    cameraUuid,
    effectiveConnectionMode,
    overrideBase,
    federatedPath,
    mediaPath,
    resolvedRhombusBase,
    useDirectRhombusApi,
    usedDefaultFederatedPath,
    usedDefaultMediaPath,
  ]);

  useEffect(() => {
    if (!sdkManagedFederatedToken) return;
    if (!playerRef.current) return;

    let cancelled = false;
    void (async () => {
      try {
        clearSdkRefreshTimer();
        const requestHeaders = await mergeRequestHeaders(
          headersRef.current,
          getRequestHeadersRef.current
        );
        const tokenUrl = useDirectRhombusApi
          ? joinUrl(getBrowserOrigin(), federatedPath)
          : joinUrl(overrideBase!, federatedPath);
        const next = await fetchFederatedSessionToken(
          tokenUrl,
          requestHeaders,
          tokenDurationSec,
          usedDefaultFederatedPath
        );
        if (cancelled || !playerRef.current) return;
        tokenRef.current = next.federatedSessionToken;
        scheduleSdkTokenRefreshRef.current(next, Date.now(), tokenDurationSec);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        onErrorRef.current?.(err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    tokenDurationSec,
    sdkManagedFederatedToken,
    useDirectRhombusApi,
    overrideBase,
    federatedPath,
    usedDefaultFederatedPath,
  ]);

  useEffect(() => {
    const player = playerRef.current;
    const vid = videoRef.current;
    if (!isRhombusSafariDash() || !player || !vid) {
      return;
    }
    try {
      if (player.isReady()) {
        player.pause();
        player.attachView(vid);
        player.play();
      }
    } catch {
      /* ignore */
    }
  }, [effectiveBufferedQuality, effectiveApplyBuffered, effectiveConnectionMode]);

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
