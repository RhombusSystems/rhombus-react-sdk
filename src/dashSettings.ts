import type { MediaPlayerSettingClass } from "dashjs";

const RHOMBUS_RETRY_ATTEMPTS = {
  MPD: 5,
  XLinkExpansion: 1,
  MediaSegment: 5,
  InitializationSegment: 5,
  BitstreamSwitchingSegment: 5,
  IndexSegment: 5,
  FragmentInfoSegment: 5,
  license: 3,
  other: 3,
  lowLatencyMultiplyFactor: 5,
};

const RHOMBUS_RETRY_INTERVALS = {
  MPD: 1000,
  XLinkExpansion: 500,
  MediaSegment: 2000,
  InitializationSegment: 2000,
  BitstreamSwitchingSegment: 2000,
  IndexSegment: 1000,
  FragmentInfoSegment: 1000,
  license: 1000,
  other: 1000,
  lowLatencyReductionFactor: 10,
};

/**
 * Default Dash.js streaming settings aligned with Rhombus live camera DASH playback
 * (see Rhombus player-example index.html).
 */
export function getDefaultRhombusDashSettings(): MediaPlayerSettingClass {
  return {
    streaming: {
      manifestUpdateRetryInterval: 500,
      retryAttempts: RHOMBUS_RETRY_ATTEMPTS,
      retryIntervals: RHOMBUS_RETRY_INTERVALS,
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

/**
 * Default Dash.js streaming settings tuned for Rhombus VOD (historical footage) playback.
 * Differs from live settings: no live catchup, allows buffering while paused for scrubbing,
 * and larger initial/top-quality buffers for smoother seek.
 */
export function getDefaultRhombusVodDashSettings(): MediaPlayerSettingClass {
  return {
    streaming: {
      manifestUpdateRetryInterval: 500,
      retryAttempts: RHOMBUS_RETRY_ATTEMPTS,
      retryIntervals: RHOMBUS_RETRY_INTERVALS,
      scheduling: {
        scheduleWhilePaused: true,
        defaultTimeout: 5000,
      },
      capabilities: {
        useMediaCapabilitiesApi: false,
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
        fastSwitchEnabled: false,
        initialBufferLevel: 30,
        bufferTimeAtTopQuality: 60,
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
