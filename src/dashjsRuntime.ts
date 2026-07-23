// Dash.js publishes types only for its full bundle. The media-player runtime has the same
// MediaPlayer API without the browser-global-only protection and reporting modules.
// @ts-expect-error dashjs does not publish a declaration for this supported distribution file.
import dashjsRuntime from "dashjs/dist/dash.mediaplayer.min.js";

const dashjs = dashjsRuntime as typeof import("dashjs");

export const MediaPlayer = dashjs.MediaPlayer;
