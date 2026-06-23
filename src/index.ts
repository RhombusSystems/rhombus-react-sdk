export { RhombusBufferedPlayer } from "./RhombusBufferedPlayer.js";
export { RhombusRealtimePlayer } from "./RhombusRealtimePlayer.js";
export { RhombusPlayer } from "./RhombusPlayer.js";
export { RhombusPlayerControls } from "./RhombusPlayerControls.js";
export { Timeline } from "./Timeline.js";
// `RhombusPlayerControl` is a value (named constant) + type — exported as a value so both work.
export { RhombusPlayerControl } from "./types.js";
export type { TimelineHandle } from "./Timeline.js";
export type {
  RhombusBufferedStreamQuality,
  RhombusBufferedPlayerHandle,
  RhombusBufferedPlayerProps,
  RhombusConnectionMode,
  RhombusPlayerBaseProps,
  RhombusPlayerPaths,
  RhombusRealtimeConnectionMode,
  RhombusRealtimePlayerHandle,
  RhombusRealtimePlayerProps,
  RhombusRealtimeStreamQuality,
  // Unified player
  RhombusPlayerProps,
  RhombusPlayerHandle,
  RhombusPlayerState,
  RhombusPlayerMode,
  RhombusPlayerClassNames,
  RhombusLiveTransport,
  RhombusSnapshotResult,
  RhombusClipRange,
  RhombusClipExportPhase,
  RhombusClipExportStatus,
  RhombusSaveClipConfig,
  RhombusPlayerTimelineConfig,
  // Timeline
  TimelineProps,
  TimelineMark,
  RhombusFootageSeekPoint,
} from "./types.js";
export { getDefaultRhombusDashSettings, getDefaultRhombusVodDashSettings } from "./dashSettings.js";
export {
  fetchFederatedSessionToken,
  getFederatedTokenRefreshDelayMs,
  formatVodMpdUri,
} from "./rhombusPlayback.js";
export type {
  FederatedTokenFetchResult,
  RhombusDashPlayerCallbacks,
  RhombusDashQualityCallbacks,
} from "./rhombusPlayback.js";
export { resolveLiveH264WebSocketUrl } from "./rhombusRealtimePlayback.js";
export { startRhombusRealtimeSession } from "./rhombusRealtimeSession.js";

// Unified-player helpers (advanced surface)
export {
  chooseVodAnchor,
  isWithinWindow,
  vodOffsetToWallClock,
  wallClockToVodOffset,
  shouldSwitchToLive,
  isAtLiveEdge,
} from "./playerVodTime.js";
export type { ChooseVodAnchorOptions, VodAnchor } from "./playerVodTime.js";
export { snapshotCanvasElement, snapshotVideoElement } from "./playerSnapshot.js";
export type { SnapshotOptions } from "./playerSnapshot.js";
export {
  requestClipSplice,
  fetchClipProgress,
  buildClipDownloadUrl,
} from "./rhombusClip.js";
export type {
  RhombusClipRequestAuth,
  RequestClipSpliceOptions,
  ClipSpliceResult,
  ClipProgress,
  FetchClipProgressOptions,
  BuildClipDownloadUrlOptions,
} from "./rhombusClip.js";
