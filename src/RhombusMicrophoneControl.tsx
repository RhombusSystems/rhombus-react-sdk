import {
  useEffect,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type {
  RhombusTalkbackClassNames,
  RhombusTalkbackHandle,
  RhombusTalkbackState,
  RhombusTalkbackStyles,
} from "./types.js";

const STYLE_ID = "rhombus-microphone-control-styles";
const CONTROL_CSS = `
:where(.rhombus-microphone-control){display:inline-flex;align-items:center;gap:10px;color:#eef2ff;font:600 13px/1.25 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
:where(.rhombus-microphone-button){position:relative;display:grid;place-items:center;width:48px;height:48px;padding:0;border:1px solid rgba(148,163,184,.34);border-radius:999px;background:linear-gradient(145deg,#202b3f,#111827);color:#e2e8f0;box-shadow:0 8px 22px rgba(2,6,23,.28),inset 0 1px rgba(255,255,255,.08);cursor:pointer;transition:transform .14s ease,background .18s ease,border-color .18s ease,box-shadow .18s ease;}
:where(.rhombus-microphone-button:hover:not(:disabled)){transform:translateY(-1px);border-color:#7dd3fc;background:linear-gradient(145deg,#253955,#16243a);}
:where(.rhombus-microphone-button:focus-visible){outline:3px solid rgba(56,189,248,.38);outline-offset:3px;}
:where(.rhombus-microphone-button:disabled){cursor:not-allowed;opacity:.48;filter:saturate(.55);}
:where(.rhombus-microphone-button[data-state="talking"]){border-color:#fb7185;background:linear-gradient(145deg,#e11d48,#9f1239);color:#fff;box-shadow:0 0 0 5px rgba(244,63,94,.15),0 10px 28px rgba(159,18,57,.38);}
:where(.rhombus-microphone-button[data-state="connecting"]),
:where(.rhombus-microphone-button[data-state="requesting-permission"]),
:where(.rhombus-microphone-button[data-state="reconnecting"]){border-color:#fbbf24;background:linear-gradient(145deg,#92400e,#451a03);color:#fef3c7;}
:where(.rhombus-microphone-icon){display:grid;place-items:center;width:22px;height:22px;}
:where(.rhombus-microphone-icon svg){display:block;width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;}
:where(.rhombus-microphone-content){display:grid;gap:2px;min-width:104px;}
:where(.rhombus-microphone-label){color:inherit;}
:where(.rhombus-microphone-status){color:#94a3b8;font-size:11px;font-weight:500;}
@media (prefers-reduced-motion:reduce){:where(.rhombus-microphone-button){transition:none;}}
`;

export type RhombusMicrophoneControlProps = {
  api: RhombusTalkbackHandle;
  state: RhombusTalkbackState;
  classNames?: RhombusTalkbackClassNames;
  styles?: RhombusTalkbackStyles;
  /** Extra native button props. SDK interaction handlers and state attributes take precedence. */
  buttonProps?: Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    | "onClick"
    | "onPointerDown"
    | "onPointerUp"
    | "onPointerCancel"
    | "onPointerLeave"
    | "onKeyDown"
    | "onKeyUp"
    | "onBlur"
    | "disabled"
    | "style"
    | "className"
  >;
};

/** Default accessible microphone control for {@link RhombusTalkback}. */
export function RhombusMicrophoneControl({
  api,
  state,
  classNames,
  styles,
  buttonProps,
}: RhombusMicrophoneControlProps) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== CONTROL_CSS) style.textContent = CONTROL_CSS;
  }, []);

  const hold = state.interactionMode === "hold";
  const busy =
    state.status === "requesting-permission" ||
    state.status === "connecting" ||
    state.status === "reconnecting";
  const disabled = !state.canTalk && !state.talking && !busy;

  const start = () => {
    void api.startTalking();
  };
  const stop = () => {
    api.stopTalking();
  };
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!hold || disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start();
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (!hold) return;
    event.preventDefault();
    stop();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!hold || event.repeat || (event.key !== " " && event.key !== "Enter")) {
      return;
    }
    event.preventDefault();
    start();
  };
  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!hold || (event.key !== " " && event.key !== "Enter")) return;
    event.preventDefault();
    stop();
  };

  const label = getLabel(state);
  const status = getStatusLabel(state);
  const title = getTitle(state);

  return (
    <div
      className={cx("rhombus-microphone-control", classNames?.root)}
      style={styles?.root}
      data-rhombus-talkback-mode={state.interactionMode}
    >
      <button
        {...buttonProps}
        type="button"
        className={cx("rhombus-microphone-button", classNames?.button)}
        style={styles?.button}
        data-state={state.status}
        disabled={disabled}
        aria-label={label}
        aria-pressed={state.interactionMode === "toggle" ? state.talking : undefined}
        title={title}
        onClick={
          hold || disabled
            ? undefined
            : () => {
                void api.toggleTalking();
              }
        }
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={stop}
        onPointerLeave={hold ? stop : undefined}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={stop}
      >
        <span
          className={cx("rhombus-microphone-icon", classNames?.icon)}
          style={styles?.icon}
          aria-hidden
        >
          <MicrophoneIcon blocked={disabled} />
        </span>
      </button>
      <span
        className={cx("rhombus-microphone-content", classNames?.content)}
        style={styles?.content}
      >
        <span
          className={cx("rhombus-microphone-label", classNames?.label)}
          style={styles?.label}
        >
          {label}
        </span>
        <span
          className={cx("rhombus-microphone-status", classNames?.status)}
          style={styles?.status}
          aria-live="polite"
        >
          {status}
        </span>
      </span>
    </div>
  );
}

function MicrophoneIcon({ blocked }: { blocked: boolean }) {
  return (
    <svg viewBox="0 0 24 24">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" />
      {blocked ? <path d="m4 4 16 16" /> : null}
    </svg>
  );
}

function getLabel(state: RhombusTalkbackState): string {
  if (state.status === "requesting-permission") return "Requesting microphone";
  if (state.status === "connecting") return "Connecting microphone";
  if (state.status === "reconnecting") return "Reconnecting microphone";
  if (state.talking) {
    return state.interactionMode === "toggle"
      ? "Click to end talk"
      : "Talking";
  }
  if (!state.canTalk) return "Talk unavailable";
  return state.interactionMode === "toggle"
    ? "Click to talk"
    : "Hold to talk";
}

function getStatusLabel(state: RhombusTalkbackState): string {
  if (state.status === "loading-capability") return "Checking access…";
  if (state.status === "requesting-permission") return "Allow browser access";
  if (state.status === "connecting") return "Opening secure audio…";
  if (state.status === "reconnecting") return "Connection interrupted";
  if (state.status === "talking") return "Live at the device";
  if (state.status === "error") return "Talkback error";
  if (state.blockedReason === "vod") return "Unavailable while viewing history";
  if (state.blockedReason === "not-authorized") return "Role lacks device access";
  if (state.blockedReason === "license-required") return "Enterprise license required";
  if (state.blockedReason === "speaker-disabled") return "Device speaker disabled";
  if (state.blockedReason === "device-unavailable") return "Device unavailable";
  if (state.blockedReason === "disabled") return "Disabled";
  if (state.blockedReason === "capability-unavailable") {
    return "Capability unavailable";
  }
  return state.interactionMode === "toggle"
    ? "Tap once to begin"
    : "Release to stop";
}

function getTitle(state: RhombusTalkbackState): string {
  if (state.blockedReason === "vod") {
    return "Talkback is disabled while viewing historical footage";
  }
  return `${getLabel(state)} — ${getStatusLabel(state)}`;
}

function cx(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}
