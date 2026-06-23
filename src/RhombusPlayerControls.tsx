import { useEffect, type ReactNode } from "react";
import type {
  RhombusBufferedStreamQuality,
  RhombusConnectionMode,
  RhombusPlayerClassNames,
  RhombusPlayerControl,
  RhombusPlayerHandle,
  RhombusPlayerState,
  RhombusRealtimeStreamQuality,
} from "./types.js";

const SPEEDS = [0.5, 1, 2, 4];

/**
 * Default control-bar styles, shipped as a zero-specificity `:where()` stylesheet injected once
 * at runtime. Because every selector sits inside `:where()` (specificity 0,0,0), ANY consumer
 * CSS targeting the `rhombus-player-*` classes overrides these defaults with no `!important` and
 * regardless of stylesheet load order. Dynamic states use `:disabled` / `[data-active]` /
 * `[data-disabled]` so they are overridable too.
 */
const STYLE_ID = "rhombus-player-controls-styles";
const CONTROLS_CSS = `
:where(.rhombus-player-controls){display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;background:#111;color:#eee;font:13px system-ui,sans-serif;}
:where(.rhombus-player-btn){cursor:pointer;border:1px solid #444;background:#1e1e1e;color:#eee;border-radius:4px;padding:4px 8px;font:inherit;line-height:1.2;}
:where(.rhombus-player-btn:disabled){opacity:.4;cursor:default;}
:where(.rhombus-player-btn[data-active="true"]){border-color:#3b82f6;}
:where(.rhombus-player-speed),:where(.rhombus-player-quality){cursor:pointer;border:1px solid #444;background:#1e1e1e;color:#eee;border-radius:4px;padding:3px 4px;font:inherit;}
:where(.rhombus-player-speed-wrap){display:flex;align-items:center;gap:4px;}
:where(.rhombus-player-speed-wrap[data-disabled="true"]){opacity:.4;}
:where(.rhombus-player-zoom),:where(.rhombus-player-livetype),:where(.rhombus-player-clip){display:flex;align-items:center;gap:4px;}
:where(.rhombus-player-clip){margin-left:auto;}
:where(.rhombus-player-zoom-level){min-width:34px;text-align:center;}
:where(.rhombus-player-clip-status){opacity:.85;}
:where(.rhombus-player-clip-link){color:#7ab8ff;}
`;

function ensureStylesInjected() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CONTROLS_CSS;
  document.head.appendChild(el);
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
  clipRange: { startMs: number | null; endMs: number | null };
  onSetClipStart: () => void;
  onSetClipEnd: () => void;
  onClearClip: () => void;
  onExportClip: () => void;
  /** The Timeline node (rendered above the button row). */
  children?: ReactNode;
};

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
    clipRange,
    onSetClipStart,
    onSetClipEnd,
    onClearClip,
    onExportClip,
    children,
  } = props;

  useEffect(() => {
    ensureStylesInjected();
  }, []);

  const show = (c: RhombusPlayerControl) => controls === undefined || controls.includes(c);
  const isLive = state.mode === "live";

  if (renderControls) {
    return (
      <>
        {children}
        {renderControls(api, state)}
      </>
    );
  }

  const anyButtons =
    show("play") ||
    show("goLive") ||
    show("rewind") ||
    show("speed") ||
    show("zoom") ||
    show("snapshot") ||
    show("saveClip") ||
    (show("liveType") && showLiveTypeSwitcher);

  return (
    <>
      {children}
      {anyButtons && (
        <div className={cx("rhombus-player-controls", classNames?.controls)}>
          {show("play") && (
            <Btn
              className={classNames?.button}
              onClick={() => (state.playing ? api.pause() : api.play())}
              title={state.playing ? "Pause" : "Play"}
            >
              {state.playing ? "❚❚" : "▶"}
            </Btn>
          )}

          {show("goLive") && (
            <Btn
              className={classNames?.button}
              onClick={() => api.goLive()}
              disabled={isLive}
              active={isLive}
              title="Go to live"
            >
              {isLive ? "● LIVE" : "Go live"}
            </Btn>
          )}

          {show("rewind") && (
            <Btn className={classNames?.button} onClick={() => api.rewind()} title="Rewind">
              « Rewind
            </Btn>
          )}

          {show("speed") && (
            <label className="rhombus-player-speed-wrap" data-disabled={isLive ? "true" : undefined}>
              <span>Speed</span>
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

          {show("zoom") && (
            <span className="rhombus-player-zoom">
              <Btn
                className={classNames?.button}
                onClick={() => api.zoomOut()}
                disabled={state.zoom <= 1}
                title="Zoom out"
              >
                −
              </Btn>
              <span className="rhombus-player-zoom-level">{state.zoom.toFixed(1)}×</span>
              <Btn className={classNames?.button} onClick={() => api.zoomIn()} title="Zoom in">
                ＋
              </Btn>
              {state.zoom > 1 && (
                <Btn className={classNames?.button} onClick={() => api.resetZoom()} title="Reset zoom">
                  Reset
                </Btn>
              )}
            </span>
          )}

          {show("snapshot") && (
            <Btn className={classNames?.button} onClick={() => void api.snapshot()} title="Snapshot">
              ◎ Snapshot
            </Btn>
          )}

          {show("liveType") && showLiveTypeSwitcher && (
            <span className={cx("rhombus-player-livetype", classNames?.liveType)}>
              <Btn
                className={classNames?.button}
                onClick={() => api.setLiveTransport("realtime")}
                active={state.liveTransport === "realtime"}
                title="Realtime — 0–1s latency, more CPU, may be lower resolution"
              >
                Realtime
              </Btn>
              <Btn
                className={classNames?.button}
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

          {show("saveClip") && (
            <span className={cx("rhombus-player-clip", classNames?.clip)}>
              <Btn className={classNames?.button} onClick={onSetClipStart} title="Set clip start to current time">
                ⟦ Start: {fmtClock(clipRange.startMs)}
              </Btn>
              <Btn className={classNames?.button} onClick={onSetClipEnd} title="Set clip end to current time">
                End: {fmtClock(clipRange.endMs)} ⟧
              </Btn>
              {clipRange.startMs != null && clipRange.endMs != null && (
                <Btn className={classNames?.button} onClick={onClearClip} title="Clear selection">
                  ✕
                </Btn>
              )}
              {state.canSaveClip && (
                <Btn
                  className={classNames?.button}
                  onClick={onExportClip}
                  disabled={
                    clipRange.startMs == null ||
                    clipRange.endMs == null ||
                    state.clipExport?.phase === "submitting" ||
                    state.clipExport?.phase === "rendering"
                  }
                  title="Export clip"
                >
                  Save clip
                </Btn>
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
            </span>
          )}
        </div>
      )}
    </>
  );
}
