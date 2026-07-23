import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FOOTAGE_LIVE_GRACE_MS, fetchPresenceWindows } from "./rhombusPresence.js";
import type { RhombusFootageAvailability, RhombusPlayerPaths } from "./types.js";

/**
 * Default styles for the date/time picker, injected once and wrapped in `:where()` so any
 * consumer CSS targeting the `rhombus-datepicker-*` classes overrides them with no
 * `!important` (same pattern as the control bar).
 */
const STYLE_ID = "rhombus-datepicker-styles";
const PICKER_CSS = `
:where(.rhombus-datepicker){position:relative;display:inline-block;font:13px system-ui,sans-serif;color:#eee;}
:where(.rhombus-datepicker-anchor){cursor:pointer;border:1px solid #3a3a3a;background:#1e1e1e;color:#eee;border-radius:6px;padding:5px 9px;font:inherit;line-height:1.2;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}
:where(.rhombus-datepicker-anchor:hover:not(:disabled)){background:#2a2a2a;}
:where(.rhombus-datepicker-anchor:disabled){opacity:.4;cursor:default;}
:where(.rhombus-datepicker-popover){position:absolute;z-index:30;background:#191a1c;border:1px solid #3a3a3a;border-radius:8px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:232px;}
:where(.rhombus-datepicker-popover[data-direction="down"]){top:calc(100% + 6px);left:0;}
:where(.rhombus-datepicker-popover[data-direction="up"]){bottom:calc(100% + 6px);left:0;}
:where(.rhombus-datepicker-header){display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:8px;}
:where(.rhombus-datepicker-month){font-weight:600;}
:where(.rhombus-datepicker-nav){cursor:pointer;border:1px solid #3a3a3a;background:#1e1e1e;color:#eee;border-radius:6px;width:26px;height:26px;font:inherit;line-height:1;}
:where(.rhombus-datepicker-nav:hover:not(:disabled)){background:#2a2a2a;}
:where(.rhombus-datepicker-nav:disabled){opacity:.35;cursor:default;}
:where(.rhombus-datepicker-grid){display:grid;grid-template-columns:repeat(7,1fr);gap:2px;}
:where(.rhombus-datepicker-weekday){text-align:center;opacity:.55;font-size:11px;padding:2px 0;}
:where(.rhombus-datepicker-day){cursor:pointer;border:1px solid transparent;background:none;color:#eee;border-radius:6px;padding:4px 0;font:inherit;text-align:center;}
:where(.rhombus-datepicker-day:hover:not(:disabled)){background:#2a2a2a;}
:where(.rhombus-datepicker-day:disabled){opacity:.3;cursor:default;}
:where(.rhombus-datepicker-day[data-nofootage="true"]){text-decoration:line-through;}
:where(.rhombus-datepicker-day[data-today="true"]){border-color:#3a3a3a;}
:where(.rhombus-datepicker-day[data-selected="true"]){background:#3b82f6;color:#fff;}
:where(.rhombus-datepicker-footer){display:flex;align-items:center;gap:6px;margin-top:8px;}
:where(.rhombus-datepicker-time){border:1px solid #3a3a3a;background:#1e1e1e;color:#eee;border-radius:6px;padding:4px 6px;font:inherit;flex:1 1 auto;min-width:0;color-scheme:dark;}
:where(.rhombus-datepicker-go){cursor:pointer;border:1px solid #3a3a3a;background:#1e1e1e;color:#eee;border-radius:6px;padding:4px 10px;font:inherit;}
:where(.rhombus-datepicker-go:hover){background:#2a2a2a;}
:where(.rhombus-datepicker-hint){margin-top:6px;font-size:11px;opacity:.55;}
`;

function ensureStylesInjected() {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== PICKER_CSS) el.textContent = PICKER_CSS;
}

const cx = (...xs: Array<string | undefined | false>) => xs.filter(Boolean).join(" ");

/** Per-slot class names appended to the picker's own `rhombus-datepicker-*` classes. */
export type RhombusDateTimePickerClassNames = {
  /** The anchor button (`rhombus-datepicker-anchor`). */
  anchor?: string;
  /** The popover panel (`rhombus-datepicker-popover`). */
  popover?: string;
};

