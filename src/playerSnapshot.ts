import type { RhombusPlayerMode, RhombusSnapshotResult } from "./types.js";

/** Options for {@link snapshotCanvasElement} / {@link snapshotVideoElement}. */
export type SnapshotOptions = {
  /** Wall-clock time (epoch ms) represented by the captured frame. */
  wallClockMs: number;
  /** Which mode the player was in when the frame was captured. */
  mode: RhombusPlayerMode;
  /** Image MIME type. Default `image/png`. */
  mimeType?: string;
  /** Quality 0–1 for lossy types (jpeg/webp). Ignored for png. */
  quality?: number;
};

function toBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => {
    try {
      canvas.toBlob(b => resolve(b), mimeType, quality);
    } catch {
      resolve(null);
    }
  });
}

async function buildResult(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  { wallClockMs, mode, mimeType = "image/png", quality }: SnapshotOptions
): Promise<RhombusSnapshotResult> {
  const dataUrl = canvas.toDataURL(mimeType, quality);
  const blob = await toBlob(canvas, mimeType, quality);
  return { dataUrl, blob, wallClockMs, mode, width, height };
}

/**
 * Capture the current frame of a realtime `<canvas>`. The realtime canvas is drawn from a
 * same-origin WebCodecs `VideoDecoder`, so it is **not** tainted — `toDataURL` works directly.
 */
export async function snapshotCanvasElement(
  canvas: HTMLCanvasElement,
  options: SnapshotOptions
): Promise<RhombusSnapshotResult> {
  return buildResult(canvas, canvas.width, canvas.height, options);
}

/**
 * Capture the current frame of a `<video>` by drawing it to an offscreen canvas.
 *
 * The buffered player feeds the `<video>` via MSE (`SourceBuffer.appendBuffer`), not a
 * cross-origin `src`, so the canvas is **not** tainted and `toDataURL` succeeds. (Do not set
 * `crossOrigin` on the dash video — it would force CORS preflight on every segment fetch.)
 */
export async function snapshotVideoElement(
  video: HTMLVideoElement,
  options: SnapshotOptions
): Promise<RhombusSnapshotResult> {
  const width = video.videoWidth || video.clientWidth;
  const height = video.videoHeight || video.clientHeight;
  if (!width || !height) {
    throw new Error("Cannot snapshot: video has no dimensions yet");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot snapshot: 2D canvas context unavailable");
  ctx.drawImage(video, 0, 0, width, height);
  return buildResult(canvas, width, height, options);
}
