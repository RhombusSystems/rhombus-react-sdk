import {
  MediaPlayer,
  type ErrorEvent as DashJSErrorEvent,
  type MediaPlayerClass,
} from "dashjs";
import { getDefaultRhombusDashSettings } from "./dashSettings.js";
import {
  appendResolutionModifiers,
  getResolutionModifiersForBufferedStream,
} from "./resolutionModifiers.js";
import type { RhombusBufferedStreamQuality, RhombusBufferedPlayerProps } from "./types.js";
import { appendFederatedAuthQueryParams, joinUrl } from "./urlAuth.js";

export type RhombusDashQualityCallbacks = {
  getBufferedStreamQuality: () => RhombusBufferedStreamQuality;
  getApplyBufferedStreamQuality: () => boolean;
};

/** Dash.js RequestModifier reads the latest token on every request (rotation without player teardown). */
export type RhombusDashPlayerCallbacks = RhombusDashQualityCallbacks & {
  getFederatedSessionToken: () => string;
};

/** Successful federated-token `POST` response shape (required + optional server hints). */
export type FederatedTokenFetchResult = {
  federatedSessionToken: string;
  /** Seconds until expiry, if your token endpoint includes it (caps refresh scheduling). */
  expiresInSec?: number;
  /** Unix epoch ms when the token expires, if your token endpoint includes it. */
  expiresAtMs?: number;
};

function parseFederatedTokenExpiryHints(tokenJson: unknown): Pick<
  FederatedTokenFetchResult,
  "expiresInSec" | "expiresAtMs"
> {
  if (typeof tokenJson !== "object" || tokenJson === null) {
    return {};
  }
  const o = tokenJson as Record<string, unknown>;
  let expiresInSec: number | undefined;
  if (
    "expiresInSec" in o &&
    typeof o.expiresInSec === "number" &&
    Number.isFinite(o.expiresInSec)
  ) {
    expiresInSec = o.expiresInSec;
  }
  let expiresAtMs: number | undefined;
  if (
    "expiresAtMs" in o &&
    typeof o.expiresAtMs === "number" &&
    Number.isFinite(o.expiresAtMs)
  ) {
    expiresAtMs = o.expiresAtMs;
  } else if ("expiresAt" in o) {
    const v = o.expiresAt;
    if (typeof v === "number" && Number.isFinite(v)) {
      expiresAtMs = v < 1e12 ? v * 1000 : v;
    } else if (typeof v === "string") {
      const parsed = Date.parse(v);
      if (!Number.isNaN(parsed)) {
        expiresAtMs = parsed;
      }
    }
  }
  return { expiresInSec, expiresAtMs };
}

/**
 * Delay before refreshing the federated token (~97% of effective TTL).
 * Effective TTL is the minimum of the requested duration and any server-provided expiry hints.
 */
export function getFederatedTokenRefreshDelayMs(args: {
  requestedDurationSec: number;
  fetchedAtMs: number;
  expiryHint?: Pick<FederatedTokenFetchResult, "expiresInSec" | "expiresAtMs">;
}): number {
  const requestedTtlMs = Math.max(1, args.requestedDurationSec) * 1000;
  let cappedTtlMs = requestedTtlMs;
  const hint = args.expiryHint;
  if (hint?.expiresInSec != null && Number.isFinite(hint.expiresInSec)) {
    cappedTtlMs = Math.min(cappedTtlMs, Math.max(0, hint.expiresInSec) * 1000);
  }
  if (hint?.expiresAtMs != null && Number.isFinite(hint.expiresAtMs)) {
    const remaining = hint.expiresAtMs - args.fetchedAtMs;
    cappedTtlMs = Math.min(cappedTtlMs, Math.max(0, remaining));
  }
  const delay = Math.floor(cappedTtlMs * 0.97);
  return Math.max(1000, delay);
}

export const DEFAULT_RHOMBUS_API_BASE_URL = "https://api2.rhombussystems.com/api";

const LOG_PREFIX = "[RhombusBufferedPlayer]";

export function getBrowserOrigin(): string {
  if (
    typeof globalThis === "undefined" ||
    !("location" in globalThis) ||
    globalThis.location == null ||
    typeof globalThis.location.origin !== "string" ||
    !globalThis.location.origin
  ) {
    throw new Error(
      `${LOG_PREFIX} apiOverrideBaseUrl is required when window.location is not available (e.g. SSR) and federatedSessionToken is not provided.`
    );
  }
  return globalThis.location.origin;
}