/** Props for {@link RhombusDateTimePicker}. */
export type RhombusDateTimePickerProps = {
  /** Selected timestamp (epoch ms). `null` renders a placeholder anchor. */
  value: number | null;
  /** Called with the committed timestamp (epoch ms) — wire to `player.seekTo`. */
  onChange: (wallClockMs: number) => void;
  /**
   * Camera whose footage coverage disables no-footage days in the calendar (via
   * `/camera/getPresenceWindows`, one fetch per viewed month, cached). Omit — or set
   * `disableFootageCheck` — for a plain calendar.
   */
  cameraUuid?: string;
  /** Proxy base URL for the presence fetch (same semantics as the players). */
  apiOverrideBaseUrl?: string;
  /** Rhombus REST API base for direct mode. */
  rhombusApiBaseUrl?: string;
  /** Route overrides (`paths.presenceWindows`). */
  paths?: RhombusPlayerPaths;
  federatedSessionToken?: string;
  headers?: HeadersInit;
  getRequestHeaders?: () => HeadersInit | Promise<HeadersInit>;
  /** Skip the footage check even when `cameraUuid` is provided. */
  disableFootageCheck?: boolean;
  /** Earliest selectable time (e.g. the retention floor). Days fully before it are disabled. */
  minTimeMs?: number | null;
  /** Latest selectable time. Default: now (future days are disabled). */
  maxTimeMs?: number | null;
  /** Which way the popover opens relative to the anchor. Default `"down"` (`"up"` suits bottom toolbars). */
  direction?: "up" | "down";
  /** Called when a presence fetch fails (the calendar then simply doesn't disable footage-less days). */
  onError?: (error: Error) => void;
  disabled?: boolean;
  className?: string;
  classNames?: RhombusDateTimePickerClassNames;
  style?: CSSProperties;
};

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function monthKey(year: number, month: number): string {
  return `${year}-${month}`;
}

