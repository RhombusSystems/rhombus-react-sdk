import { firstMediaUri } from "./mediaUriPick.js";
import { formatWebsocketResolutionUri } from "./resolutionModifiers.js";
import type { RhombusRealtimeConnectionMode, RhombusRealtimeStreamQuality } from "./types.js";
import { appendFederatedAuthQueryParams, joinUrl } from "./urlAuth.js";

const LOG_PREFIX = "[RhombusRealtimePlayer]";

/**
 * Rhombus `getMediaUris` returns LAN realtime as `lanLiveH264Uris` (array).
 * WAN may be `wanLiveH264Uris` (array) or `wanLiveH264Uri` (string) depending on API version / response shape.
 */
function pickLiveH264Uri(
  record: Record<string, unknown>,
  connectionMode: RhombusRealtimeConnectionMode
): string | undefined {
  if (connectionMode === "wan") {
    return (
      firstMediaUri(record.wanLiveH264Uris) ?? firstMediaUri(record.wanLiveH264Uri)
    );
  }
  return (
    firstMediaUri(record.lanLiveH264Uris) ?? firstMediaUri(record.lanLiveH264Uri)
  );
}

function parseLiveH264UriFromMediaJson(
  mediaJson: unknown,
  connectionMode: RhombusRealtimeConnectionMode,
  federatedSessionToken: string,
  realtimeStreamQuality: RhombusRealtimeStreamQuality
): string {
  if (typeof mediaJson !== "object" || mediaJson === null) {
    throw new Error("Invalid media URIs response");
  }
  const record = mediaJson as Record<string, unknown>;
  const raw = pickLiveH264Uri(record, connectionMode);
  if (!raw) {
    const keys =
      connectionMode === "wan"
        ? "wanLiveH264Uri or wanLiveH264Uris"
        : "lanLiveH264Uri or lanLiveH264Uris";
    throw new Error(`Invalid media URIs response: missing or empty ${keys}`);
  }
  if (!raw.startsWith("wss:") && !raw.startsWith("ws:")) {
    throw new Error(`Expected WebSocket URL for realtime H.264, got: ${raw.slice(0, 32)}…`);
  }
  const sdEnabled = realtimeStreamQuality === "SD";
  const pathUri = formatWebsocketResolutionUri(sdEnabled, raw);
  return appendFederatedAuthQueryParams(pathUri, federatedSessionToken);
}

export async function fetchCameraMediaUrisJsonDirect(
  rhombusApiBaseUrl: string,
  mediaPath: string,
  federatedSessionToken: string,
  cameraUuid: string
): Promise<unknown> {
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
          `${LOG_PREFIX} Media URIs request rejected (${mediaRes.status}). Check the federated session token and Rhombus domain allowlisting.`
        );
      }
      throw new Error(`Media URIs request failed: ${mediaRes.status} ${mediaRes.statusText}`);
    }
    return mediaRes.json();
  } catch (e: unknown) {
    if (e instanceof TypeError) {
      console.error(
        `${LOG_PREFIX} Request to Rhombus API failed (${e.message}). If the browser blocked the request (CORS), ensure the federated token was created with a matching Rhombus domain for this origin.`
      );
    }
    throw e;
  }
}

export async function fetchCameraMediaUrisJsonViaOverride(
  absoluteUrl: string,
  requestHeaders: HeadersInit,
  cameraUuid: string,
  usedDefaultMediaPath: boolean
): Promise<unknown> {
  const mediaRes = await fetch(absoluteUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ cameraUuid }),
  });
  if (!mediaRes.ok) {
    const hint = usedDefaultMediaPath
      ? ` The default path segment is /api/media-uris. Implement that route or set paths.mediaUris.`
      : ` Verify paths.mediaUris and apiOverrideBaseUrl.`;
    console.error(
      `${LOG_PREFIX} Media URIs request failed (${mediaRes.status} ${mediaRes.statusText}) for ${absoluteUrl}.${hint}`
    );
    throw new Error(`Media URIs request failed: ${mediaRes.status} ${mediaRes.statusText}`);
  }
  return mediaRes.json();
}

export async function resolveLiveH264WebSocketUrl(options: {
  useDirectRhombusApi: boolean;
  overrideBase?: string;
  rhombusApiBaseUrl: string;
  mediaPath: string;
  federatedSessionToken: string;
  cameraUuid: string;
  requestHeaders: HeadersInit;
  usedDefaultMediaPath: boolean;
  connectionMode: RhombusRealtimeConnectionMode;
  /** Default `HD` (`/ws`). `SD` uses `/wsl`. */
  realtimeStreamQuality?: RhombusRealtimeStreamQuality;
}): Promise<string> {
  const mediaJson = options.useDirectRhombusApi
    ? await fetchCameraMediaUrisJsonDirect(
        options.rhombusApiBaseUrl,
        options.mediaPath,
        options.federatedSessionToken,
        options.cameraUuid
      )
    : await fetchCameraMediaUrisJsonViaOverride(
        joinUrl(options.overrideBase!, options.mediaPath),
        options.requestHeaders,
        options.cameraUuid,
        options.usedDefaultMediaPath
      );

  const realtimeStreamQuality = options.realtimeStreamQuality ?? "HD";

  return parseLiveH264UriFromMediaJson(
    mediaJson,
    options.connectionMode,
    options.federatedSessionToken,
    realtimeStreamQuality
  );
}
