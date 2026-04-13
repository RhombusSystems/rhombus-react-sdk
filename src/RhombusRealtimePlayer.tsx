import { useEffect, useRef } from "react";
import type { RhombusRealtimePlayerProps } from "./types.js";
import {
  DEFAULT_RHOMBUS_API_BASE_URL,
  fetchFederatedSessionToken,
  getBrowserOrigin,
  mergeRequestHeaders,
} from "./rhombusPlayback.js";
import { resolveLiveH264WebSocketUrl } from "./rhombusRealtimePlayback.js";
import { joinUrl } from "./urlAuth.js";
import { startRhombusRealtimeSession } from "./rhombusRealtimeSession.js";

const DEFAULT_FEDERATED_PATH = "/api/federated-token";
const DEFAULT_MEDIA_PATH_OVERRIDE = "/api/media-uris";
const DEFAULT_MEDIA_PATH_DIRECT = "/camera/getMediaUris";

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
  canvasProps,
  className,
  style,
  onReady,
  onError,
}: RhombusRealtimePlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const headersRef = useRef(headers);
  const getRequestHeadersRef = useRef(getRequestHeaders);

  onReadyRef.current = onReady;
  onErrorRef.current = onError;
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let destroySession: (() => void) | null = null;
    let readyFired = false;

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

        if (cancelled) return;

        const wsUrl = await resolveLiveH264WebSocketUrl({
          useDirectRhombusApi,
          overrideBase,
          rhombusApiBaseUrl: resolvedRhombusBase,
          mediaPath,
          federatedSessionToken: resolvedToken,
          cameraUuid,
          requestHeaders,
          usedDefaultMediaPath,
          connectionMode,
          realtimeStreamQuality,
        });

        if (cancelled) return;

        const el = canvasRef.current;
        if (!el || cancelled) return;

        destroySession = startRhombusRealtimeSession({
          wsUrl,
          canvas: el,
          onError: err => {
            onErrorRef.current?.(err);
          },
          onReady: () => {
            if (readyFired) return;
            readyFired = true;
            onReadyRef.current?.();
          },
        });
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        onErrorRef.current?.(err);
      }
    })();

    return () => {
      cancelled = true;
      if (destroySession) {
        destroySession();
        destroySession = null;
      }
    };
  }, [
    cameraUuid,
    connectionMode,
    overrideBase,
    federatedPath,
    mediaPath,
    resolvedRhombusBase,
    tokenDurationSec,
    federatedSessionToken,
    useDirectRhombusApi,
    usedDefaultFederatedPath,
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
