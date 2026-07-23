import { useEffect, type ReactNode } from "react";
import type {
  RhombusAudioPlayerClassNames,
  RhombusAudioPlayerControl,
  RhombusAudioPlayerHandle,
  RhombusAudioPlayerState,
} from "./types.js";

const SPEEDS = [0.5, 1, 2, 4];
const STYLE_ID = "rhombus-audio-player-controls-styles";
const CONTROLS_CSS = `
:where(.rhombus-audio-controls){display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;background:#111;color:#eee;font:13px system-ui,sans-serif;}
:where(.rhombus-audio-btn){cursor:pointer;border:1px solid #3a3a3a;background:#1e1e1e;color:#eee;border-radius:6px;padding:5px 9px;font:inherit;line-height:1.2;}
:where(.rhombus-audio-btn:hover:not(:disabled)){background:#2a2a2a;}
:where(.rhombus-audio-btn:disabled){opacity:.4;cursor:default;}
:where(.rhombus-audio-speed){cursor:pointer;border:1px solid #3a3a3a;background:#1e1e1e;color:#eee;border-radius:6px;padding:4px 6px;font:inherit;}
:where(.rhombus-audio-volume){display:flex;align-items:center;gap:6px;}
:where(.rhombus-audio-volume input){accent-color:#3b82f6;width:100px;}
:where(.rhombus-audio-status){margin-left:auto;opacity:.8;font-variant-numeric:tabular-nums;}
`;

export type RhombusAudioPlayerControlsProps = {
  api: RhombusAudioPlayerHandle;
  state: RhombusAudioPlayerState;
  controls?: RhombusAudioPlayerControl[];
  classNames?: RhombusAudioPlayerClassNames;
  renderControls?: (
    api: RhombusAudioPlayerHandle,
    state: RhombusAudioPlayerState
  ) => ReactNode;
  children?: ReactNode;
};

export function RhombusAudioPlayerControls({
  api,
  state,
  controls,
  classNames,
  renderControls,
  children,
}: RhombusAudioPlayerControlsProps) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== CONTROLS_CSS) style.textContent = CONTROLS_CSS;
  }, []);

  if (renderControls) {
    return (
      <>
        {renderControls(api, state)}
        {children}
      </>
    );
  }

  const show = (control: RhombusAudioPlayerControl) =>
    controls === undefined || controls.includes(control);
  const buttonClass = cx("rhombus-audio-btn", classNames?.button);
  const hasBar =
    show("play") ||
    show("rewind") ||
    show("goLive") ||
    show("speed") ||
    show("volume");

  return (
    <>
      {hasBar && (
        <div
          className={cx("rhombus-audio-controls", classNames?.controls)}
          role="group"
          aria-label="Audio playback controls"
        >
          {show("rewind") && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => api.rewind()}
              title="Rewind"
            >
              ↶ 15s
            </button>
          )}
          {show("play") && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => (state.playing ? api.pause() : api.play())}
              aria-label={state.playing ? "Pause audio" : "Play audio"}
            >
              {state.playing ? "Pause" : "Play"}
            </button>
          )}
          {show("goLive") && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => api.goLive()}
              disabled={state.mode === "live"}
            >
              {state.mode === "live" ? "LIVE" : "Go Live"}
            </button>
          )}
          {show("speed") && (
            <select
              className={cx("rhombus-audio-speed", classNames?.speed)}
              aria-label="Audio playback speed"
              value={state.playbackRate}
              disabled={state.mode === "live"}
              onChange={event => api.setPlaybackRate(Number(event.target.value))}
            >
              {SPEEDS.map(speed => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
          )}
          {show("volume") && (
            <div className={cx("rhombus-audio-volume", classNames?.volume)}>
              <button
                type="button"
                className={buttonClass}
                onClick={() => api.setMuted(!state.muted)}
                aria-label={state.muted ? "Unmute audio" : "Mute audio"}
              >
                {state.muted ? "Unmute" : "Mute"}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={state.volume}
                aria-label="Audio volume"
                onChange={event => api.setVolume(Number(event.target.value))}
              />
            </div>
          )}
          <span className={cx("rhombus-audio-status", classNames?.status)}>
            {state.status === "ready"
              ? new Date(state.currentWallClockMs ?? Date.now()).toLocaleTimeString()
              : state.status}
          </span>
        </div>
      )}
      {children}
    </>
  );
}

function cx(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}
