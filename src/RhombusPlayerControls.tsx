import { useEffect, useState, type ReactNode } from "react";
import { formatClipDuration } from "./playerVodTime.js";
import type {
  RhombusBufferedStreamQuality,
  RhombusClipExportOptions,
  RhombusClipVisibility,
  RhombusConnectionMode,
  RhombusPlayerClassNames,
  RhombusPlayerControl,
  RhombusPlayerHandle,
  RhombusPlayerState,
  RhombusRealtimeStreamQuality,
  RhombusVideoFit,
} from "./types.js";

const VIDEO_FIT_OPTIONS: Array<{ value: RhombusVideoFit; label: string }> = [
  { value: "contain", label: "Aspect ratio" },
  { value: "cover", label: "Cropped" },
  { value: "fill", label: "Stretch" },
  { value: "auto", label: "Auto-size" },
];

const SPEEDS = [0.5, 1, 2, 4];

/**
 * Default control-bar styles, shipped as a zero-specificity `:where()` stylesheet injected once
 * at runtime. Because every selector sits inside `:where()` (specificity 0,0,0), ANY consumer
 * CSS targeting the `rhombus-player-*` classes overrides these defaults with no `!important` and
 * regardless of stylesheet load order. Dynamic states use `:disabled` / `[data-active]` /
 * `[data-disabled]` so they are overridable too.
 *
 * Layout mirrors the Rhombus Console camera-detail toolbar: a 3-column grid (`1fr auto 1fr`)
 * with view tools on the left, a centered transport cluster (rewind · play/pause · speed), and
 * time + Go-Live/LIVE + live-type on the right. The toolbar renders ABOVE the timeline (Console
 * order: transport bar, then scrubber).
 */
const STYLE_ID = "rhombus-player-controls-styles";
const CONTROLS_CSS = `
:where(.rhombus-player-controls){display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;padding:8px 12px;background:#111;color:#eee;font:13px system-ui,sans-serif;}
:where(.rhombus-player-group){display:flex;align-items:center;gap:8px;min-width:0;}
:where(.rhombus-player-group-left){justify-self:start;}
:where(.rhombus-player-group-center){justify-self:center;}
:where(.rhombus-player-group-right){justify-self:end;}
:where(.rhombus-player-btn){cursor:pointer;border:1px solid #3a3a3a;background:#1e1e1e;color:#eee;border-radius:6px;padding:5px 9px;font:inherit;line-height:1.2;display:inline-flex;align-items:center;justify-content:center;gap:5px;}
:where(.rhombus-player-btn:hover:not(:disabled)){background:#2a2a2a;}
:where(.rhombus-player-btn:disabled){opacity:.4;cursor:default;}
:where(.rhombus-player-btn[data-active="true"]){border-color:#3b82f6;color:#fff;}
:where(.rhombus-player-btn-icon){padding:6px;min-width:32px;}
:where(.rhombus-player-btn-play){padding:6px;min-width:38px;font-size:15px;}
:where(.rhombus-player-speed),:where(.rhombus-player-quality){cursor:pointer;border:1px solid #3a3a3a;background:#1e1e1e;color:#eee;border-radius:6px;padding:4px 6px;font:inherit;}
:where(.rhombus-player-speed-wrap){display:flex;align-items:center;gap:6px;}
:where(.rhombus-player-speed-wrap[data-disabled="true"]){opacity:.4;}
:where(.rhombus-player-zoom),:where(.rhombus-player-livetype){display:flex;align-items:center;gap:6px;}
:where(.rhombus-player-zoom-level){min-width:38px;text-align:center;font-variant-numeric:tabular-nums;}
:where(.rhombus-player-time){font-variant-numeric:tabular-nums;opacity:.8;white-space:nowrap;}
:where(.rhombus-player-live){display:inline-flex;align-items:center;gap:6px;color:#22c55e;font-weight:600;}
:where(.rhombus-player-live-dot){width:8px;height:8px;border-radius:50%;background:#22c55e;}
:where(.rhombus-player-clip){display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 12px 8px;background:#111;color:#eee;font:13px system-ui,sans-serif;}
:where(.rhombus-player-clip-status){opacity:.85;}
:where(.rhombus-player-clip-warning){color:#fbbf24;}
:where(.rhombus-player-clip-warning[data-blocking="true"]){color:#f87171;}
:where(.rhombus-player-clip-link){color:#7ab8ff;}
:where(.rhombus-player-clip-duration){opacity:.9;font-variant-numeric:tabular-nums;}
:where(.rhombus-player-clip-form){display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
:where(.rhombus-player-input){border:1px solid #3a3a3a;background:#1e1e1e;color:#eee;border-radius:6px;padding:4px 8px;font:inherit;min-width:140px;}
@media (max-width:680px){:where(.rhombus-player-controls){display:flex;flex-wrap:wrap;justify-content:center;}}
`;

