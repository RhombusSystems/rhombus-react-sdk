# Rhombus React SDK — `@rhombussystems/react`

React + TypeScript components for embedding **Rhombus camera video** in your own app. The
SDK streams over two transports — **MPEG-DASH** (Dash.js) and **low-latency H.264 over
WebSocket** (WebCodecs) — and ships a **unified drop-in player** that combines them with a
full set of player controls.

Your Rhombus **API key never ships to the browser**. Everything is built around short-lived
**federated session tokens** minted by your backend (see [Authentication](#authentication--tokens)).

> **Version:** this guide tracks `@rhombussystems/react` **2.0.0**. React **18+**.

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Choosing a component](#choosing-a-component)
- [`RhombusPlayer` — the unified player](#rhombusplayer--the-unified-player)
  - [How Live ⇄ VOD switching works](#how-live--vod-switching-works)
  - [Props](#rhombusplayer-props)
  - [Imperative handle (`ref`)](#imperative-handle-ref)
  - [Observable state](#observable-state)
  - [Choosing which controls render](#choosing-which-controls-render)
  - [Go to date (picker)](#go-to-date-gotodate-control--rhombusdatetimepicker)
  - [Styling the controls](#styling-the-controls)
  - [Snapshots](#snapshots)
  - [Save Clip](#save-clip)
  - [Timeline configuration](#timeline-configuration)
  - [Recipes](#rhombusplayer-recipes)
- [`RhombusBufferedPlayer` — DASH live & VOD](#rhombusbufferedplayer--dash-live--vod)
- [`RhombusRealtimePlayer` — low-latency live](#rhombusrealtimeplayer--low-latency-live)
- [`Timeline` — standalone scrubber](#timeline--standalone-scrubber)
- [Authentication & tokens](#authentication--tokens)
- [WAN vs LAN](#wan-vs-lan)
- [Stream quality](#stream-quality)
- [Auto-recovery / reconnect](#auto-recovery--reconnect)
- [Backend contract](#backend-contract)
- [Exported API surface](#exported-api-surface)
- [Browser support](#browser-support)
- [Troubleshooting](#troubleshooting)
- [Migrating from 1.x → 2.0](#migrating-from-1x--20)
- [License](#license)

---

## Install

```bash
npm install @rhombussystems/react
# or: yarn add @rhombussystems/react  /  pnpm add @rhombussystems/react
```

- `react` and `react-dom` (**>= 18**) are **peer dependencies** — install them in your app.
- `**dashjs`** is bundled (used for DASH playback) — you do not install it separately.
- The realtime/canvas path uses the browser **WebCodecs** `VideoDecoder` (Chrome, Edge,
Safari 16.4+; Firefox H.264 is still limited) — no extra dependency.

---

## Quick start

A complete live/VOD player with controls, a timeline, zoom, snapshot, and clip export —
from a single `cameraUuid`:

```tsx
import { RhombusPlayer } from "@rhombussystems/react";

export function CameraView() {
  return (
    <RhombusPlayer
      cameraUuid="YOUR_CAMERA_UUID"
      apiOverrideBaseUrl="https://your-api.example.com" // proxy mode (recommended)
      style={{ height: 480 }}
    />
  );
}
```

  


> ⚠️ **Server setup is required.** The SDK calls *your* origin for a token. Your server must
> expose `POST /api/federated-token` (the default path) or set `paths.federatedToken` to your
> route. Built-in **Save Clip** additionally needs a few proxy routes. See the
> [Backend contract](#backend-contract).

  
Prefer to compose your own layout? Drop down to the individual building blocks — each has a deep-dive section further down the page:

- **[`RhombusBufferedPlayer`](#rhombusbufferedplayer--dash-live--vod)** — MPEG-DASH live & VOD on a real `<video>` element; native pause/seek, widest browser support.
- **[`RhombusRealtimePlayer`](#rhombusrealtimeplayer--low-latency-live)** — sub-second live H.264 over WebSocket, decoded with WebCodecs onto a `<canvas>` (live only).

---

## Choosing a component


| Component                   | Transport                                                             | Live latency    | Live | Past (VOD) | Controls               |
| --------------------------- | --------------------------------------------------------------------- | --------------- | ---- | ---------- | ---------------------- |
| `**RhombusPlayer**`         | both — realtime canvas for live, DASH for VOD, switched automatically | sub-second live | ✅    | ✅          | ✅ full bar + `ref` API |
| `**RhombusBufferedPlayer**` | MPEG-DASH (Dash.js) on a `<video>`                                    | ~few seconds    | ✅    | ✅          | native `<video>`       |
| `**RhombusRealtimePlayer**` | H.264 / WebSocket → WebCodecs → `<canvas>`                            | sub-second      | ✅    | ❌          | none (always live)     |
| `**Timeline**`              | none — a canvas scrubber you pair with any video                      | —               | —    | —          | seek UI only           |


**Rule of thumb:** reach for `**RhombusPlayer`** first — it's the drop-in. Drop down to the
individual players when you want to compose your own layou or have a single source of truth for your playback time and playback state (ex: video walls).  

---

## `RhombusPlayer` — the unified player

`RhombusPlayer` composes `RhombusRealtimePlayer` and `RhombusBufferedPlayer` behind one
interface and adds player-level controls: **play/pause, go-live, rewind, playback speed,
digital zoom + pan, snapshot, an event-aware timeline, and save clip**. It automatically
switches between **Live** and **VOD** as the user interacts with the timeline and Go-Live button.

```tsx
import { RhombusPlayer } from "@rhombussystems/react";

<RhombusPlayer
  cameraUuid="YOUR_CAMERA_UUID"
  apiOverrideBaseUrl="https://your-api.example.com"
  showLiveTypeSwitcher            // optional Console-style Realtime/Buffered + quality menu
  saveClip={{ defaultTitle: "Door cam" }}
  timeline={{ fetchSeekPoints: true }}   // 24h day window by default, ±12h chevrons
  onModeChange={(mode, atMs) => console.log(mode, new Date(atMs))}
/>
```

### How Live ⇄ VOD switching works

Switching is a pure function of **time vs. now**:

- **Live** uses the **realtime** transport by default (`RhombusRealtimePlayer`, WebCodecs
canvas, sub-second). It auto-falls back to **buffered** DASH when WebCodecs is unavailable.
- **Pause, rewind, change speed, or seek into the past** drops the player into **VOD**
(`RhombusBufferedPlayer` anchored on a manifest window containing the target time).
- **Go Live** (or seeking within `liveEdgeToleranceSec` of now) returns to the live edge.

Only one transport is mounted at a time, so a switch costs one brief reconnect (no double
bandwidth). Seeking **within** the loaded VOD window is instant (native `<video>` seek);
seeking **outside** it loads a fresh manifest window. A seek **preserves the play/pause
state**: if playback was paused, it stays paused at the new time; if playing, it keeps
playing (seeking to the live edge always resumes, since realtime live cannot be paused).

### `RhombusPlayer` props

Every prop `RhombusPlayer` accepts. Only `cameraUuid` is required; everything else is
optional. (The auth / endpoint / resilience props are the [shared base props](#shared-base-props-all-players)
common to all players.)


| Prop                         | Type                                                  | Required | Default                               | Notes                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------- | -------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cameraUuid`                 | `string`                                              | ✅        | —                                     | Camera UUID from Rhombus. Safe in the browser.                                                                                                                             |
| `connectionMode`             | `"wan" | "lan"`                                       | —        | `"wan"`                               | Which `getMediaUris` URIs to use. See [WAN vs LAN](#wan-vs-lan).                                                                                                           |
| `apiOverrideBaseUrl`         | `string`                                              | —        | —                                     | Base for the token **and** media requests (proxy mode). Required for built-in [Save Clip](#save-clip). When omitted, media is fetched directly from Rhombus.               |
| `rhombusApiBaseUrl`          | `string`                                              | —        | `https://api2.rhombussystems.com/api` | Rhombus REST base when `apiOverrideBaseUrl` is omitted.                                                                                                                    |
| `paths`                      | `{ federatedToken?, mediaUris?, footageSeekpoints?, presenceWindows? }` | —        | see [backend](#backend-contract)      | Override route paths.                                                                                                                                                      |
| `federatedSessionToken`      | `string`                                              | —        | —                                     | Supply & rotate your own token; the SDK skips its token endpoint.                                                                                                          |
| `tokenDurationSec`           | `number`                                              | —        | `86400`                               | Requested token TTL (SDK-managed mode).                                                                                                                                    |
| `headers`                    | `HeadersInit`                                         | —        | —                                     | Static headers for the token request (+ media when `apiOverrideBaseUrl` set).                                                                                              |
| `getRequestHeaders`          | `() => HeadersInit | Promise<…>`                      | —        | —                                     | Async headers merged after `headers`.                                                                                                                                      |
| `maxRetryIntervalMs`         | `number`                                              | —        | `30000`                               | Auto-recovery backoff ceiling. `0` disables.                                                                                                                               |
| `stallTimeoutMs`             | `number`                                              | —        | `12000`                               | Stall watchdog. `0` disables.                                                                                                                                              |
| `liveTransport`              | `"realtime" | "buffered"`                             | —        | `"realtime"`                          | Live transport. **Controllable**. Auto-falls back to `buffered` without WebCodecs.                                                                                         |
| `videoFit`                   | `"contain" | "cover" | "fill" | "auto"`               | —        | `"auto"`                              | How the video fills its area. **Controllable**; built-in `"videoFit"` control changes it. See [Video display / fit](#video-display--fit).                                  |
| `onVideoFitChange`           | `(fit) => void`                                       | —        | —                                     | Fired when the video-display fit changes.                                                                                                                                  |
| `playing`                    | `boolean`                                             | —        | —                                     | **Controlled** play/pause. Omit = uncontrolled (starts playing). Pair with `onPlayingChange`. See [Controlled vs. imperative](#controlled-uncontrolled--imperative).       |
| `playbackRate`               | `number`                                              | —        | —                                     | **Controlled** VOD speed (no-op while live). Pair with `onPlaybackRateChange`.                                                                                             |
| `zoom`                       | `number` (1–4)                                        | —        | —                                     | **Controlled** digital zoom. Pair with `onZoomChange`.                                                                                                                     |
| `positionMs`                 | `number` (epoch ms)                                   | —        | —                                     | **Controlled playhead** — seeks when its value changes; mode is derived (near now ⇒ live). Mirror `onProgress`/`onSeek` for two-way binding.                               |
| `showLiveTypeSwitcher`       | `boolean`                                             | —        | `false`                               | Render the Console-style Realtime/Buffered + quality menu in the bar.                                                                                                      |
| `realtimeStreamQuality`      | `"HD" | "SD"`                                         | —        | `"HD"`                                | Live quality when the resolved transport is realtime.                                                                                                                      |
| `bufferedStreamQuality`      | `"HIGH" | "MEDIUM" | "LOW"`                           | —        | `"HIGH"`                              | DASH quality for buffered live + VOD.                                                                                                                                      |
| `applyBufferedStreamQuality` | `boolean`                                             | —        | `true`                                | Set `false` to omit the `_ds` downscale.                                                                                                                                   |
| `initialMode`                | `"live" | "vod"`                                      | —        | `"live"`                              | Start live or jump straight into the past.                                                                                                                                 |
| `initialStartTimeMs`         | `number` (epoch ms)                                   | —        | —                                     | Anchor used when `initialMode="vod"`.                                                                                                                                      |
| `vodWindowSec`               | `number`                                              | —        | `7200`                                | Length of the VOD manifest window the SDK requests.                                                                                                                        |
| `defaultRewindSec`           | `number`                                              | —        | `15`                                  | Step used by the Rewind button / `rewind()`.                                                                                                                               |
| `liveEdgeToleranceSec`       | `number`                                              | —        | `5`                                   | A seek within this many seconds of now counts as live.                                                                                                                     |
| `autoGoLiveAtEdge`           | `boolean`                                             | —        | `false`                               | Auto-return to live when VOD playback catches up to the edge.                                                                                                              |
| `controls`                   | `RhombusPlayerControl[]`                              | —        | `undefined`                           | Which built-in controls to render. Leaving it `undefined` renders every control; `[]` = headless. There is no `"all"` value. See [below](#choosing-which-controls-render). |
| `classNames`                 | `RhombusPlayerClassNames`                             | —        | —                                     | Per-slot class names for the bar. See [Styling](#styling-the-controls).                                                                                                    |
| `renderControls`             | `(api, state) => ReactNode`                           | —        | —                                     | Replace the bar entirely (timeline still renders).                                                                                                                         |
| `saveClip`                   | `RhombusSaveClipConfig`                               | —        | —                                     | Built-in clip export config. See [Save Clip](#save-clip).                                                                                                                  |
| `timeline`                   | `RhombusPlayerTimelineConfig`                         | —        | —                                     | Timeline/scrubber config. See [Timeline](#timeline-configuration).                                                                                                         |
| `className` / `style`        | `string` / `CSSProperties`                            | —        | —                                     | Applied to the player's root element.                                                                                                                                      |
| `onReady`                    | `() => void`                                          | —        | —                                     | First underlying transport became ready.                                                                                                                                   |
| `onError`                    | `(error: Error) => void`                              | —        | —                                     | Token / media / setup failure.                                                                                                                                             |
| `onRecoveryAttempt`          | `(attempt, error) => void`                            | —        | —                                     | Fires on each auto-recovery retry.                                                                                                                                         |
| `onModeChange`               | `(mode, atWallClockMs) => void`                       | —        | —                                     | Fired on every Live ⇄ VOD transition.                                                                                                                                      |
| `onTransportChange`          | `(transport) => void`                                 | —        | —                                     | Resolved live transport changed (incl. WebCodecs fallback).                                                                                                                |
| `onSeek`                     | `(wallClockMs, mode) => void`                         | —        | —                                     | A seek happened.                                                                                                                                                           |
| `onProgress`                 | `(wallClockMs, mode) => void`                         | —        | —                                     | Throttled playback progress (~4Hz VOD / ~1Hz live). Use to mirror a controlled `positionMs`.                                                                               |
| `onPlayingChange`            | `(playing) => void`                                   | —        | —                                     | Play/pause state changed.                                                                                                                                                  |
| `onPlaybackRateChange`       | `(rate) => void`                                      | —        | —                                     | Playback speed changed.                                                                                                                                                    |
| `onSnapshot`                 | `(RhombusSnapshotResult) => void`                     | —        | —                                     | A snapshot was captured.                                                                                                                                                   |
| `onZoomChange`               | `(zoom, panX, panY) => void`                          | —        | —                                     | Zoom/pan changed.                                                                                                                                                          |
| `onClipRangeSelect`          | `(RhombusClipRange) => void`                          | —        | —                                     | User selected a clip range (fires regardless of built-in export).                                                                                                          |
| `onClipExport`               | `(RhombusClipExportStatus) => void`                   | —        | —                                     | Built-in clip export progress/result.                                                                                                                                      |


### Controlled, uncontrolled & imperative

**You don't have to choose one approach.** Props, the `ref`, and the built-in control bar all
read and write the **same internal state**, so they work together and stay in sync — drive some
aspects declaratively and others imperatively, or let users click the built-in bar; every path
fires the matching `on*Change` callback so your state can follow. (The only caveat is the standard
React one: see "Notes" below.)

1. **Controlled value props** — drive a steady-state value declaratively. Each is *optional*: omit
  it and the player owns it internally (uncontrolled, seeded by `initial*`/defaults); provide it
   (and update it from the matching `on*Change`) and it becomes the source of truth. The built-in
   controls **and** the `ref` still work — in controlled mode they fire `on*Change` so your state
   updates.

  | Prop            | Callback               |
  | --------------- | ---------------------- |
  | `playing`       | `onPlayingChange`      |
  | `playbackRate`  | `onPlaybackRateChange` |
  | `zoom`          | `onZoomChange`         |
  | `liveTransport` | `onTransportChange`    |
  | `videoFit`      | `onVideoFitChange`     |

2. **Controlled playhead** — `positionMs` (epoch ms). It seeks when its value **changes** (the
  player derives live vs. VOD: within `liveEdgeToleranceSec` of now ⇒ live in the current
   transport, else VOD — there is **no** `mode` prop). The player still advances on its own; for a
   two-way binding, mirror `onProgress` (throttled) and/or `onSeek` back into `positionMs`:
3. **Imperative actions** — one-shot commands on the [`ref`](#imperative-handle-ref). Some are just
  sugar over a declarative prop (use whichever you prefer); two are **strictly imperative** because
   they return a value / run an async side-effect and have no meaningful "state" to bind:

  | `ref` method                                           | Declarative equivalent                                                                                                                                                                       |
  | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `play()` / `pause()`                                   | `playing`                                                                                                                                                                                    |
  | `setPlaybackRate(r)`                                   | `playbackRate`                                                                                                                                                                               |
  | `zoomIn()` / `zoomOut()` / `setZoom()` / `resetZoom()` | `zoom`                                                                                                                                                                                       |
  | `setLiveTransport(t)`                                  | `liveTransport`                                                                                                                                                                              |
  | `seekTo(ms)` / `rewind(s)` / `goLive()`                | `positionMs` (set to the time / `now − s` / `now`)                                                                                                                                           |
  | `**snapshot()`**                                       | **none — strictly imperative** (returns the captured frame).                                                                                                                                 |
  | `**startClipExport(range?, opts?)`**                   | **none — strictly imperative** (clip *capture*; runs the async render, returns status). Clip *range selection* is the built-in UI / `onClipRangeSelect`, but the export itself is a command. |

   So: everything that *has a steady-state value* is available as a controlled prop; the only things
   that are **ref-only** are `**snapshot()`** and `**startClipExport()**` (and you'd typically also
   reach for `getState()` imperatively).

**Notes (controlled semantics):** when you provide a controlled prop, you own it — if you ignore its
`on*Change`, the prop and the player can diverge until the next prop change (standard React
controlled behavior; e.g. the built-in Pause button fires `onPlayingChange(false)`, and if you don't
update your `playing` state the player re-asserts your prop). `getState()` always returns the
**effective** values regardless of how you drive it, and the `ref` works in controlled or
uncontrolled mode.

### Imperative handle (`ref`)

Pass a `ref` to drive the player programmatically. The built-in control bar uses this exact
API internally, so anything the buttons do, you can do too.

```tsx
import { useRef } from "react";
import { RhombusPlayer, type RhombusPlayerHandle } from "@rhombussystems/react";

function Controlled() {
  const player = useRef<RhombusPlayerHandle>(null);
  return (
    <>
      <RhombusPlayer ref={player} cameraUuid="…" apiOverrideBaseUrl="https://api.example.com" />
      <button onClick={() => player.current?.pause()}>Pause</button>
      <button onClick={() => player.current?.goLive()}>Go live</button>
      <button onClick={() => player.current?.rewind(30)}>« 30s</button>
      <button onClick={() => player.current?.seekTo(Date.now() - 3_600_000)}>1h ago</button>
      <button onClick={async () => {
        const shot = await player.current?.snapshot();
        if (shot) downloadDataUrl(shot.dataUrl, "frame.png");
      }}>Snapshot</button>
    </>
  );
}
```


| Method                                        | Description                                                      |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `play()` / `pause()`                          | Play / pause. Pausing live drops into a frozen VOD frame.        |
| `goLive()`                                    | Return to the live edge (restores the live transport).           |
| `seekTo(wallClockMs)`                         | Seek to an absolute time (epoch ms); auto-switches Live ⇄ VOD.   |
| `rewind(seconds?)`                            | Jump back `seconds` (default `defaultRewindSec`).                |
| `setPlaybackRate(rate)`                       | VOD only; ignored while live.                                    |
| `zoomIn(step?)` / `zoomOut(step?)`            | Digital zoom (1×–4×).                                            |
| `setZoom(zoom, panX?, panY?)` / `resetZoom()` | Set zoom + pan directly / reset to 1×.                           |
| `snapshot()`                                  | `Promise<RhombusSnapshotResult>` — capture the current frame.    |
| `setLiveTransport("realtime" | "buffered")`   | Switch transport (clamps to buffered without WebCodecs).         |
| `startClipExport(range?, options?)`           | `Promise<RhombusClipExportStatus>` — export a clip (proxy mode). |
| `getState()`                                  | Current [`RhombusPlayerState`](#observable-state) snapshot.      |


### Observable state

`renderControls(api, state)` receives — and `getState()` returns — a `RhombusPlayerState`:

```ts
type RhombusPlayerState = {
  cameraUuid: string;
  mode: "live" | "vod";
  liveTransport: "realtime" | "buffered";  // resolved (may have fallen back)
  playing: boolean;
  playbackRate: number;
  currentWallClockMs: number | null;        // ≈ Date.now() while live
  zoom: number;
  isAtLiveEdge: boolean;
  canSaveClip: boolean;                      // built-in export available (proxy mode)
  clipSelection: { startMs: number; endMs: number } | null; // current clip selection, or null
  clipExport?: RhombusClipExportStatus;      // in-progress / finished export
};
```

### Choosing which controls render

`controls` is a list of `RhombusPlayerControl`. It's exported **both** as a string union and
as a runtime constant (`RhombusPlayerControl.Play`, etc.), so use plain strings or named
members — whichever you prefer:

```tsx
"play" | "goLive" | "rewind" | "speed" | "zoom" | "snapshot" | "saveClip" | "timeline" | "liveType" | "videoFit" | "goToDate"
```

```tsx
import { RhombusPlayer, RhombusPlayerControl } from "@rhombussystems/react";

// All controls — omit the prop entirely:
<RhombusPlayer cameraUuid="…" />

// A subset — plain strings:
<RhombusPlayer cameraUuid="…" controls={["play", "timeline"]} />

// …or the named constant (autocompletes, refactor-safe):
<RhombusPlayer cameraUuid="…" controls={[RhombusPlayerControl.Play, RhombusPlayerControl.Timeline]} />

// Headless — no built-in UI at all; drive everything through the ref:
<RhombusPlayer ref={player} cameraUuid="…" controls={[]} />
```

### Go to date (`"goToDate"` control / `RhombusDateTimePicker`)

The toolbar includes a **date/time jump picker** (the `"goToDate"` control, on by default):
a calendar + time-of-day popover that seeks the player to any moment — the SDK counterpart of
the Rhombus Console's toolbar date picker. When [footage availability](#footage-availability)
is enabled, days with **no recorded footage** are struck through and disabled (one
`getPresenceWindows` fetch per viewed month, cached; failures just leave days enabled).

The component is also exported standalone for custom layouts — it interops with any player via
`seekTo`:

```tsx
import { RhombusDateTimePicker } from "@rhombussystems/react";

<RhombusDateTimePicker
  value={positionMs}                              // epoch ms (or null)
  onChange={(ms) => playerRef.current?.seekTo(ms)}
  cameraUuid="…"                                  // optional: enables no-footage day disabling
  apiOverrideBaseUrl="https://your-api.example.com"
  minTimeMs={retentionFloorMs}                    // optional: disable pre-retention days
  direction="down"                                // "up" for bottom toolbars (player default)
/>
```

All calendar math is in the viewer's local time zone (consistent with the Timeline). Style it
via the `rhombus-datepicker-*` classes (zero-specificity defaults, like the control bar) or the
`classNames={{ anchor, popover }}` prop.

Inside `RhombusPlayer`, a picker jump that lands outside the visible timeline window also
re-centers the timeline on the target (in-window seeks — i.e. timeline clicks — never move the
window). In custom layouts composing the standalone picker with a standalone `Timeline`, you
own the window: update your `rangeStartMs`/`rangeEndMs` in the same `onChange` that calls
`seekTo`.

### Video display / fit

Cameras are usually 16:9; when the player box isn't, you get letter/pillar-boxing. The
`videoFit` prop controls how the footage fills its area, mirroring the Rhombus Console
video-wall "Video Display" options:


| `videoFit`           | Console label        | Behavior                                                                  |
| -------------------- | -------------------- | ------------------------------------------------------------------------- |
| `"auto"` *(default)* | Auto-Size            | The **player box takes the video's aspect ratio** — no bars, no cropping. |
| `"contain"`          | Default Aspect Ratio | Full frame, letter/pillar-boxed (`object-fit: contain`).                  |
| `"cover"`            | Full View Cropped    | Fills the box, crops overflow (`object-fit: cover`).                      |
| `"fill"`             | Stretch to Fit       | Distorts to fill, no cropping (`object-fit: fill`).                       |


There's a built-in **video-display control** in the bar (the `"videoFit"` control) so users can
switch between these live; it fires `onVideoFitChange`. You can also drive it as a controlled
prop:

```tsx
<RhombusPlayer cameraUuid="…" videoFit="cover" onVideoFitChange={setFit} />
```

> `**"auto"` sizes by width:** the player measures the video's intrinsic aspect ratio and sets
> the stage's `aspect-ratio` (height is derived), so give the player a width and **don't impose a
> fixed height** in that mode. The other three modes fill whatever box you give it.

For the low-level `RhombusBufferedPlayer` / `RhombusRealtimePlayer`, set `object-fit` yourself via
`videoProps.style` / `canvasProps.style`.

### Styling the controls

Three options, least → most custom:

**1. Plain CSS overrides.** The bar uses stable class names, and the SDK ships its defaults
as a **zero-specificity `:where()` stylesheet** injected once at runtime. Because every
default selector sits inside `:where()` (specificity `0,0,0`), your CSS **always wins — no
`!important`, no import, regardless of load order**:


| Element            | class                                                                        |
| ------------------ | ---------------------------------------------------------------------------- |
| the bar            | `rhombus-player-controls`                                                    |
| every button       | `rhombus-player-btn` (active: `[data-active="true"]`; disabled: `:disabled`) |
| speed `<select>`   | `rhombus-player-speed`                                                       |
| quality `<select>` | `rhombus-player-quality`                                                     |
| live-type group    | `rhombus-player-livetype`                                                    |
| clip group         | `rhombus-player-clip`                                                        |
| clip status text   | `rhombus-player-clip-status`                                                 |
| timeline wrapper   | `rhombus-player-timeline`                                                    |


```css
.rhombus-player-controls { background: #fff; color: #111; gap: 12px; }
.rhombus-player-btn { background: #0a7; border-color: #0a7; border-radius: 999px; }
.rhombus-player-btn[data-active="true"] { outline: 2px solid #0a7; }
```

**2. `classNames` prop** — attach your own class per slot (Tailwind, CSS-modules, design
systems). Appended to the SDK's class on that element:

```tsx
<RhombusPlayer
  cameraUuid="…"
  classNames={{ controls: "flex gap-3 p-2 bg-white", button: "btn btn-sm", clip: "ml-auto" }}
/>
```

**3. `renderControls`** — replace the bar entirely (the timeline still renders above it) and
build your own buttons against the imperative `api`:

```tsx
<RhombusPlayer
  cameraUuid="…"
  renderControls={(api, s) => (
    <div className="my-bar">
      <button onClick={() => (s.playing ? api.pause() : api.play())}>
        {s.playing ? "Pause" : "Play"}
      </button>
      {s.mode === "vod" && <button onClick={() => api.goLive()}>Go live</button>}
      <button onClick={() => api.rewind()}>« 15s</button>
      <button disabled={s.mode === "live"} onClick={() => api.setPlaybackRate(2)}>2×</button>
      <button onClick={() => api.zoomIn()}>＋</button>
      <button onClick={() => void api.snapshot()}>Snapshot</button>
    </div>
  )}
/>
```

`renderControls` is fully optional — omit it to keep the built-in bar. For total control,
combine `controls={[]}` (no bar) with the `ref` handle and your own layout.

### Snapshots

The Snapshot tool **captures the current frame and hands the image data back to you** — it does
**not** auto-download and there is **no target container/ref to render into**. It works in both
modes (the realtime canvas and the MSE-fed DASH `<video>` are both untainted, so `toDataURL` /
`toBlob` succeed) and returns a `RhombusSnapshotResult`:

```ts
type RhombusSnapshotResult = {
  dataUrl: string;   // PNG data: URL
  blob: Blob | null; // PNG blob (null only if toBlob is unavailable)
  wallClockMs: number;
  mode: "live" | "vod";
  width: number;
  height: number;
};
```

You receive it **two ways** — both deliver the same result, including for the built-in Snapshot
button:

```tsx
// 1) Callback — fires for the built-in button AND for api.snapshot()
<RhombusPlayer cameraUuid="…" onSnapshot={(shot) => setPreview(shot.dataUrl)} />

// 2) Imperative — capture on demand and use the returned result
const shot = await playerRef.current!.snapshot();
```

The SDK never downloads or displays the image itself — render it (`<img src={shot.dataUrl} />`),
upload `shot.blob`, or trigger a download yourself:

```tsx
const shot = await playerRef.current!.snapshot();
const a = document.createElement("a");
a.href = shot.dataUrl;                          // or URL.createObjectURL(shot.blob!)
a.download = `snapshot-${shot.wallClockMs}.png`;
a.click();
```

> A common pattern is to store `onSnapshot`'s `dataUrl` in state and render a thumbnail
> (`<img src={dataUrl} />`). For lower-level use, `snapshotCanvasElement` / `snapshotVideoElement`
> are exported too.

### Save Clip

The clip flow is **drag-to-select on the timeline**, then export:

1. `**✂ Create clip`** in the bar enters clip mode — it seeds a selection at the playhead and
  **zooms the timeline** so it's easy to adjust.
2. On the timeline you get a shaded region with **draggable start/end handles**, a **draggable
  body** (move the whole range), and a live **duration** label. The selection clamps to a
   minimum (default 5s), a maximum (default 60 min — the server cap), and never includes the
   future.
3. `**Save clip`** opens a small **title / description / visibility** form (skippable — set
  `saveClip.showOptionsForm: false`), then runs the export: `/video/spliceV3` → progress
   polling → a download URL.

`onClipRangeSelect({ startMs, endMs, cameraUuid })` fires as the selection changes, and
`onClipExport(status)` reports progress/result.

> **Proxy mode required for export.** The clip endpoints are **API-key / session authed, not
> federated-token compatible**, so the request must go through *your* backend (which attaches
> the API key) — exactly like the media-URI proxy. Built-in **export** is only available when
> `apiOverrideBaseUrl` is set; selection + `onClipRangeSelect` work regardless. See the
> [Backend contract](#clip-routes-built-in-save-clip).

```tsx
<RhombusPlayer
  cameraUuid="…"
  apiOverrideBaseUrl="https://your-api.example.com"
  saveClip={{ defaultDurationSec: 30, defaultVisibility: "PRIVATE", showOptionsForm: true }}
  onClipExport={(s) => {
    if (s.phase === "rendering") setProgress(s.percentComplete);
    if (s.phase === "complete") window.location.assign(s.downloadUrl!);
  }}
/>
```

```ts
type RhombusSaveClipConfig = {
  enabled?: boolean;           // default true when apiOverrideBaseUrl is set
  paths?: { splice?: string; progress?: string; download?: string };
  defaultTitle?: string;
  defaultDurationSec?: number; // seeded selection width. Default 60
  minDurationSec?: number;     // drag clamp. Default 5
  maxDurationSec?: number;     // drag clamp. Default 3600 (server caps at 60 min)
  progressTimeoutMs?: number;  // give up polling a stuck render. Default 300000 (5 min); 0 = never
  defaultVisibility?: RhombusClipVisibility; // "ORG_WIDE" (default) | "PRIVATE" | "ROLE_RESTRICTED"
  showOptionsForm?: boolean;   // show the title/description/visibility form. Default true
  requireFootage?: "any" | "full" | "off"; // footage pre-check policy. Default "any" (see below)
};

type RhombusClipExportOptions = {
  title?: string;
  description?: string;
  visibility?: RhombusClipVisibility;
  saveToConsole?: boolean;     // default true
  audioIncluded?: boolean;     // also splices the camera's .a0 audio facet
};

type RhombusClipExportStatus = {
  phase: "selecting" | "submitting" | "rendering" | "complete" | "error" | "canceled";
  clipUuid?: string;
  percentComplete?: number;  // 0–100 while rendering
  currentOperation?: string;
  downloadUrl?: string;      // set when complete
  error?: string;
  errorCode?: "no-footage" | "partial-footage"; // set when the footage pre-check blocked the export
  coverage?: RhombusRangeCoverage;              // footage coverage of the range, when the check ran
};
```

#### Footage pre-check (`requireFootage`)

Rhombus renders time ranges with **no recorded footage** (camera offline during the window, or
footage past retention) as "VIDEO NOT AVAILABLE" placeholder frames — and `/video/spliceV3`
happily renders a clip over such a range, returning a "successful" clip with no real video in
it. Before submitting an export, the player therefore fetches
[`/camera/getPresenceWindows`](#footage-availability) for the selected range and applies
`requireFootage`:

- `"any"` (default) — block only when the range has **zero** recorded footage.
- `"full"` — block when the range has **any** confirmed gap.
- `"off"` — no pre-check (legacy behavior).

A blocked export emits `phase: "error"` with `errorCode` (`"no-footage"` / `"partial-footage"`)
and `coverage` — key both your custom UI messages off `errorCode`, not the human-readable
`error` string. Exports that proceed carry `coverage` on every subsequent status so you can
warn about partial footage. The check **fails open**: if availability can't be fetched (missing
proxy route, timeout), the export proceeds ungated and `coverage` is absent.

**Build your own clip UI** instead of the built-in form: read the live selection from
`onClipRangeSelect` (or `getState().clipSelection`) and call the imperative handle with your own
options:

```tsx
await player.current!.startClipExport(
  { startMs, endMs, cameraUuid },
  { title: "Front door", visibility: "PRIVATE", audioIncluded: true }
);
```

### Timeline configuration

`RhombusPlayer` renders a [`Timeline`](#timeline--standalone-scrubber) when `controls`
includes `"timeline"` (the default). Configure it with the `timeline` prop:

```ts
type RhombusPlayerTimelineConfig = {
  windowSec?: number;        // span of the scrubber, seconds. Default 86400 (a full day)
  fetchSeekPoints?: boolean; // fetch event markers from /camera/getFootageSeekpointsV2. Default true
  includeAnyMotion?: boolean;
  fetchAvailability?: boolean; // fetch footage coverage from /camera/getPresenceWindows and draw
                               // no-footage gaps on the availability bar. Default: true in proxy
                               // mode (apiOverrideBaseUrl set), false in direct mode.
  onAvailabilityLoaded?: (availability: RhombusFootageAvailability) => void;
  marks?: TimelineMark[];    // extra static event bands / gaps
  colors?: TimelineColors;   // recolor seekpoints, bars, playhead, buttons (see below)
  height?: number;           // px, default 56
  onSeekPointsLoaded?: (points: RhombusFootageSeekPoint[]) => void; // diagnostics
};
```

#### Footage availability

With `fetchAvailability` on, the availability bar stops pretending all past time is recorded:
ranges with **confirmed no footage** render in `colors.availabilityGap` (default a muted red) —
the same ranges the Rhombus stream would play as "VIDEO NOT AVAILABLE" placeholder frames. Gaps
are only drawn where the answer is actually known (inside the fetched range, in the past, and
older than a ~2-minute live-edge grace window for presence-ingest lag); everything else keeps
the legacy look. The in-clip-mode toolbar also shows a warning (and disables Save, per
[`requireFootage`](#footage-pre-check-requirefootage)) when the selection overlaps a gap.

The raw client + coverage math are exported for custom UIs: `fetchPresenceWindows`,
`mergeFootageWindows`, `computeFootageGaps`, `computeRangeCoverage`, and the
`RhombusFootageWindow` / `RhombusFootageAvailability` / `RhombusRangeCoverage` types. Windows
carry `source: "cloud" | "local"` — **local** windows live on the camera's SD card and are only
retrievable while the camera is online; **cloud** windows are always retrievable.

By default the window is a **24h span aligned to local midnight** (Console-style). `RhombusPlayer`
renders ‹/› chevrons that pan by half a span (**±12h** at the day view), and **−/+ zoom buttons +
mouse-wheel zoom** that step through `24h → 8h → 3h → 1h → 20m → 5m` (centered on the cursor or
playhead, with an animated transition) so you can pinpoint a moment when seekpoints bunch up.
It auto-follows the current day/playhead until you navigate; **Go Live** resets to the day view.

The player keeps the window stable while you scrub and only scrolls it once playback leaves
the visible range, so the playhead always lands exactly where you click.

### `RhombusPlayer` recipes

**Open straight into an event (past footage):**

```tsx
<RhombusPlayer
  cameraUuid="…"
  apiOverrideBaseUrl="https://api.example.com"
  initialMode="vod"
  initialStartTimeMs={new Date("2025-04-15T09:30:00Z").getTime()}
/>
```

**Auto-return to live when caught up, wider rewind step:**

```tsx
<RhombusPlayer cameraUuid="…" autoGoLiveAtEdge defaultRewindSec={30} />
```

**Force broadest browser support (buffered live everywhere):**

```tsx
<RhombusPlayer cameraUuid="…" liveTransport="buffered" />
```

**Headless — your UI, our engine:**

```tsx
function MyPlayer() {
  const ref = useRef<RhombusPlayerHandle>(null);
  const [state, setState] = useState<RhombusPlayerState>();
  return (
    <>
      <RhombusPlayer ref={ref} cameraUuid="…" controls={[]} onModeChange={() => setState(ref.current?.getState())} />
      {/* render your own toolbar from `state` and `ref.current` */}
    </>
  );
}
```

---

## `RhombusBufferedPlayer` — DASH live & VOD

Renders live or historical footage with Dash.js into a `<video>` element. This is the right
choice when you want native `<video>` semantics, the widest browser support, or you're
composing your own layout.

```tsx
<RhombusBufferedPlayer
  cameraUuid="YOUR_CAMERA_UUID"
  connectionMode="wan"          // "wan" (default) | "lan"
  bufferedStreamQuality="HIGH"  // "HIGH" | "MEDIUM" | "LOW"
  videoProps={{ controls: true, style: { width: "100%" } }}
  onReady={() => console.log("playing")}
  onError={(e) => console.error(e)}
/>
```

### Shared base props (all players)

These come from `RhombusPlayerBaseProps` and are accepted by **every** player:


| Prop                    | Type                                                  | Default                               | Notes                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cameraUuid`            | `string`                                              | — **(required)**                      | Camera UUID from Rhombus. Safe in the browser.                                                                                                         |
| `connectionMode`        | `"wan" | "lan"`                                       | `"wan"`¹                              | Which `getMediaUris` URIs to use. See [WAN vs LAN](#wan-vs-lan).                                                                                       |
| `apiOverrideBaseUrl`    | `string`                                              | —                                     | Base for the token **and** media requests. Set for proxy mode. When omitted, media is fetched **directly from Rhombus** (needs a domain-scoped token). |
| `rhombusApiBaseUrl`     | `string`                                              | `https://api2.rhombussystems.com/api` | Rhombus REST base when `apiOverrideBaseUrl` is omitted.                                                                                                |
| `paths`                 | `{ federatedToken?, mediaUris?, footageSeekpoints?, presenceWindows? }` | see [backend](#backend-contract)      | Override route paths.                                                                                                                                  |
| `federatedSessionToken` | `string`                                              | —                                     | Supply & rotate your own token; the SDK skips its token endpoint.                                                                                      |
| `tokenDurationSec`      | `number`                                              | `86400`                               | Requested token TTL (SDK-managed mode).                                                                                                                |
| `headers`               | `HeadersInit`                                         | —                                     | Static headers for the token request (+ media when `apiOverrideBaseUrl` set).                                                                          |
| `getRequestHeaders`     | `() => HeadersInit | Promise<…>`                      | —                                     | Async headers merged after `headers`.                                                                                                                  |
| `maxRetryIntervalMs`    | `number`                                              | `30000`                               | Auto-recovery backoff ceiling. `0` disables.                                                                                                           |
| `stallTimeoutMs`        | `number`                                              | `12000`                               | Stall watchdog. `0` disables.                                                                                                                          |
| `onRecoveryAttempt`     | `(attempt, error) => void`                            | —                                     | Fires on each retry.                                                                                                                                   |
| `className` / `style`   | `string` / `CSSProperties`                            | —                                     | Applied to the player element.                                                                                                                         |
| `onError`               | `(error: Error) => void`                              | —                                     | Token / media / setup failure.                                                                                                                         |


¹ `connectionMode` is **required** (no default) on `RhombusRealtimePlayer`.

### `RhombusBufferedPlayer`-specific props


| Prop                         | Type                        | Default  | Notes                                                                                  |
| ---------------------------- | --------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `startTimeSec`               | `number` (Unix **seconds**) | —        | **Set to play the past** (VOD). Omit for live. Changing it re-attaches a new manifest. |
| `vodDurationSec`             | `number`                    | `7200`   | VOD window length; how far you can seek before a new manifest is needed.               |
| `seekOffsetSec`              | `number`                    | `0`      | Where in the window playback begins.                                                   |
| `bufferedStreamQuality`      | `"HIGH" | "MEDIUM" | "LOW"` | `"HIGH"` | Server downscale via `_ds`. Updating doesn't re-fetch the manifest.                    |
| `applyBufferedStreamQuality` | `boolean`                   | `true`   | `false` omits `_ds` (full resolution).                                                 |
| `videoProps`                 | `VideoHTMLAttributes`       | —        | Spread onto the `<video>` (`controls`, `muted`, `onClick`, `style`, …).                |
| `onReady`                    | `() => void`                | —        | Dash.js initialized and manifest loaded.                                               |


Exposes a `ref` handle: `{ getVideoElement(), getDashPlayer() }`.

**Live vs. past — the single switch is `startTimeSec`:**

```tsx
function CameraPlayer({ cameraUuid, mode }: { cameraUuid: string; mode: "live" | "past" }) {
  const startTimeSec =
    mode === "past" ? Math.floor(new Date("2025-04-15T00:00:00Z").getTime() / 1000) : undefined;
  return (
    <RhombusBufferedPlayer
      cameraUuid={cameraUuid}
      startTimeSec={startTimeSec}  // undefined => live, number => VOD
      vodDurationSec={3600}
      videoProps={{ controls: true }}
    />
  );
}
```

**Scrub beyond the window** by updating `startTimeSec` from your own timeline:

```tsx
const [startTimeSec, setStartTimeSec] = useState(() => Math.floor(Date.now() / 1000) - 3600);
<input type="datetime-local" onChange={(e) => {
  const ms = new Date(e.target.value).getTime();
  if (!Number.isNaN(ms)) setStartTimeSec(Math.floor(ms / 1000)); // loads a fresh window
}} />
<RhombusBufferedPlayer cameraUuid={cameraUuid} startTimeSec={startTimeSec} videoProps={{ controls: true }} />
```

> **Pausing *live* DASH** lets it fall behind the live edge; Dash.js catches up on resume.
> For frame-accurate pause use VOD mode (`startTimeSec`) — or just use `RhombusPlayer`, which
> handles this for you.

`formatVodMpdUri(template, startTimeSec, durationSec)` and `getDefaultRhombusVodDashSettings()`
are exported if you need to build VOD URLs or tune Dash.js yourself.

---

## `RhombusRealtimePlayer` — low-latency live

Live H.264 over WebSocket, decoded with WebCodecs onto a `<canvas>`. **Live only** — no
pause, seek, or VOD. Sub-second latency; ideal for a video wall or PTZ control.

```tsx
<RhombusRealtimePlayer
  cameraUuid="YOUR_CAMERA_UUID"
  connectionMode="wan"          // REQUIRED: "wan" | "lan"
  realtimeStreamQuality="HD"    // "HD" (/ws) | "SD" (/wsl)
  style={{ width: "100%", background: "#111" }}
  onReady={() => console.log("connected")}
  onError={(e) => console.error(e)}
/>
```

Accepts all [shared base props](#shared-base-props-all-players), plus:


| Prop                    | Type                   | Default          | Notes                                                                                                                |
| ----------------------- | ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `connectionMode`        | `"wan" | "lan"`        | — **(required)** | `wan` → `wanLiveH264Uri(s)`; `lan` → `lanLiveH264Uri(s)`. Federated auth is added as query params on the socket URL. |
| `realtimeStreamQuality` | `"HD" | "SD"`          | `"HD"`           | `SD` rewrites `/ws` → `/wsl`. Changing it **reconnects** (brief blip).                                               |
| `canvasProps`           | `CanvasHTMLAttributes` | —                | Spread onto the `<canvas>`.                                                                                          |
| `onReady`               | `() => void`           | —                | Fires on **every** WebSocket `OPEN` (first connect *and* each reconnect).                                            |


Exposes a `ref` handle: `{ getCanvasElement() }`.

> `**onReady` and token rotation differ from buffered:** realtime `onReady` fires on every
> (re)connect, and because auth is on the socket URL, each token refresh closes/reopens the
> socket (short blip). The buffered player rotates tokens without a teardown.

Optional low-level exports for custom wiring: `resolveLiveH264WebSocketUrl(options)`,
`startRhombusRealtimeSession(options)`.

---

## `Timeline` — standalone scrubber

A vendor-neutral **canvas scrubber**. It does **not** embed a player — pair it with any video
source (or let `RhombusPlayer` drive it for you). It draws an availability bar, event
seekpoints (optionally fetched from `/camera/getFootageSeekpointsV2`), static marks, a
playhead, and a hover line, and emits `onSeek(wallClockMs)` on click/drag.

```tsx
import { Timeline } from "@rhombussystems/react";

<Timeline
  cameraUuid="YOUR_CAMERA_UUID"
  apiOverrideBaseUrl="https://your-api.example.com"
  rangeStartMs={Date.now() - 3_600_000}
  rangeEndMs={Date.now()}
  currentTimeMs={playheadMs}
  fetchSeekPoints
  marks={[{ startMs: t0, endMs: t1, kind: "event", color: "#f80", label: "Motion" }]}
  onSeek={(ms) => setPlayheadMs(ms)}
  onHoverTimeChange={(ms) => setHoverMs(ms)}
/>
```

Accepts the [shared base props](#shared-base-props-all-players) (for the seekpoint fetch) plus:


| Prop                                                | Type                                                   | Default            | Notes                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `rangeStartMs` / `rangeEndMs`                       | `number` (epoch ms)                                    | — **(required)**   | Visible time window.                                                                                              |
| `currentTimeMs`                                     | `number | null`                                        | —                  | Playhead position; omit to hide it.                                                                               |
| `onSeek`                                            | `(wallClockMs) => void`                                | — **(required)**   | Click/drag to seek.                                                                                               |
| `onHoverTimeChange`                                 | `(wallClockMs | null) => void`                         | —                  | Pointer hover time.                                                                                               |
| `selection`                                         | `{ startMs, endMs } | null`                            | —                  | Clip selection. When set, draws a shaded region + draggable start/end handles + body + duration label.            |
| `onSelectionChange`                                 | `({ startMs, endMs }) => void`                         | —                  | Fired as the user drags the selection.                                                                            |
| `selectionMinDurationMs` / `selectionMaxDurationMs` | `number`                                               | `5000` / `3600000` | Drag clamps for the selection.                                                                                    |
| `onShiftWindow`                                     | `(direction: -1 | 1) => void`                          | —                  | When provided, renders ‹/› chevrons that pan the window (`-1` earlier, `1` later).                                |
| `canShiftBack` / `canShiftForward`                  | `boolean`                                              | `true`             | Enable/disable the respective chevron at a limit.                                                                 |
| `onZoom`                                            | `(zoomIn: boolean, centerWallClockMs: number) => void` | —                  | When provided, enables −/+ zoom buttons **and mouse-wheel zoom** (centered on the cursor). Range changes animate. |
| `canZoomIn` / `canZoomOut`                          | `boolean`                                              | `true`             | Enable/disable the respective zoom button at a limit.                                                             |
| `fetchSeekPoints`                                   | `boolean`                                              | `false`            | Fetch event markers for the range. Rendered as clustered colored dashes grouped by activity type.                 |
| `includeAnyMotion`                                  | `boolean`                                              | `true`             | Include generic motion in the fetch.                                                                              |
| `marks`                                             | `TimelineMark[]`                                       | —                  | Static event bands (`kind:"event"`) / gaps (`kind:"gap"`).                                                        |
| `onSeekPointsLoaded`                                | `(RhombusFootageSeekPoint[]) => void`                  | —                  | Normalized seekpoints after each fetch (handy for diagnostics).                                                   |
| `colors`                                            | `TimelineColors`                                       | —                  | Override the canvas-drawn colors (see [Theming the timeline](#theming-the-timeline)).                             |
| `height`                                            | `number`                                               | `56`               | Canvas height in px.                                                                                              |


`Timeline` also draws a **time axis with auto-spaced tick labels** (interval chosen for ~6
divisions, `h a` / `h:mm a` format), an availability bar, a playhead, and a hover line.

Exposes a `ref` handle: `{ refresh() }` to force a seekpoint refetch.

### Theming the timeline

The timeline is drawn on a `<canvas>`, so its colors can't be set with CSS. Pass a `colors`
object instead (every field optional, merged over the defaults). On `RhombusPlayer` use
`timeline={{ colors: … }}`; on the standalone `Timeline` use the `colors` prop:

```tsx
<RhombusPlayer
  cameraUuid="…"
  timeline={{
    colors: {
      background: "#0b1220",          // canvas fill (default transparent)
      availabilityActive: "#22c55e",  // recorded-footage bar
      availabilityInactive: "#334155",// empty/future bar
      playhead: "#f59e0b",
      hover: "rgba(255,255,255,0.6)",
      tick: "#475569",
      tickLabel: "#94a3b8",
      seekpointDefault: "#60a5fa",     // activities not in eventColors
      seekpointAlert: "#ef4444",       // alerted events
      eventColors: {                   // merged over the built-in per-activity palette
        MOTION_HUMAN: "#facc15",
        MOTION_CAR: "#38bdf8",
        FACE: "#34d399",
      },
      buttonBackground: "#1e293b",     // ‹/›/−/+ buttons
      buttonBorder: "#475569",
      buttonText: "#e2e8f0",
      selection: "rgba(59,130,246,0.22)", // clip-selection region
      selectionHandle: "#3b82f6",         // clip-selection drag handles
    },
  }}
/>
```

`eventColors` keys are activity strings from `getFootageSeekpointsV2` (e.g. `MOTION`,
`MOTION_HUMAN`, `MOTION_CAR`, `MOTION_ANIMAL`, `FACE`, `SOUND_LOUD`, …). The timeline's
**wrapper** (and `RhombusPlayer`'s root) can still be styled via `className`/`style` /
`classNames.timeline` — `colors.background` paints the canvas itself.

### Pairing it with a video source

`Timeline` is just a seek UI — it has no idea what's playing. You wire it to a video by (a)
feeding it the current playhead as `currentTimeMs`, and (b) handling `onSeek` to move that
video. Here it is paired with a `RhombusBufferedPlayer` in VOD mode, using the player's
[`ref` handle](#rhombusbufferedplayer-specific-props) (`getVideoElement()`) to read and drive
the underlying `<video>`. Wall-clock maps to the video as `windowStart + video.currentTime`:

```tsx
import { useEffect, useRef, useState } from "react";
import {
  RhombusBufferedPlayer,
  Timeline,
  type RhombusBufferedPlayerHandle,
} from "@rhombussystems/react";

function ScrubbableVod({ cameraUuid }: { cameraUuid: string }) {
  const player = useRef<RhombusBufferedPlayerHandle>(null);
  const windowSec = 3600;
  // Epoch seconds of the VOD manifest window the player currently has loaded.
  const [windowStartSec, setWindowStartSec] = useState(() => Math.floor(Date.now() / 1000) - windowSec);
  const [currentMs, setCurrentMs] = useState(windowStartSec * 1000);

  // Drive the playhead from the <video>'s position.
  useEffect(() => {
    const id = setInterval(() => {
      const v = player.current?.getVideoElement();
      if (v) setCurrentMs(windowStartSec * 1000 + v.currentTime * 1000);
    }, 250);
    return () => clearInterval(id);
  }, [windowStartSec]);

  function handleSeek(ms: number) {
    const v = player.current?.getVideoElement();
    const offsetSec = (ms - windowStartSec * 1000) / 1000;
    if (v && offsetSec >= 0 && offsetSec <= windowSec) {
      v.currentTime = offsetSec;                  // inside the loaded window — instant
    } else {
      setWindowStartSec(Math.floor(ms / 1000));   // outside — load a fresh window at that time
    }
    setCurrentMs(ms);
  }

  return (
    <>
      <RhombusBufferedPlayer
        ref={player}
        cameraUuid={cameraUuid}
        apiOverrideBaseUrl="https://your-api.example.com"
        startTimeSec={windowStartSec}
        vodDurationSec={windowSec}
        videoProps={{ controls: false }}
      />
      <Timeline
        cameraUuid={cameraUuid}
        apiOverrideBaseUrl="https://your-api.example.com"
        rangeStartMs={windowStartSec * 1000}
        rangeEndMs={windowStartSec * 1000 + windowSec * 1000}
        currentTimeMs={currentMs}
        fetchSeekPoints
        onSeek={handleSeek}
      />
    </>
  );
}
```

The same two wires work for **any** video: a plain `<video>` (read/set `video.currentTime`),
an HLS/DASH player, or a multi-camera wall sharing one playhead. (`RhombusPlayer` does exactly
this internally — reach for it if you don't want to own the wiring yourself.)

---

## Authentication & tokens

The SDK is built around **short-lived federated session tokens** minted by your backend; your
Rhombus API key must never reach the browser.

### SDK-managed (recommended)

Omit `federatedSessionToken`. The SDK `POST`s to your token route (default
`/api/federated-token`) with `{ "durationSec": <tokenDurationSec> }` and **auto-refreshes**
before expiry (~97% of the effective TTL). Effective TTL = min of your `tokenDurationSec` and
any server hint in the response (`expiresInSec`, `expiresAtMs`, or `expiresAt`).

- **DASH / buffered:** keeps playing across refreshes (requests read the latest token).
- **Realtime:** reconnects the socket on each refresh (short blip).

### You-managed

Pass `federatedSessionToken`. The SDK never calls your token endpoint. Rotate by passing a new
string — DASH picks it up without a teardown; realtime reconnects.

### Two transport topologies


|                   | `apiOverrideBaseUrl` **omitted**                                                                           | `apiOverrideBaseUrl` **set** (proxy mode)                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Token request     | `window.location.origin` + `paths.federatedToken`                                                          | `apiOverrideBaseUrl` + `paths.federatedToken`                                |
| Media-URI request | **Direct to Rhombus** `api2.rhombussystems.com`                                                            | `apiOverrideBaseUrl` + `paths.mediaUris`                                     |
| Requirement       | Token minted with a Rhombus `**domain`** allowing this origin, or the browser call is blocked (CORS / 401) | Your backend proxies `getMediaUris`; browser never talks to Rhombus directly |


Proxy mode is also **required for built-in Save Clip** (see [Save Clip](#save-clip)).

---

## WAN vs LAN

`connectionMode` selects which `getMediaUris` URI to use:

- `**wan`** (default for buffered) — cloud path; works anywhere with internet.
- `**lan**` — direct-to-device path (`lanLive*` fields, first non-empty entry). The browser
must reach the camera/NVR host (routing, firewall, and **HTTPS-vs-HTTP mixed-content** rules
apply). Federated auth rides as `x-auth-scheme=federated-token` & `x-auth-ft` query params.

> **v1.0 breaking change:** LAN no longer uses `document.cookie` or `applyLanAuthCookie`, and
> `setRhombusLanAuthCookie` was removed. LAN now passes federated-token query params on the URL
> (works from `localhost`). Your Rhombus deployment must accept those params on LAN.

For LAN DASH, `applyBufferedStreamQuality={false}` disables the `_ds` downscale for
full-resolution LAN.

---

## Stream quality

**Buffered / DASH** — `bufferedStreamQuality`: `"HIGH"` (default) | `"MEDIUM"` | `"LOW"`. Each
step asks Rhombus to downscale **server-side** via a `_ds` query on segment/manifest URLs.
Changing it updates URLs **without** re-fetching the manifest or token. `applyBufferedStreamQuality={false}`
omits `_ds` entirely.

**Realtime** — `realtimeStreamQuality`: `"HD"` (default) | `"SD"`. `SD` rewrites the socket
path `/ws` → `/wsl`. Changing it **reconnects** the socket (brief blip).

```tsx
const [q, setQ] = useState<RhombusBufferedStreamQuality>("HIGH");
<RhombusBufferedPlayer cameraUuid="…" bufferedStreamQuality={q} />
```

On `RhombusPlayer`, these are `bufferedStreamQuality` / `realtimeStreamQuality`, and the
optional `showLiveTypeSwitcher` surfaces them in the bar.

---

## Auto-recovery / reconnect

Both transports retry **indefinitely** with exponential backoff (2s → 4s → 8s → 16s → … capped
at `maxRetryIntervalMs`, default 30s). Backoff resets to 2s after ~30s of healthy playback.
Set `maxRetryIntervalMs={0}` to disable; pass `onRecoveryAttempt` to drive "reconnecting…" UI.

**Buffered (DASH)** rebuilds Dash.js when a recoverable error fires, the initial buffer never
loads within `stallTimeoutMs`, or `currentTime` stops advancing for `stallTimeoutMs` (not
paused/seeking/ended).

**Realtime (WebSocket)** reopens the socket on `onerror`/unexpected `onclose`, if it fails to
open within ~8s, if no decoded frame arrives within `stallTimeoutMs` (the classic "WAN black
screen until refresh"), or on a server `reconnect` message.

```tsx
function CameraWithStatus({ cameraUuid }: { cameraUuid: string }) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  return (
    <div>
      {attempt > 0 ? <div role="status">Reconnecting (attempt {attempt})…</div>
        : error ? <div role="alert">Playback error: {error.message}</div> : null}
      <RhombusBufferedPlayer
        cameraUuid={cameraUuid}
        onReady={() => { setAttempt(0); setError(null); }}
        onError={setError}
        onRecoveryAttempt={setAttempt}
      />
    </div>
  );
}
```

---

## Backend contract

### Token endpoint (always required)

`POST` your `paths.federatedToken` route (default `/api/federated-token`):

- **Request:** `{ "durationSec": number }`.
- **Server:** forward to Rhombus `POST /org/generateFederatedSessionToken` with your
**server-side** API key. Include a Rhombus `**domain`** so the browser may call
`api2.rhombussystems.com` in direct mode.
- **Response JSON:** must include `federatedSessionToken`. Optionally `expiresInSec` /
`expiresAtMs` / `expiresAt` so refresh timing matches your server-enforced cap.

### Media-URI endpoint (proxy mode only)

Needed when `apiOverrideBaseUrl` is set. `POST` your `paths.mediaUris` route (default
`/api/media-uris`):

- **Request:** `{ "cameraUuid": string }`.
- **Server:** forward Rhombus `POST /camera/getMediaUris` and return the JSON **as-is** so the
relevant fields survive: `wanLiveMpdUri` / `wanVodMpdUriTemplate` (WAN DASH), `lanLiveMpdUris`
/ `lanLiveMpdUri` / `lanVodMpdUrisTemplates` (LAN DASH), `wanLiveH264Uri(s)` /
`lanLiveH264Uri(s)` (realtime).

A minimal Express proxy:

```js
app.post("/api/federated-token", async (req, res) => {
  const r = await fetch("https://api2.rhombussystems.com/api/org/generateFederatedSessionToken", {
    method: "POST",
    headers: { "x-auth-apikey": process.env.RHOMBUS_API_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ durationSec: req.body.durationSec, domain: ".your-domain.com" }),
  });
  res.json(await r.json());
});

app.post("/api/media-uris", async (req, res) => {
  const r = await fetch("https://api2.rhombussystems.com/api/camera/getMediaUris", {
    method: "POST",
    headers: { "x-auth-apikey": process.env.RHOMBUS_API_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ cameraUuid: req.body.cameraUuid }),
  });
  res.json(await r.json()); // return upstream as-is
});
```

### Footage seekpoints (Timeline, optional)

When `Timeline`/`RhombusPlayer` fetches seekpoints, it `POST`s `paths.footageSeekpoints`
(proxy default `/api/footage-seekpoints`) with `{ cameraUuid, startTime, duration, includeAnyMotion }`
(seconds). Forward to Rhombus `POST /camera/getFootageSeekpointsV2` and return the JSON as-is.

### Presence windows (footage availability, optional)

When `Timeline`/`RhombusPlayer` fetches footage availability (and before every built-in clip
export unless `requireFootage: "off"`), it `POST`s `paths.presenceWindows` (proxy default
`/api/presence-windows`) with `{ cameraUuid, startTimeSec, durationSec }` (seconds). Forward to
Rhombus `POST /camera/getPresenceWindows` **with your server-side API key** and return the JSON
as-is (`{ presenceWindows: { VideoCloud: [...], VideoLocal: [...] } }`). If the route is
missing, availability rendering stays in the legacy mode and the clip pre-check fails open —
nothing breaks, you just don't get gap detection.

### Clip routes (built-in Save Clip)

Built-in export needs three routes (defaults shown; override via `saveClip.paths`). All are
**API-key authed server-side** — the federated token is *not* used here:


| Route                | Method | Forwards to                  | Notes                                                                                                       |
| -------------------- | ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/api/save-clip`     | `POST` | `/video/spliceV3`            | Forward the SDK's body as-is; return `{ clipUuid }`.                                                        |
| `/api/clip-progress` | `POST` | `/event/getClipWithProgress` | Forward `{ clipUuid }`; return the `{ clip: { status, percentComplete, currentOperation, clipLocation } }`. |
| `/api/clip-download` | `GET`  | media host                   | `?clipUuid=…&region=…` → stream `/media/metadata/{region}/{clipUuid}.mp4` with the API key.                 |


Each route forwards to the Rhombus endpoint with your **server-side** API key (mirroring the
token / media-URI routes above); `/api/clip-download` resolves the media host + `region` and
streams the file back.

> **Never** put Rhombus API keys in frontend headers.

---

## Exported API surface

**Components**

- `RhombusPlayer` — unified live/VOD player with controls.
- `RhombusBufferedPlayer` — DASH live & VOD.
- `RhombusRealtimePlayer` — realtime H.264 live.
- `RhombusPlayerControls` — the default control bar (exported for advanced composition).
- `RhombusDateTimePicker` — standalone date/time jump picker (footage-aware disabled days).
- `Timeline` — standalone canvas scrubber.

**Constants** (value **and** type — usable as named members or plain strings)

- `RhombusPlayerControl` — `{ Play, GoLive, Rewind, Speed, Zoom, Snapshot, SaveClip, Timeline, LiveType, VideoFit, GoToDate }`.

**Types**

- Player props: `RhombusPlayerProps`, `RhombusBufferedPlayerProps`, `RhombusRealtimePlayerProps`,
`RhombusPlayerBaseProps`, `TimelineProps`.
- Handles: `RhombusPlayerHandle`, `RhombusBufferedPlayerHandle`, `RhombusRealtimePlayerHandle`,
`TimelineHandle`.
- Unified player: `RhombusPlayerState`, `RhombusPlayerMode`,
`RhombusPlayerClassNames`, `RhombusLiveTransport`, `RhombusVideoFit`, `RhombusSnapshotResult`, `RhombusClipRange`,
`RhombusClipVisibility`, `RhombusClipExportOptions`, `RhombusClipExportPhase`,
`RhombusClipExportStatus`, `RhombusSaveClipConfig`, `RhombusPlayerTimelineConfig`.
- Timeline: `TimelineMark`, `TimelineColors`, `RhombusFootageSeekPoint`.
- Footage availability: `RhombusFootageWindow`, `RhombusFootageAvailability`, `RhombusFootageGap`,
`RhombusRangeCoverage`, `FetchPresenceWindowsOptions`.
- Quality / mode: `RhombusBufferedStreamQuality`, `RhombusRealtimeStreamQuality`,
`RhombusConnectionMode`, `RhombusRealtimeConnectionMode`, `RhombusPlayerPaths`.
- Misc: `FederatedTokenFetchResult`, `RhombusDashPlayerCallbacks`, `RhombusDashQualityCallbacks`.

**Helpers** (most apps never need these — the components do all of this internally)


| Export                                                                                                                    | Purpose                                                           |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `fetchFederatedSessionToken(url, headers, durationSec, usedDefaultPath)`                                                  | Manually fetch a token.                                           |
| `getFederatedTokenRefreshDelayMs(args)`                                                                                   | Compute the next refresh delay from TTL + hints.                  |
| `formatVodMpdUri(template, startTimeSec, durationSec)`                                                                    | Fill `{START_TIME}`/`{DURATION}` in a VOD template.               |
| `getDefaultRhombusDashSettings()` / `getDefaultRhombusVodDashSettings()`                                                  | The Dash.js settings the SDK uses.                                |
| `resolveLiveH264WebSocketUrl(options)`                                                                                    | Resolve the authed realtime socket URL yourself.                  |
| `startRhombusRealtimeSession(options)`                                                                                    | Drive the WebSocket + WebCodecs decode loop onto your own canvas. |
| `snapshotCanvasElement(canvas, opts)` / `snapshotVideoElement(video, opts)`                                               | Capture a frame → `RhombusSnapshotResult`.                        |
| `chooseVodAnchor`, `isWithinWindow`, `vodOffsetToWallClock`, `wallClockToVodOffset`, `shouldSwitchToLive`, `isAtLiveEdge` | Pure VOD time-math helpers used by the switching logic.           |
| `requestClipSplice(options)` / `fetchClipProgress(options)` / `buildClipDownloadUrl(options)`                             | Build your own Save Clip flow.                                    |
| `fetchPresenceWindows(options)` / `mergeFootageWindows` / `computeFootageGaps` / `computeRangeCoverage`                   | Footage-availability client + coverage math for custom gap UIs.   |


---

## Browser support

- `**RhombusBufferedPlayer`** (and `RhombusPlayer` in buffered mode): any modern browser with
MSE (Dash.js). Broadest support.
- `**RhombusRealtimePlayer**` (and `RhombusPlayer`'s default live transport): needs **WebCodecs**
`VideoDecoder` with H.264 — Chrome, Edge, Safari 16.4+. Firefox H.264 is still limited.

`RhombusPlayer` feature-detects WebCodecs and **auto-falls back** to buffered live; for the
low-level players, detect yourself:

```tsx
const supportsRealtime = typeof window !== "undefined" && "VideoDecoder" in window;
return supportsRealtime
  ? <RhombusRealtimePlayer cameraUuid={id} connectionMode="wan" />
  : <RhombusBufferedPlayer cameraUuid={id} />;
```

---

## Troubleshooting


| Symptom                                              | Likely cause / fix                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **404 on `/api/federated-token`**                    | Token route not implemented / wrong path. Implement it or set `paths.federatedToken`. Check the console `[Rhombus…]` hint.                           |
| **CORS / 401 / 403 on `getMediaUris`** (direct mode) | Token not minted with a `domain` authorizing this origin. Add `domain` server-side, or set `apiOverrideBaseUrl` to proxy media.                      |
| **Save Clip button missing**                         | Built-in export needs proxy mode — set `apiOverrideBaseUrl`. Without it, use `onClipRangeSelect` and export yourself.                                |
| **Clip download 404**                                | The `/api/clip-download` route can't resolve the media host/region. Verify the route streams `/media/metadata/{region}/{uuid}.mp4` with the API key. |
| **Realtime shows black, then recovers**              | Normal stall-watchdog reconnect. Tune `stallTimeoutMs`; surface `onRecoveryAttempt`.                                                                 |
| **Realtime never renders, no errors**                | Browser lacks WebCodecs H.264 (e.g. Firefox). Use buffered, or let `RhombusPlayer` fall back.                                                        |
| **LAN won't connect**                                | Browser can't reach the device host, or mixed content (HTTPS page → HTTP device). Check routing/firewall and protocol.                               |
| **VOD / timeline empty for a range**                 | No recorded footage for that window. Pick a range when the camera was recording.                                                                     |
| **404 on `/api/presence-windows`**                   | Availability route not implemented / wrong path. Implement it (forward `/camera/getPresenceWindows`) or set `paths.presenceWindows`. Harmless otherwise: gap rendering stays off and the clip pre-check fails open. |
| **VOD plays a "VIDEO NOT AVAILABLE" pattern**        | Rhombus serves placeholder frames (HTTP 200) where footage doesn't exist — not a player bug. Enable `timeline.fetchAvailability` + the presence-windows route to surface those gaps and gate clip exports.          |
| **Short blip on quality / token change (realtime)**  | Expected — realtime reconnects the socket. Buffered changes are seamless.                                                                            |


---

## Migrating from 1.x → 2.0

2.0 is mostly **additive** — it introduces the unified [`RhombusPlayer`](#rhombusplayer--the-unified-player),
the standalone [`Timeline`](#timeline--standalone-scrubber), the `RhombusPlayerControl`
constant, and the snapshot / clip / VOD-time helpers. None of that requires changes to
existing 1.x code.

The major bump is warranted by **one breaking behavioral change**:

### ⚠️ Breaking: realtime `onReady` now fires on every (re)connect

`RhombusRealtimePlayer`'s `onReady` prop — and the `onReady` option of the exported
`startRhombusRealtimeSession` helper — used to fire **once per mount** (only the first
successful WebSocket connection). In 2.0 it fires **every time the socket reaches `OPEN`** —
the initial connect *and* each successful auto-reconnect (after a stall, network drop, or
token-refresh reconnect).

This makes it symmetric with `onRecoveryAttempt` (fire on drop → clear on reconnect), but it
means any `onReady` handler you used for **one-time** setup will now run repeatedly.

**Who is affected:** only code using `RhombusRealtimePlayer` `onReady` (or
`startRhombusRealtimeSession` `onReady`) to do something that must happen *once*. If you only
used `onReady` to hide a "connecting…" indicator, **no change is needed** — the extra firings
are harmless (and arguably better).

**How to migrate** — guard one-time work yourself:

```tsx
// 1.x — relied on onReady firing exactly once:
<RhombusRealtimePlayer
  cameraUuid={id}
  connectionMode="wan"
  onReady={runOnceSetup}
/>

// 2.0 — make the once-only intent explicit; do per-connect work freely:
function LiveView({ id }: { id: string }) {
  const didInit = useRef(false);
  return (
    <RhombusRealtimePlayer
      cameraUuid={id}
      connectionMode="wan"
      onReady={() => {
        clearReconnectingBanner();          // fine to run on every (re)connect
        if (!didInit.current) {
          didInit.current = true;
          runOnceSetup();                    // runs only on the first connect
        }
      }}
    />
  );
}
```

> `RhombusBufferedPlayer`'s `onReady` is unchanged (it fires when Dash.js initializes and the
> manifest loads). This change is realtime-only. If you specifically need the old fire-once
> realtime behavior and don't want to guard it yourself, open an issue — a one-shot option
> could be reintroduced.

### Not breaking (no action needed)

- The auth/endpoint/resilience props were consolidated into a shared `RhombusPlayerBaseProps`
type, but `RhombusBufferedPlayerProps` / `RhombusRealtimePlayerProps` keep the **same shape**.
- Both players now accept a `ref` (`forwardRef`) — additive; existing usage is unaffected.
- `RhombusPlayerPaths` gained an optional `footageSeekpoints` field.
- `RhombusPlayerControl` is exported as a named constant **and** a string union, so existing
string literals keep working.

---

## License

MIT