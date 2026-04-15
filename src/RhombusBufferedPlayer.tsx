import { useEffect, useRef } from "react";
import {
  MediaPlayer,
  type ErrorEvent as DashJSErrorEvent,
  type MediaPlayerClass,
} from "dashjs";
import type { FederatedTokenFetchResult, RhombusDashPlayerCallbacks } from "./rhombusPlayback.js";
import {
  createRhombusDashPlayer,
  createRhombusVodDashPlayer,
  DEFAULT_RHOMBUS_API_BASE_URL,
  destroyRhombusDashPlayer,
  fetchFederatedSessionToken,
  fetchLiveMpdUriDirect,
  fetchLiveMpdUriViaOverride,
  fetchVodMpdUriDirect,
  fetchVodMpdUriViaOverride,
  getBrowserOrigin,
  getDashErrorMessage,
  getFederatedTokenRefreshDelayMs,
  isRecoverableDashError,
  mergeRequestHeaders,
} from "./rhombusPlayback.js";
import type { RhombusBufferedStreamQuality, RhombusBufferedPlayerProps } from "./types.js";
import { joinUrl } from "./urlAuth.js";

const DEFAULT_FEDERATED_PATH = "/api/federated-token";
const DEFAULT_MEDIA_PATH_OVERRIDE = "/api/media-uris";
const DEFAULT_MEDIA_PATH_DIRECT = "/camera/getMediaUris";

const DEFAULT_VOD_DURATION_SEC = 7200;