function ensureStylesInjected() {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  // Keep content in sync (handles dev/HMR where the tag persists across reloads of this module).
  if (el.textContent !== CONTROLS_CSS) el.textContent = CONTROLS_CSS;
}

const cx = (...xs: Array<string | undefined | false>) => xs.filter(Boolean).join(" ");

type RhombusPlayerControlsProps = {
  api: RhombusPlayerHandle;
  state: RhombusPlayerState;
  controls?: RhombusPlayerControl[];
  classNames?: RhombusPlayerClassNames;
  renderControls?: (api: RhombusPlayerHandle, state: RhombusPlayerState) => ReactNode;
  showLiveTypeSwitcher: boolean;
  connectionMode: RhombusConnectionMode;
  realtimeQuality: RhombusRealtimeStreamQuality;
  bufferedQuality: RhombusBufferedStreamQuality;
  onChangeRealtimeQuality: (q: RhombusRealtimeStreamQuality) => void;
  onChangeBufferedQuality: (q: RhombusBufferedStreamQuality) => void;
  videoFit: RhombusVideoFit;
  onChangeVideoFit: (fit: RhombusVideoFit) => void;
  clipSelection: { startMs: number; endMs: number } | null;
  showClipOptionsForm: boolean;
  defaultClipVisibility: RhombusClipVisibility;
  /** Effective footage pre-check policy (`RhombusSaveClipConfig.requireFootage`, defaulted). */
  requireFootage: "any" | "full" | "off";
  /** Enter/exit clip mode (seeds/clears the selection). */
  onToggleClipSelection: () => void;
  /** Run the export with the collected options. */
  onExportClip: (options: RhombusClipExportOptions) => void;
  /** The date/time jump picker node (rendered in the right group when `"goToDate"` is shown). */
  dateTimePicker?: ReactNode;
  /** The Timeline node (rendered above the button row). */
  children?: ReactNode;
};

const VISIBILITY_OPTIONS: Array<{ value: RhombusClipVisibility; label: string }> = [
  { value: "ORG_WIDE", label: "Org-wide" },
  { value: "PRIVATE", label: "Private" },
  { value: "ROLE_RESTRICTED", label: "Role-restricted" },
];

