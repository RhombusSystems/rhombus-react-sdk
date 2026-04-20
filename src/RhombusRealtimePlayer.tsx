import { useEffect, useRef } from "react";
import type { FederatedTokenFetchResult } from "./rhombusPlayback.js";
import type { RhombusRealtimePlayerProps } from "./types.js";
import {
  DEFAULT_RHOMBUS_API_BASE_URL,
  fetchFederatedSessionToken,
  getBrowserOrigin,
  getFederatedTokenRefreshDelayMs,
  mergeRequestHeaders,
} from "./rhombusPlayback.js";
import { resolveLiveH264WebSocketUrl } from "./rhombusRealtimePlayback.js";
import { joinUrl } from "./urlAuth.js";
import { startRhombusRealtimeSession } from "./rhombusRealtimeSession.js";

const DEFAULT_FEDERATED_PATH = "/api/federated-token";
const DEFAULT_MEDIA_PATH_OVERRIDE = "/api/media-uris";
const DEFAULT_MEDIA_PATH_DIRECT = "/camera/getMediaUris";

const DEFAULT_REALTIME_MAX_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_REALTIME_STALL_TIMEOUT_MS = 12_000;

export function RhombusRealtimePlayer({
  cameraUuid,
  connectionMode,
  apiOverrideBaseUrl,
  rhombusApiBaseUrl,
  paths,
  federatedSessionToken,
  tokenDurationSec = 86_400,
  realtimeStreamQuality = "HD",
  headers,
  getRequestHeaders,
  maxRetryIntervalMs = DEFAULT_REALTIME_MAX_RETRY_INTERVAL_MS,
  stallTimeoutMs = DEFAULT_REALTIME_STALL_TIMEOUT_MS,
  onRecoveryAttempt,
  canvasProps,
  className,
  style,
  onReady,
  onError,
}: RhombusRealtimePlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onRecoveryAttemptRef = useRef(onRecoveryAttempt);
  const headersRef = useRef(headers);
  const getRequestHeadersRef = useRef(getRequestHeaders);
  const maxRetryIntervalMsRef = useRef(maxRetryIntervalMs);
  const stallTimeoutMsRef = useRef(stallTimeoutMs);
  maxRetryIntervalMsRef.current = maxRetryIntervalMs;
  stallTimeoutMsRef.current = stallTimeoutMs;

  const tokenRef = useRef("");
  const durationSecRef = useRef(tokenDurationSec);
  durationSecRef.current = tokenDurationSec;

  const sdkRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroySessionRef = useRef<(() => void) | null>(null);
  const realtimeReadyFiredRef = useRef(false);
  const scheduleSdkTokenRefreshRef = useRef<
    (last: FederatedTokenFetchResult, fetchedAtMs: number, durationUsedSec: number) => void
  >(() => {});
  const prevExternalFederatedTokenRef = useRef<string | undefined>(undefined);

  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  onRecoveryAttemptRef.current = onRecoveryAttempt;
  headersRef.current = headers;
  getRequestHeadersRef.current = getRequestHeaders;

  const overrideBase = apiOverrideBaseUrl?.trim() || undefined;
  const useDirectRhombusApi = overrideBase === undefined;
  const federatedPath = paths?.federatedToken ?? DEFAULT_FEDERATED_PATH;
  const mediaPath = useDirectRhombusApi
    ? paths?.mediaUris ?? DEFAULT_MEDIA_PATH_DIRECT
    : paths?.mediaUris ?? DEFAULT_MEDIA_PATH_OVERRIDE;
  const usedDefaultFederatedPath = paths?.federatedToken === undefined;
  const usedDefaultMediaPath = paths?.mediaUris === undefined;
  const resolvedRhombusBase = rhombusApiBaseUrl?.trim() || DEFAULT_RHOMBUS_API_BASE_URL;

  const sdkManagedFederatedToken = federatedSessionToken === undefined;
  const federatedTokenModeKey =
    federatedSessionToken === undefined ? "__sdk_managed__" : "__external__";

  function clearSdkRefreshTimer() {
    if (sdkRefreshTimerRef.current != null) {
      clearTimeout(sdkRefreshTimerRef.current);
      sdkRefreshTimerRef.current = null;
    }
  }

  function destroyRealtimeSession() {
    destroySessionRef.current?.();
    destroySessionRef.current = null;
  }

  useEffect(() => {
    if (federatedSessionToken === undefined) return;
    if (typeof federatedSessionToken !== "string" || !federatedSessionToken) return;

    const prev = prevExternalFederatedTokenRef.current;
    prevExternalFederatedTokenRef.current = federatedSessionToken;
    tokenRef.current = federatedSessionToken;

    if (prev === undefined) return;
    if (prev === federatedSessionToken) return;
    if (!destroySessionRef.current) return;

    let externalRotateCancelled = false;
    void (async () => {
      try {
        const requestHeaders = await mergeRequestHeaders(
          headersRef.current,
          getRequestHeadersRef.current
        );
        const wsUrl = await resolveLiveH264WebSocketUrl({
          useDirectRhombusApi,
          overrideBase,
          rhombusApiBaseUrl: resolvedRhombusBase,
          mediaPath,
          federatedSessionToken: tokenRef.current,
          cameraUuid,
          requestHeaders,
          usedDefaultMediaPath,
          connectionMode,
          realtimeStreamQuality,
        });
        if (externalRotateCancelled || !destroySessionRef.current) return;
        const el = canvasRef.current;
        if (!el) return;
        destroyRealtimeSession();
        destroySessionRef.current = startRhombusRealtimeSession({
          wsUrl,
          canvas: el,
          onError: err => {
            onErrorRef.current?.(err);
          },
          onReady: () => {
            if (!realtimeReadyFiredRef.current) {
              realtimeReadyFiredRef.current = true;
              onReadyRef.current?.();
            }
          },
          onRecoveryAttempt: (attempt, err) => {
            onRecoveryAttemptRef.current?.(attempt, err);
          },
          maxRetryIntervalMs: maxRetryIntervalMsRef.current,
          stallTimeoutMs: stallTimeoutMsRef.current,
        });
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        onErrorRef.current?.(err);
      }
    })();

    return () => {
      externalRotateCancelled = true;
    };
  }, [
    federatedSessionToken,
    useDirectRhombusApi,
    overrideBase,
    resolvedRhombusBase,
    mediaPath,
    cameraUuid,
    usedDefaultMediaPath,
    connectionMode,
    realtimeStreamQuality,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let effectCancelled = false;
    realtimeReadyFiredRef.current = false;

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
            const wsUrl = await resolveLiveH264WebSocketUrl({
              useDirectRhombusApi,
              overrideBase,
              rhombusApiBaseUrl: resolvedRhombusBase,
              mediaPath,
              federatedSessionToken: tokenRef.current,
              cameraUuid,
              requestHeaders,
              usedDefaultMediaPath,
              connectionMode,
              realtimeStreamQuality,
            });
            if (effectCancelled) return;
            const el = canvasRef.current;
            if (!el) return;
            destroyRealtimeSession();
            destroySessionRef.current = startRhombusRealtimeSession({
              wsUrl,
              canvas: el,
              onError: err => {
                onErrorRef.current?.(err);
              },
              onReady: () => {
                if (!realtimeReadyFiredRef.current) {
                  realtimeReadyFiredRef.current = true;
                  onReadyRef.current?.();
                }
              },
              onRecoveryAttempt: (attempt, err) => {
                onRecoveryAttemptRef.current?.(attempt, err);
              },
              maxRetryIntervalMs: maxRetryIntervalMsRef.current,
              stallTimeoutMs: stallTimeoutMsRef.current,
            });
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

        if (effectCancelled) return;

        const wsUrl = await resolveLiveH264WebSocketUrl({
          useDirectRhombusApi,
          overrideBase,
          rhombusApiBaseUrl: resolvedRhombusBase,
          mediaPath,
          federatedSessionToken: tokenRef.current,
          cameraUuid,
          requestHeaders,
          usedDefaultMediaPath,
          connectionMode,
          realtimeStreamQuality,
        });

        if (effectCancelled) return;

        const el = canvasRef.current;
        if (!el || effectCancelled) return;

        destroySessionRef.current = startRhombusRealtimeSession({
          wsUrl,
          canvas: el,
          onError: err => {
            onErrorRef.current?.(err);
          },
          onReady: () => {
            if (realtimeReadyFiredRef.current) return;
            realtimeReadyFiredRef.current = true;
            onReadyRef.current?.();
          },
          onRecoveryAttempt: (attempt, err) => {
            onRecoveryAttemptRef.current?.(attempt, err);
          },
          maxRetryIntervalMs: maxRetryIntervalMsRef.current,
          stallTimeoutMs: stallTimeoutMsRef.current,
        });

        if (sdkManagedFederatedToken && initialTokenResult !== null) {
          scheduleSdkTokenRefresh(initialTokenResult, Date.now(), durationSecRef.current);
        }
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        onErrorRef.current?.(err);
      }
    })();

    return () => {
      effectCancelled = true;
      clearSdkRefreshTimer();
      scheduleSdkTokenRefreshRef.current = () => {};
      destroyRealtimeSession();
      prevExternalFederatedTokenRef.current = undefined;
    };
  }, [
    federatedTokenModeKey,
    cameraUuid,
    connectionMode,
    overrideBase,
    federatedPath,
    mediaPath,
    resolvedRhombusBase,
    useDirectRhombusApi,
    usedDefaultFederatedPath,
    usedDefaultMediaPath,
    realtimeStreamQuality,
  ]);

  useEffect(() => {
    if (!sdkManagedFederatedToken) return;
    if (!destroySessionRef.current) return;

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
        if (cancelled || !destroySessionRef.current) return;
        tokenRef.current = next.federatedSessionToken;
        const wsUrl = await resolveLiveH264WebSocketUrl({
          useDirectRhombusApi,
          overrideBase,
          rhombusApiBaseUrl: resolvedRhombusBase,
          mediaPath,
          federatedSessionToken: tokenRef.current,
          cameraUuid,
          requestHeaders,
          usedDefaultMediaPath,
          connectionMode,
          realtimeStreamQuality,
        });
        if (cancelled || !destroySessionRef.current) return;
        const el = canvasRef.current;
        if (!el) return;
        destroyRealtimeSession();
        destroySessionRef.current = startRhombusRealtimeSession({
          wsUrl,
          canvas: el,
          onError: err => {
            onErrorRef.current?.(err);
          },
          onReady: () => {
            if (!realtimeReadyFiredRef.current) {
              realtimeReadyFiredRef.current = true;
              onReadyRef.current?.();
            }
          },
          onRecoveryAttempt: (attempt, err) => {
            onRecoveryAttemptRef.current?.(attempt, err);
          },
          maxRetryIntervalMs: maxRetryIntervalMsRef.current,
          stallTimeoutMs: stallTimeoutMsRef.current,
        });
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
    cameraUuid,
    connectionMode,
    mediaPath,
    resolvedRhombusBase,
    usedDefaultMediaPath,
    realtimeStreamQuality,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={style}
      {...canvasProps}
    />
  );
}