/** "HH:MM:SS" (local) for a native `<input type="time">`. */
function toTimeInputValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtAnchorLabel(ms: number | null): string {
  if (ms == null) return "Go to date…";
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

const WEEKDAY_LABELS = (() => {
  // Sunday-first, matching the JS Date.getDay() grid below.
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
  // 2024-09-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 8, 1 + i)));
})();

/**
 * A dependency-free date + time picker for jumping a player to a specific moment — the SDK
 * counterpart of the Rhombus Console's toolbar date picker. Renders a compact anchor button
 * showing the current value; clicking opens a calendar + time-of-day popover. Committing (day
 * click, Enter in the time field, or the Go button) calls `onChange` with the epoch-ms
 * timestamp — wire that to `player.seekTo(ms)`, or use the built-in `"goToDate"` control on
 * `RhombusPlayer`, which does exactly that.
 *
 * When given a `cameraUuid` (+ the usual auth props), days with **no recorded footage** are
 * struck through and disabled, backed by `/camera/getPresenceWindows` (one fetch per viewed
 * month, cached; fetch failures simply leave days enabled). All calendar math is in the
 * viewer's local time zone, consistent with the Timeline.
 */
export function RhombusDateTimePicker({
  value,
  onChange,
  cameraUuid,
  apiOverrideBaseUrl,
  rhombusApiBaseUrl,
  paths,
  federatedSessionToken,
  headers,
  getRequestHeaders,
  disableFootageCheck = false,
  minTimeMs = null,
  maxTimeMs = null,
  direction = "down",
  onError,
  disabled,
  className,
  classNames,
  style,
}: RhombusDateTimePickerProps) {
  useEffect(() => {
    ensureStylesInjected();
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // While open, edits accumulate in `pendingMs` (seeded from `value`); the live value keeps
  // advancing underneath without yanking the calendar/time field around.
  const [pendingMs, setPendingMs] = useState<number>(() => value ?? Date.now());
  // The month shown in the grid: [year, monthIndex].
  const [viewYm, setViewYm] = useState<[number, number]>(() => {
    const d = new Date(value ?? Date.now());
    return [d.getFullYear(), d.getMonth()];
  });

  const openPicker = useCallback(() => {
    const seed = value ?? Date.now();
    setPendingMs(seed);
    const d = new Date(seed);
    setViewYm([d.getFullYear(), d.getMonth()]);
    setOpen(true);
  }, [value]);

  // Close on outside pointerdown or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // ---- footage coverage per viewed month (cache: monthKey → availability | "error") ----
  const footageCheckEnabled = !disableFootageCheck && !!cameraUuid;
  const monthCacheRef = useRef(new Map<string, RhombusFootageAvailability | "error">());
  const [monthCacheVersion, setMonthCacheVersion] = useState(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Reset the cache when the camera (or auth target) changes.
  useEffect(() => {
    monthCacheRef.current.clear();
    setMonthCacheVersion(v => v + 1);
  }, [cameraUuid, apiOverrideBaseUrl, rhombusApiBaseUrl, federatedSessionToken]);

  const [viewYear, viewMonth] = viewYm;
  useEffect(() => {
    if (!open || !footageCheckEnabled || !cameraUuid) return;
    const key = monthKey(viewYear, viewMonth);
    if (monthCacheRef.current.has(key)) return;
    const monthStartMs = new Date(viewYear, viewMonth, 1).getTime();
    const monthEndMs = new Date(viewYear, viewMonth + 1, 1).getTime();
    if (monthStartMs > Date.now()) return; // fully-future month: nothing to fetch
    let cancelled = false;
    void (async () => {
      try {
        const availability = await fetchPresenceWindows({
          apiOverrideBaseUrl,
          rhombusApiBaseUrl,
          presenceWindowsPath: paths?.presenceWindows,
          federatedSessionToken,
          headers,
          getRequestHeaders,
          cameraUuid,
          startTimeSec: monthStartMs / 1000,
          durationSec: (monthEndMs - monthStartMs) / 1000,
        });
        if (cancelled) return;
        monthCacheRef.current.set(key, availability);
        setMonthCacheVersion(v => v + 1);
      } catch (e) {
        if (cancelled) return;
        monthCacheRef.current.set(key, "error"); // fail open, don't refetch in a loop
        setMonthCacheVersion(v => v + 1);
        onErrorRef.current?.(e instanceof Error ? e : new Error(String(e)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    footageCheckEnabled,
    cameraUuid,
    apiOverrideBaseUrl,
    rhombusApiBaseUrl,
    paths?.presenceWindows,
    federatedSessionToken,
    headers,
    getRequestHeaders,
    viewYear,
    viewMonth,
  ]);

  // ---- calendar grid model ----
  const now = Date.now();
  const maxMs = maxTimeMs ?? now;
  const grid = useMemo(() => {
    const availability = monthCacheRef.current.get(monthKey(viewYear, viewMonth));
    const windows = availability && availability !== "error" ? availability.windows : null;
    const firstDay = new Date(viewYear, viewMonth, 1);
    const leading = firstDay.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const selectedDayStart = startOfLocalDay(pendingMs);
    const todayStart = startOfLocalDay(now);

    return Array.from({ length: daysInMonth }, (_, i) => {
      const dayStart = new Date(viewYear, viewMonth, i + 1).getTime();
      const dayEnd = new Date(viewYear, viewMonth, i + 2).getTime();
      const outOfRange =
        dayStart > maxMs || (minTimeMs != null && dayEnd <= minTimeMs);
      // A day is confirmed footage-less only when coverage for its month is loaded, no window
      // overlaps it, and the whole day is comfortably in the past (grace for ingest lag).
      const noFootage =
        !!windows &&
        dayEnd < now - FOOTAGE_LIVE_GRACE_MS &&
        !windows.some(w => w.endMs > dayStart && w.startMs < dayEnd);
      return {
        day: i + 1,
        disabled: outOfRange || noFootage,
        noFootage,
        selected: dayStart === selectedDayStart,
        today: dayStart === todayStart,
      };
    }).map((cell, i) => ({ ...cell, gridColumnStart: i === 0 ? leading + 1 : undefined }));
    // monthCacheVersion invalidates this memo when a presence fetch lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewYear, viewMonth, pendingMs, minTimeMs, maxMs, now, monthCacheVersion]);

  // ---- commit paths ----
  const commit = useCallback(
    (ms: number) => {
      onChange(Math.min(ms, Date.now()));
      setOpen(false);
    },
    [onChange]
  );

  const onDayClick = useCallback(
    (day: number) => {
      const t = new Date(pendingMs);
      const merged = new Date(
        viewYear,
        viewMonth,
        day,
        t.getHours(),
        t.getMinutes(),
        t.getSeconds()
      ).getTime();
      setPendingMs(merged);
      commit(merged);
    },
    [commit, pendingMs, viewYear, viewMonth]
  );

  const onTimeChange = useCallback(
    (timeValue: string) => {
      const [h = 0, m = 0, s = 0] = timeValue.split(":").map(n => Number.parseInt(n, 10) || 0);
      const d = new Date(pendingMs);
      d.setHours(h, m, s, 0);
      setPendingMs(d.getTime());
    },
    [pendingMs]
  );

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString([], {
    month: "long",
    year: "numeric",
  });
  const nextMonthStartMs = new Date(viewYear, viewMonth + 1, 1).getTime();
  const canGoNext = nextMonthStartMs <= maxMs;
  const canGoPrev =
    minTimeMs == null || new Date(viewYear, viewMonth, 1).getTime() > minTimeMs;

  return (
    <div ref={containerRef} className={cx("rhombus-datepicker", className)} style={style}>
      <button
        type="button"
        className={cx("rhombus-datepicker-anchor", classNames?.anchor)}
        onClick={() => (open ? setOpen(false) : openPicker())}
        disabled={disabled}
        title="Go to date/time"
      >
        <span aria-hidden="true">📅</span>
        {fmtAnchorLabel(open ? pendingMs : value)}
      </button>

      {open && (
        <div
          className={cx("rhombus-datepicker-popover", classNames?.popover)}
          data-direction={direction}
        >
          <div className="rhombus-datepicker-header">
            <button
              type="button"
              className="rhombus-datepicker-nav"
              onClick={() => setViewYm(([y, m]) => (m === 0 ? [y - 1, 11] : [y, m - 1]))}
              disabled={!canGoPrev}
              title="Previous month"
            >
              ‹
            </button>
            <span className="rhombus-datepicker-month">{monthLabel}</span>
            <button
              type="button"
              className="rhombus-datepicker-nav"
              onClick={() => setViewYm(([y, m]) => (m === 11 ? [y + 1, 0] : [y, m + 1]))}
              disabled={!canGoNext}
              title="Next month"
            >
              ›
            </button>
          </div>

          <div className="rhombus-datepicker-grid">
            {WEEKDAY_LABELS.map((wd, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <span key={`wd-${i}`} className="rhombus-datepicker-weekday">
                {wd}
              </span>
            ))}
            {grid.map(cell => (
              <button
                key={cell.day}
                type="button"
                className="rhombus-datepicker-day"
                style={cell.gridColumnStart ? { gridColumnStart: cell.gridColumnStart } : undefined}
                disabled={cell.disabled}
                data-selected={cell.selected}
                data-today={cell.today}
                data-nofootage={cell.noFootage}
                title={cell.noFootage ? "No recorded footage on this day" : undefined}
                onClick={() => onDayClick(cell.day)}
              >
                {cell.day}
              </button>
            ))}
          </div>

          <div className="rhombus-datepicker-footer">
            <input
              className="rhombus-datepicker-time"
              type="time"
              step={1}
              value={toTimeInputValue(pendingMs)}
              onChange={e => onTimeChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") commit(pendingMs);
              }}
            />
            <button
              type="button"
              className="rhombus-datepicker-go"
              onClick={() => commit(pendingMs)}
              title="Jump to the selected date and time"
            >
              Go
            </button>
          </div>

          {footageCheckEnabled && (
            <div className="rhombus-datepicker-hint">Struck-through days have no footage.</div>
          )}
        </div>
      )}
    </div>
  );
}