function Btn({
  onClick,
  disabled,
  title,
  active,
  className,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cx("rhombus-player-btn", className)}
      data-active={active ? "true" : undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function fmtClock(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString();
}

export function RhombusPlayerControls(props: RhombusPlayerControlsProps) {
  const {
    api,
    state,
    controls,
    classNames,
    renderControls,
    showLiveTypeSwitcher,
    connectionMode,
    realtimeQuality,
    bufferedQuality,
    onChangeRealtimeQuality,
    onChangeBufferedQuality,
    videoFit,
    onChangeVideoFit,
    clipSelection,
    showClipOptionsForm,
    defaultClipVisibility,
    requireFootage,
    onToggleClipSelection,
    onExportClip,
    dateTimePicker,
    children,
  } = props;

  useEffect(() => {
    ensureStylesInjected();
  }, []);

  // Save-clip options form (revealed when the user clicks "Save clip" and the form is enabled).
  const [formOpen, setFormOpen] = useState(false);
  const [clipTitle, setClipTitle] = useState("");
  const [clipDescription, setClipDescription] = useState("");
  const [clipVisibility, setClipVisibility] = useState<RhombusClipVisibility>(defaultClipVisibility);
  // Reset the form whenever we leave clip mode.
  useEffect(() => {
    if (!clipSelection) {
      setFormOpen(false);
      setClipTitle("");
      setClipDescription("");
      setClipVisibility(defaultClipVisibility);
    }
  }, [clipSelection, defaultClipVisibility]);

  const show = (c: RhombusPlayerControl) => controls === undefined || controls.includes(c);
  const isLive = state.mode === "live";
  const btnCls = classNames?.button;
  const clipExporting =
    state.clipExport?.phase === "submitting" || state.clipExport?.phase === "rendering";
  // Footage coverage of the selection, when known. Unknown (`null`) must never warn or block —
  // the export-time pre-check in the player is the authoritative gate.
  const clipCoverage = state.clipSelectionCoverage;
  const footageWarning =
    clipCoverage && clipCoverage.coverageRatio < 1
      ? clipCoverage.coveredMs <= 0
        ? "No recorded footage in the selected range"
        : "Part of the selected range has no recorded footage"
      : null;
  const footageBlocked =
    !!clipCoverage &&
    requireFootage !== "off" &&
    (clipCoverage.coveredMs <= 0 ||
      (requireFootage === "full" && clipCoverage.coverageRatio < 1));

  const runExport = () => {
    onExportClip({
      title: clipTitle,
      description: clipDescription || undefined,
      visibility: clipVisibility,
    });
    setFormOpen(false);
  };
  const onSaveClipClick = () => {
    if (showClipOptionsForm) setFormOpen(true);
    else runExport();
  };

  if (renderControls) {
    return (
      <>
        {renderControls(api, state)}
        {children}
      </>
    );
  }

  const showLiveType = show("liveType") && showLiveTypeSwitcher;
  const showGoToDate = show("goToDate") && dateTimePicker != null;
  const hasLeft = show("zoom") || show("snapshot") || show("videoFit");
  const hasCenter = show("rewind") || show("play") || show("speed");
  const hasRight = show("goLive") || showLiveType || showGoToDate;
  const hasBar = hasLeft || hasCenter || hasRight;

  return (
    <>
      {hasBar && (
        <div className={cx("rhombus-player-controls", classNames?.controls)}>
          {/* LEFT — view tools */}
          <div className="rhombus-player-group rhombus-player-group-left">
            {show("zoom") && (
              <span className="rhombus-player-zoom">
                <Btn
                  className={cx("rhombus-player-btn-icon", btnCls)}
                  onClick={() => api.zoomOut()}
                  disabled={state.zoom <= 1}
                  title="Zoom out"
                >
                  −
                </Btn>
                <span className="rhombus-player-zoom-level">{state.zoom.toFixed(1)}×</span>
                <Btn
                  className={cx("rhombus-player-btn-icon", btnCls)}
                  onClick={() => api.zoomIn()}
                  title="Zoom in"
                >
                  ＋
                </Btn>
                {state.zoom > 1 && (
                  <Btn className={btnCls} onClick={() => api.resetZoom()} title="Reset zoom">
                    Reset
                  </Btn>
                )}
              </span>
            )}
            {show("snapshot") && (
              <Btn className={btnCls} onClick={() => void api.snapshot()} title="Snapshot">
                ◉ Snapshot
              </Btn>
            )}
            {show("videoFit") && (
              <select
                className="rhombus-player-quality"
                value={videoFit}
                title="Video display"
                aria-label="Video display"
                onChange={e => onChangeVideoFit(e.target.value as RhombusVideoFit)}
              >
                {VIDEO_FIT_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* CENTER — transport */}
          <div className="rhombus-player-group rhombus-player-group-center">
            {show("rewind") && (
              <Btn
                className={cx("rhombus-player-btn-icon", btnCls)}
                onClick={() => api.rewind()}
                title="Rewind"
              >
                ⟲
              </Btn>
            )}
            {show("play") && (
              <Btn
                className={cx("rhombus-player-btn-play", btnCls)}
                onClick={() => (state.playing ? api.pause() : api.play())}
                title={state.playing ? "Pause" : "Play"}
              >
                {state.playing ? "❚❚" : "▶"}
              </Btn>
            )}
            {show("speed") && (
              <label
                className="rhombus-player-speed-wrap"
                data-disabled={isLive ? "true" : undefined}
                title={isLive ? "Playback speed (VOD only)" : "Playback speed"}
              >
                <select
                  className={cx("rhombus-player-speed", classNames?.speed)}
                  value={state.playbackRate}
                  disabled={isLive}
                  onChange={e => api.setPlaybackRate(Number(e.target.value))}
                >
                  {SPEEDS.map(s => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/* RIGHT — date picker + time + live status + live-type */}
          <div className="rhombus-player-group rhombus-player-group-right">
            {showGoToDate && dateTimePicker}
            {show("goLive") && (
              <>
                {!isLive && <span className="rhombus-player-time">{fmtClock(state.currentWallClockMs)}</span>}
                {isLive ? (
                  <span className="rhombus-player-live">
                    <span className="rhombus-player-live-dot" />
                    Live
                  </span>
                ) : (
                  <Btn className={btnCls} onClick={() => api.goLive()} title="Go to live">
                    Go to live
                  </Btn>
                )}
              </>
            )}
            {showLiveType && isLive && (
              <span className={cx("rhombus-player-livetype", classNames?.liveType)}>
                <Btn
                  className={btnCls}
                  onClick={() => api.setLiveTransport("realtime")}
                  active={state.liveTransport === "realtime"}
                  title="Realtime — 0–1s latency, more CPU, may be lower resolution"
                >
                  Realtime
                </Btn>
                <Btn
                  className={btnCls}
                  onClick={() => api.setLiveTransport("buffered")}
                  active={state.liveTransport === "buffered"}
                  title="Buffered — 5–8s latency, less CPU, max resolution"
                >
                  Buffered
                </Btn>
                {state.liveTransport === "realtime" ? (
                  <select
                    className="rhombus-player-quality"
                    value={realtimeQuality}
                    onChange={e => onChangeRealtimeQuality(e.target.value as RhombusRealtimeStreamQuality)}
                  >
                    <option value="HD">HD</option>
                    <option value="SD">SD</option>
                  </select>
                ) : (
                  connectionMode === "wan" && (
                    <select
                      className="rhombus-player-quality"
                      value={bufferedQuality}
                      onChange={e =>
                        onChangeBufferedQuality(e.target.value as RhombusBufferedStreamQuality)
                      }
                    >
                      <option value="HIGH">High</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="LOW">Low</option>
                    </select>
                  )
                )}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Timeline scrubber sits below the toolbar (Console order). */}
      {children}

      {/* Clip toolbar — its own row beneath the timeline (mirrors Console's clip toolbar).
          Not in clip mode → "Create clip". In clip mode → duration + Save/Cancel (+ options form). */}
      {show("saveClip") && (
        <div className={cx("rhombus-player-clip", classNames?.clip)}>
          {!clipSelection ? (
            <Btn className={btnCls} onClick={onToggleClipSelection} title="Create a clip — drag the handles on the timeline">
              ✂ Create clip
            </Btn>
          ) : (
            <>
              <span className="rhombus-player-clip-duration">
                Duration: {formatClipDuration(clipSelection.endMs - clipSelection.startMs)}
              </span>

              {footageWarning && (
                <span className="rhombus-player-clip-warning" data-blocking={footageBlocked}>
                  ⚠ {footageWarning}
                </span>
              )}

              {formOpen ? (
                <span className="rhombus-player-clip-form">
                  <input
                    className="rhombus-player-input"
                    placeholder="Title (optional)"
                    value={clipTitle}
                    onChange={e => setClipTitle(e.target.value)}
                  />
                  <input
                    className="rhombus-player-input"
                    placeholder="Description (optional)"
                    value={clipDescription}
                    onChange={e => setClipDescription(e.target.value)}
                  />
                  <select
                    className="rhombus-player-quality"
                    value={clipVisibility}
                    title="Clip visibility"
                    onChange={e => setClipVisibility(e.target.value as RhombusClipVisibility)}
                  >
                    {VISIBILITY_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <Btn
                    className={btnCls}
                    onClick={runExport}
                    disabled={clipExporting || footageBlocked}
                    title={footageBlocked ? footageWarning ?? "No recorded footage" : "Create clip"}
                  >
                    Create
                  </Btn>
                  <Btn className={btnCls} onClick={() => setFormOpen(false)} title="Back">
                    Back
                  </Btn>
                </span>
              ) : (
                <>
                  {state.canSaveClip && (
                    <Btn
                      className={btnCls}
                      onClick={onSaveClipClick}
                      disabled={clipExporting || footageBlocked}
                      title={footageBlocked ? footageWarning ?? "No recorded footage" : "Save clip"}
                    >
                      Save clip
                    </Btn>
                  )}
                  <Btn className={btnCls} onClick={onToggleClipSelection} title="Cancel">
                    Cancel
                  </Btn>
                </>
              )}

              {state.clipExport && (
                <span className={cx("rhombus-player-clip-status", classNames?.clipStatus)}>
                  {state.clipExport.phase === "rendering"
                    ? `Rendering ${state.clipExport.percentComplete ?? 0}%`
                    : state.clipExport.phase === "complete"
                      ? "Ready"
                      : state.clipExport.phase === "error"
                        ? `Error: ${state.clipExport.error}`
                        : state.clipExport.phase}
                  {state.clipExport.phase === "complete" && state.clipExport.downloadUrl && (
                    <>
                      {" "}
                      <a
                        className="rhombus-player-clip-link"
                        href={state.clipExport.downloadUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Download
                      </a>
                    </>
                  )}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
