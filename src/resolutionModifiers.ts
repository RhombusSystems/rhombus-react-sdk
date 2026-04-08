import type { RhombusBufferedStreamQuality } from "./types.js";

/** Matches Rhombus Console `ResolutionModifiers` / `appendResolutionModifiers`. */
export type ResolutionModifiers = {
  decimate?: number;
  width?: number;
  height?: number;
  bitRate?: number;
};

export function getResolutionModifiersForBufferedStream(
  quality: RhombusBufferedStreamQuality
): ResolutionModifiers {
  switch (quality) {
    case "LOW":
      return {
        height: 240,
        bitRate: 240,
      };
    case "MEDIUM":
      return {
        height: 480,
        bitRate: 360,
      };
    default:
    case "HIGH":
      return {};
  }
}

export function appendResolutionModifiers(url: string, modifiers: ResolutionModifiers): string {
  if (url.includes("_ds")) return url;
  const keys = Object.keys(modifiers) as (keyof ResolutionModifiers)[];
  const encoded = keys.map(k => `${String(k).slice(0, 1)}${modifiers[k] as number}`).join("");
  return `${url}${url.includes("?") ? "&" : "?"}_ds=${encoded}`;
}

/**
 * When SD is requested, replace `/ws` with `/wsl` (Rhombus low-res WebSocket path).
 * Matches Rhombus Console `formatWebsocketResolutionUri`.
 */
export function formatWebsocketResolutionUri(sdEnabled: boolean, uri: string): string {
  if (!sdEnabled) return uri;
  return uri.replace(/\/ws(?=\?|$)/, "/wsl");
}
