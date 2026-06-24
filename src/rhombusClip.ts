import { mergeRequestHeaders } from "./rhombusPlayback.js";

/**
 * Helpers for the built-in Save Clip export used by {@link RhombusPlayer}.
 *
 * The Rhombus clip endpoints (`/video/spliceV3`, `/event/getClipWithProgress`, and the
 * `/media/metadata/.../*.mp4` download) are **API-key / session authed and are NOT
 * federated-token compatible**. These helpers therefore POST to *your backend proxy* paths
 * (which attach the API key server-side), exactly like the media-URIs proxy route. Use them
 * only in proxy mode (`apiOverrideBaseUrl` set).
 */

/** Shared HTTP options for the proxy requests below. */
export type RhombusClipRequestAuth = {
  /** Static headers for the proxy `fetch`. */
  headers?: HeadersInit;
  /** Async headers merged after `headers`. */
  getRequestHeaders?: () => HeadersInit | Promise<HeadersInit>;
};

/** Options for {@link requestClipSplice}. */
export type RequestClipSpliceOptions = RhombusClipRequestAuth & {
  /** Full URL of your splice proxy route (forwards to `/video/spliceV3`). */
  url: string;
  cameraUuid: string;
  /** Clip start, epoch milliseconds. */
  startTimeMillis: number;
  /** Clip duration in seconds. */
  durationSec: number;
  title: string;
  /** Optional description. */
  description?: string;
  /** Clip visibility (`ORG_WIDE` | `PRIVATE` | `ROLE_RESTRICTED`). */
  clipVisibility?: string;
  /** Include the camera's audio facet (`.a0`). Default `false`. */
  audioIncluded?: boolean;
  /** Persist the clip to Rhombus Console storage. Default `true`. */
  saveToConsole?: boolean;
};

/** Result of {@link requestClipSplice}. */
export type ClipSpliceResult = { clipUuid: string };

async function postJson<T>(
  url: string,
  body: unknown,
  auth: RhombusClipRequestAuth
): Promise<T> {
  const headers = await mergeRequestHeaders(auth.headers, auth.getRequestHeaders);
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "errorMsg" in data && (data as { errorMsg?: string }).errorMsg
        ? (data as { errorMsg?: string }).errorMsg
        : `Request to ${url} failed with ${res.status}`;
    throw new Error(String(msg));
  }
  return data as T;
}

/**
 * Kick off a server-side clip render. Sends a `/video/spliceV3`-shaped body so your proxy can
 * be a thin forwarder. Returns the clip UUID to poll with {@link fetchClipProgress}.
 */
export async function requestClipSplice(
  options: RequestClipSpliceOptions
): Promise<ClipSpliceResult> {
  const {
    url,
    cameraUuid,
    startTimeMillis,
    durationSec,
    title,
    description,
    clipVisibility,
    audioIncluded = false,
    saveToConsole = true,
  } = options;
  const deviceUuids = [`${cameraUuid}.v0`];
  if (audioIncluded) deviceUuids.push(`${cameraUuid}.a0`);
  const body = {
    title,
    description,
    // `.v0` is the primary video facet; `.a0` the audio facet (Rhombus device-facet UUID form).
    deviceUuids,
    startTimeMillis,
    durationSec,
    audioIncluded,
    clipVisibility,
    saveToConsole,
  };
  const data = await postJson<{ clipUuid?: string; clipUuidList?: string[]; errorMsg?: string }>(
    url,
    body,
    options
  );
  const clipUuid = data.clipUuid ?? data.clipUuidList?.[0];
  if (!clipUuid) throw new Error("spliceV3 did not return a clipUuid");
  return { clipUuid };
}

/** Normalized clip progress. */
export type ClipProgress = {
  /** Raw `ClipStatusEnum` (e.g. INITIATING | RENDERING | COMPLETE | FAILED). */
  status?: string;
  /** 0–100. */
  percentComplete?: number;
  currentOperation?: string;
  /** Storage region of the finished clip, when known (needed to build the download URL). */
  region?: string;
  complete: boolean;
  failed: boolean;
  /** Raw server `clip` record. */
  raw: Record<string, unknown>;
};

/** Options for {@link fetchClipProgress}. */
export type FetchClipProgressOptions = RhombusClipRequestAuth & {
  /** Full URL of your progress proxy route (forwards to `/event/getClipWithProgress`). */
  url: string;
  clipUuid: string;
};

function extractRegion(clip: Record<string, unknown>): string | undefined {
  const loc = clip.clipLocation as { region?: string } | undefined;
  const thumb = clip.thumbnailLocation as { region?: string } | undefined;
  return loc?.region ?? thumb?.region ?? undefined;
}

/** Poll a single clip's render progress. */
export async function fetchClipProgress(options: FetchClipProgressOptions): Promise<ClipProgress> {
  const data = await postJson<{ clip?: Record<string, unknown>; errorMsg?: string }>(
    options.url,
    { clipUuid: options.clipUuid },
    options
  );
  const clip = data.clip ?? {};
  const status = clip.status as string | undefined;
  const percentComplete = clip.percentComplete as number | undefined;
  const currentOperation = clip.currentOperation as string | undefined;
  const complete =
    status === "COMPLETE" || (percentComplete === 100 && currentOperation === "Complete");
  const failed = status === "FAILED";
  return {
    status,
    percentComplete,
    currentOperation,
    region: extractRegion(clip),
    complete,
    failed,
    raw: clip,
  };
}

/** Options for {@link buildClipDownloadUrl}. */
export type BuildClipDownloadUrlOptions = {
  /** Full URL of your download proxy route (streams the finished `.mp4`). */
  url: string;
  clipUuid: string;
  /** Storage region, from {@link ClipProgress.region}. */
  region?: string;
};

/**
 * Build a download URL pointing at your proxy's clip-download route. The proxy resolves the
 * Rhombus media host + attaches the API key, then streams `/media/metadata/{region}/{uuid}.mp4`.
 */
export function buildClipDownloadUrl({ url, clipUuid, region }: BuildClipDownloadUrlOptions): string {
  const sep = url.includes("?") ? "&" : "?";
  const params = new URLSearchParams({ clipUuid });
  if (region) params.set("region", region);
  return `${url}${sep}${params.toString()}`;
}