const DEFAULT_MAX_RETRY_INTERVAL_MS = 30_000;
const INITIAL_RECOVERY_DELAY_MS = 2_000;
const HEALTHY_PLAYBACK_RESET_MS = 30_000;

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
  startTimeSec,
  vodDurationSec = DEFAULT_VOD_DURATION_SEC,
  seekOffsetSec = 0,
  maxRetryIntervalMs = DEFAULT_MAX_RETRY_INTERVAL_MS,
  onRecoveryAttempt,
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
  const onRecoveryAttemptRef = useRef(onRecoveryAttempt);
  const headersRef = useRef(headers);
  const getRequestHeadersRef = useRef(getRequestHeaders);

  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryAttemptRef = useRef(0);
  const recoveryDelayRef = useRef(INITIAL_RECOVERY_DELAY_MS);
  const maxRetryIntervalMsRef = useRef(maxRetryIntervalMs);
  maxRetryIntervalMsRef.current = maxRetryIntervalMs;

  const healthyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  onRecoveryAttemptRef.current = onRecoveryAttempt;
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

  const isVod = startTimeSec != null;

  const sdkManagedFederatedToken = federatedSessionToken === undefined;
  const federatedTokenModeKey =
    federatedSessionToken === undefined ? "__sdk_managed__" : "__external__";

  function clearSdkRefreshTimer() {
    if (sdkRefreshTimerRef.current != null) {
      clearTimeout(sdkRefreshTimerRef.current);
      sdkRefreshTimerRef.current = null;
    }
  }

  function clearRecoveryTimer() {
    if (recoveryTimerRef.current != null) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }

  function clearHealthyTimer() {
    if (healthyTimerRef.current != null) {
      clearTimeout(healthyTimerRef.current);
      healthyTimerRef.current = null;
    }
  }

  function resetRecoveryBackoff() {
    recoveryAttemptRef.current = 0;
    recoveryDelayRef.current = INITIAL_RECOVERY_DELAY_MS;
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
    let handleDashError: (e: DashJSErrorEvent) => void;
    let handleBufferLoaded: () => void;

    const autoRecoveryEnabled = maxRetryIntervalMs > 0;

    function startHealthyPlaybackTimer() {
      clearHealthyTimer();
      healthyTimerRef.current = setTimeout(() => {
        if (!effectCancelled) {
          resetRecoveryBackoff();
        }
      }, HEALTHY_PLAYBACK_RESET_MS);
    }

    async function buildPlayer(): Promise<MediaPlayerClass | null> {
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
        if (effectCancelled) return null;
        tokenRef.current = initialTokenResult.federatedSessionToken;
      } else {
        if (!federatedSessionToken) {
          throw new Error("federatedSessionToken must be a non-empty string");
        }
        tokenRef.current = federatedSessionToken;
      }

      let manifestUri: string;
      if (isVod) {
        if (useDirectRhombusApi) {
          manifestUri = await fetchVodMpdUriDirect(
            resolvedRhombusBase,
            mediaPath,
            tokenRef.current,
            cameraUuid,
            effectiveConnectionMode,
            startTimeSec,
            vodDurationSec
          );
        } else {
          manifestUri = await fetchVodMpdUriViaOverride(
            joinUrl(overrideBase!, mediaPath),
            requestHeaders,
            cameraUuid,
            usedDefaultMediaPath,
            effectiveConnectionMode,
            startTimeSec,
            vodDurationSec
          );
        }
      } else {
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
      }

      if (effectCancelled) return null;

      const el = videoRef.current;
      if (!el) return null;

      const newPlayer = isVod
        ? createRhombusVodDashPlayer(
            el,
            manifestUri,
            seekOffsetSec,
            handleDashError,
            dashPlayerCallbacksRef.current!
          )
        : createRhombusDashPlayer(
            el,
            manifestUri,
            handleDashError,
            dashPlayerCallbacksRef.current!
          );

      newPlayer.on(MediaPlayer.events.BUFFER_LOADED, handleBufferLoaded, undefined);

      if (sdkManagedFederatedToken && initialTokenResult !== null) {
        scheduleSdkTokenRefresh(initialTokenResult, Date.now(), durationSecRef.current);
      }

      return newPlayer;
    }

    function scheduleRecovery() {
      clearRecoveryTimer();
      const delay = recoveryDelayRef.current;
      recoveryDelayRef.current = Math.min(
        delay * 2,
        maxRetryIntervalMsRef.current
      );

      recoveryTimerRef.current = setTimeout(() => {
        if (effectCancelled) return;
        void (async () => {
          try {
            if (player) {
              player.off(MediaPlayer.events.BUFFER_LOADED, handleBufferLoaded, undefined);
              destroyRhombusDashPlayer(player, handleDashError);
              player = null;
              playerRef.current = null;
            }

            const newPlayer = await buildPlayer();
            if (effectCancelled || !newPlayer) return;

            player = newPlayer;
            playerRef.current = newPlayer;
            onReadyRef.current?.();
          } catch (e: unknown) {
            if (effectCancelled) return;
            const err = e instanceof Error ? e : new Error(String(e));
            onErrorRef.current?.(err);
            if (autoRecoveryEnabled) {
              recoveryAttemptRef.current++;
              onRecoveryAttemptRef.current?.(recoveryAttemptRef.current, err);
              scheduleRecovery();
            }
          }
        })();
      }, delay);
    }

    handleDashError = (e: DashJSErrorEvent) => {
      const message = getDashErrorMessage(e);
      const error = new Error(message);
      onErrorRef.current?.(error);

      if (autoRecoveryEnabled && isRecoverableDashError(e)) {
        clearHealthyTimer();
        recoveryAttemptRef.current++;
        onRecoveryAttemptRef.current?.(recoveryAttemptRef.current, error);
        scheduleRecovery();
      }
    };

    handleBufferLoaded = () => {
      if (recoveryAttemptRef.current > 0) {
        startHealthyPlaybackTimer();
      }
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
        player = await buildPlayer();
        if (effectCancelled || !player) return;
        playerRef.current = player;
        resetRecoveryBackoff();
        onReadyRef.current?.();
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        onErrorRef.current?.(err);
        if (autoRecoveryEnabled) {
          recoveryAttemptRef.current++;
          onRecoveryAttemptRef.current?.(recoveryAttemptRef.current, err);
          scheduleRecovery();
        }
      }
    })();

    return () => {
      effectCancelled = true;
      clearSdkRefreshTimer();
      clearRecoveryTimer();
      clearHealthyTimer();
      resetRecoveryBackoff();
      scheduleSdkTokenRefreshRef.current = () => {};
      if (player) {
        player.off(MediaPlayer.events.BUFFER_LOADED, handleBufferLoaded, undefined);
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
    isVod,
    startTimeSec,
    vodDurationSec,
    seekOffsetSec,
    maxRetryIntervalMs,
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
      controls={isVod}
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
