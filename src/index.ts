export { RhombusBufferedPlayer } from "./RhombusBufferedPlayer.js";
export { RhombusRealtimePlayer } from "./RhombusRealtimePlayer.js";
export { RhombusPlayer } from "./RhombusPlayer.js";
export { RhombusPlayerControls } from "./RhombusPlayerControls.js";
export { RhombusDateTimePicker } from "./RhombusDateTimePicker.js";
export type {
  RhombusDateTimePickerProps,
  RhombusDateTimePickerClassNames,
} from "./RhombusDateTimePicker.js";
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
  RhombusVideoFit,
  RhombusSnapshotResult,
  RhombusClipRange,
  RhombusClipVisibility,
  RhombusClipExportOptions,
  RhombusClipExportPhase,
  RhombusClipExportStatus,
  RhombusSaveClipConfig,
  RhombusPlayerTimelineConfig,
  // Timeline
  TimelineProps,
  TimelineMark,
  TimelineColors,
  RhombusFootageSeekPoint,
  // Footage availability
  RhombusFootageWindow,
  RhombusFootageAvailability,
  RhombusFootageGap,
  RhombusRangeCoverage,
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
export {
  fetchPresenceWindows,
  mergeFootageWindows,
  computeFootageGaps,
  computeRangeCoverage,
  FOOTAGE_JOIN_TOLERANCE_MS,
  FOOTAGE_MIN_GAP_MS,
  FOOTAGE_LIVE_GRACE_MS,
} from "./rhombusPresence.js";
export type { FetchPresenceWindowsOptions } from "./rhombusPresence.js";
