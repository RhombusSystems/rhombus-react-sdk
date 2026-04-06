import type { MediaPlayerSettingClass } from "dashjs";

/**
 * Default Dash.js streaming settings aligned with Rhombus live camera DASH playback
 * (see Rhombus player-example index.html).
 */
export function getDefaultRhombusDashSettings(): MediaPlayerSettingClass {
  return {
    streaming: {
      scheduling: {
        scheduleWhilePaused: false,
        defaultTimeout: 5000,
      },
      delay: {
        liveDelayFragmentCount: 4,
      },
      liveCatchup: {
        maxDrift: 10,
        playbackRate: {
          min: -0.5,
          max: 1.0,
        },
        playbackBufferMin: 15,
        enabled: true,
        mode: "fast",
      },
      gaps: {
        jumpGaps: true,
        jumpLargeGaps: true,
        smallGapLimit: 1.5,
        threshold: 0.3,
        enableSeekFix: true,
        enableStallFix: true,
        stallSeek: 0.1,
      },
      buffer: {
        flushBufferAtTrackSwitch: true,
        fastSwitchEnabled: true,
        initialBufferLevel: NaN,
        bufferTimeAtTopQuality: 30,
        bufferTimeAtTopQualityLongForm: 60,
        longFormContentDurationThreshold: 600,
      },
      abr: {
        autoSwitchBitrate: {
          video: false,
          audio: false,
        },
      },
    },
  } as MediaPlayerSettingClass;
}
