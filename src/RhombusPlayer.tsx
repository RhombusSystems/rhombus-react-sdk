import { useEffect, useRef } from "react";
import {
  MediaPlayer,
  type ErrorEvent as DashJSErrorEvent,
  type MediaPlayerClass,
} from "dashjs";
import { getDefaultRhombusDashSettings } from "./dashSettings.js";
import type { RhombusPlayerProps } from "./types.js";
import { appendFederatedAuthQueryParams, joinUrl } from "./urlAuth.js";

const DEFAULT_PATHS = {
  federatedToken: "/api/federated-token",
  mediaUris: "/api/media-uris",
} as const;

async function mergeRequestHeaders(
  headers: HeadersInit | undefined,
  getRequestHeaders: RhombusPlayerProps["getRequestHeaders"]
): Promise<HeadersInit> {
  const out = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      out.set(key, value);
    });
  }
  if (getRequestHeaders) {
    const extra = await getRequestHeaders();
    new Headers(extra).forEach((value, key) => {
      out.set(key, value);
    });
  }
  return out;
}

export function RhombusPlayer({
  cameraUuid,
  proxyBaseUrl,
  paths,
  tokenDurationSec = 86_400,
  headers,
  getRequestHeaders,
  videoProps,
  className,
  style,
  onReady,
  onError,
}: RhombusPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<MediaPlayerClass | null>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const headersRef = useRef(headers);
  const getRequestHeadersRef = useRef(getRequestHeaders);

  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  headersRef.current = headers;
  getRequestHeadersRef.current = getRequestHeaders;

  const federatedPath = paths?.federatedToken ?? DEFAULT_PATHS.federatedToken;
  const mediaPath = paths?.mediaUris ?? DEFAULT_PATHS.mediaUris;

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

        const tokenRes = await fetch(joinUrl(proxyBaseUrl, federatedPath), {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({ durationSec: tokenDurationSec }),
        });
        if (!tokenRes.ok) {
          throw new Error(
            `Federated token request failed: ${tokenRes.status} ${tokenRes.statusText}`
          );
        }
        const tokenJson: unknown = await tokenRes.json();
        const federatedSessionToken =
          typeof tokenJson === "object" &&
          tokenJson !== null &&
          "federatedSessionToken" in tokenJson &&
          typeof (tokenJson as { federatedSessionToken: unknown }).federatedSessionToken === "string"
            ? (tokenJson as { federatedSessionToken: string }).federatedSessionToken
            : undefined;
        if (!federatedSessionToken) {
          throw new Error("Invalid federated token response: missing federatedSessionToken");
        }

        const mediaRes = await fetch(joinUrl(proxyBaseUrl, mediaPath), {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({ cameraUuid }),
        });
        if (!mediaRes.ok) {
          throw new Error(`Media URIs request failed: ${mediaRes.status} ${mediaRes.statusText}`);
        }
        const mediaJson: unknown = await mediaRes.json();
        const wanLiveMpdUri =
          typeof mediaJson === "object" &&
          mediaJson !== null &&
          "wanLiveMpdUri" in mediaJson &&
          typeof (mediaJson as { wanLiveMpdUri: unknown }).wanLiveMpdUri === "string"
            ? (mediaJson as { wanLiveMpdUri: string }).wanLiveMpdUri
            : undefined;
        if (!wanLiveMpdUri) {
          throw new Error("Invalid media URIs response: missing wanLiveMpdUri");
        }

        if (cancelled) return;

        const el = videoRef.current;
        if (!el) return;

        player = MediaPlayer().create();
        playerRef.current = player;

        player.extend(
          "RequestModifier",
          function () {
            return {
              modifyRequestURL: (url: string) =>
                appendFederatedAuthQueryParams(url, federatedSessionToken),
            };
          },
          true
        );

        player.updateSettings(getDefaultRhombusDashSettings());

        player.on(MediaPlayer.events.ERROR, handleDashError, undefined);

        player.initialize(el, wanLiveMpdUri, true);
        onReadyRef.current?.();
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        onErrorRef.current?.(err);
      }
    })();

    return () => {
      cancelled = true;
      if (player) {
        try {
          player.off(MediaPlayer.events.ERROR, handleDashError, undefined);
        } catch {
          /* ignore */
        }
        try {
          player.reset();
        } catch {
          /* ignore */
        }
      }
      playerRef.current = null;
    };
  }, [cameraUuid, proxyBaseUrl, federatedPath, mediaPath, tokenDurationSec]);

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