export async function mergeRequestHeaders(
  headers: HeadersInit | undefined,
  getRequestHeaders: RhombusBufferedPlayerProps["getRequestHeaders"]
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

function parseWanLiveMpdUri(mediaJson: unknown): string | undefined {
  if (
    typeof mediaJson === "object" &&
    mediaJson !== null &&
    "wanLiveMpdUri" in mediaJson &&
    typeof (mediaJson as { wanLiveMpdUri: unknown }).wanLiveMpdUri === "string"
  ) {
    return (mediaJson as { wanLiveMpdUri: string }).wanLiveMpdUri;
  }
  return undefined;
}

export async function fetchFederatedSessionToken(
  absoluteUrl: string,
  requestHeaders: HeadersInit,
  tokenDurationSec: number,
  usedDefaultFederatedPath: boolean
): Promise<FederatedTokenFetchResult> {
  const tokenRes = await fetch(absoluteUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ durationSec: tokenDurationSec }),
  });
  if (!tokenRes.ok) {
    const hint = usedDefaultFederatedPath
      ? ` The default path segment is /api/federated-token. Implement that route on this host or set paths={{ federatedToken: '/your/path' }}. If the host is wrong, set apiOverrideBaseUrl or align deployment with same-origin.`
      : ` Verify paths.federatedToken and apiOverrideBaseUrl (or same-origin) match your server.`;
    console.error(
      `${LOG_PREFIX} Federated token request failed (${tokenRes.status} ${tokenRes.statusText}) for ${absoluteUrl}.${hint}`
    );
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
  const hints = parseFederatedTokenExpiryHints(tokenJson);
  return { federatedSessionToken, ...hints };
}

export async function fetchWanLiveMpdUriViaOverride(
  absoluteUrl: string,
  requestHeaders: HeadersInit,
  cameraUuid: string,
  usedDefaultMediaPath: boolean
): Promise<string> {
  const mediaRes = await fetch(absoluteUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ cameraUuid }),
  });
  if (!mediaRes.ok) {
    const hint = usedDefaultMediaPath
      ? ` The default path segment is /api/media-uris. Implement that route or set paths={{ mediaUris: '/your/path' }}.`
      : ` Verify paths.mediaUris and apiOverrideBaseUrl match your server.`;
    console.error(
      `${LOG_PREFIX} Media URIs request failed (${mediaRes.status} ${mediaRes.statusText}) for ${absoluteUrl}.${hint}`
    );
    throw new Error(`Media URIs request failed: ${mediaRes.status} ${mediaRes.statusText}`);
  }
  const mediaJson: unknown = await mediaRes.json();
  const wanLiveMpdUri = parseWanLiveMpdUri(mediaJson);
  if (!wanLiveMpdUri) {
    throw new Error("Invalid media URIs response: missing wanLiveMpdUri");
  }
  return wanLiveMpdUri;
}

export async function fetchWanLiveMpdUriDirect(
  rhombusApiBaseUrl: string,
  mediaPath: string,
  federatedSessionToken: string,
  cameraUuid: string
): Promise<string> {
  const absoluteUrl = joinUrl(rhombusApiBaseUrl, mediaPath);
  try {
    const mediaRes = await fetch(absoluteUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-auth-scheme": "federated-token",
        "x-auth-ft": federatedSessionToken,
      },
      body: JSON.stringify({ cameraUuid }),
    });
    if (!mediaRes.ok) {
      if (mediaRes.status === 401 || mediaRes.status === 403) {
        console.error(
          `${LOG_PREFIX} Media URIs request rejected (${mediaRes.status}). Check the federated session token and that generateFederatedSessionToken was called with a "domain" that allows this page origin to call the Rhombus API.`
        );
      }
      throw new Error(`Media URIs request failed: ${mediaRes.status} ${mediaRes.statusText}`);
    }
    const mediaJson: unknown = await mediaRes.json();
    const wanLiveMpdUri = parseWanLiveMpdUri(mediaJson);
    if (!wanLiveMpdUri) {
      throw new Error("Invalid media URIs response: missing wanLiveMpdUri");
    }
    return wanLiveMpdUri;
  } catch (e: unknown) {
    if (e instanceof TypeError) {
      console.error(
        `${LOG_PREFIX} Request to Rhombus API failed (${e.message}). If the browser blocked the request (CORS), the federated token may have been created without a matching "domain" for this origin. When calling generateFederatedSessionToken server-side, include "domain" so browser requests to api2.rhombussystems.com are allowed. See SDK README.`
      );
    }
    throw e;
  }
}

export function createRhombusDashPlayer(
  videoEl: HTMLVideoElement,
  wanLiveMpdUri: string,
  onDashError: (e: DashJSErrorEvent) => void,
  callbacks: RhombusDashPlayerCallbacks
): MediaPlayerClass {
  const player = MediaPlayer().create();

  player.extend(
    "RequestModifier",
    function () {
      return {
        modifyRequestURL: (url: string) => {
          let next = url;
          if (callbacks.getApplyBufferedStreamQuality()) {
            next = appendResolutionModifiers(
              next,
              getResolutionModifiersForBufferedStream(callbacks.getBufferedStreamQuality())
            );
          }
          return appendFederatedAuthQueryParams(next, callbacks.getFederatedSessionToken());
        },
      };
    },
    true
  );

  player.updateSettings(getDefaultRhombusDashSettings());

  player.on(MediaPlayer.events.ERROR, onDashError, undefined);

  player.initialize(videoEl, wanLiveMpdUri, true);
  return player;
}

export function destroyRhombusDashPlayer(
  player: MediaPlayerClass,
  onDashError: (e: DashJSErrorEvent) => void
): void {
  try {
    player.off(MediaPlayer.events.ERROR, onDashError, undefined);
  } catch {
    /* ignore */
  }
  try {
    player.reset();
  } catch {
    /* ignore */
  }
}
