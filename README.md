# Rhombus React SDK (`@rhombussystems/react`)

React + TypeScript library for streaming Rhombus cameras using **federated session tokens**: MPEG-DASH live (Dash.js) via **`RhombusBufferedPlayer`**, and low-latency **H.264 over WebSocket** via **`RhombusRealtimePlayer`** (WebCodecs). Your Rhombus API key must never ship to the browser; the usual pattern is a short-lived federated token from your backend (or a token minted server-side with a browser-authorized `domain` — see the Rhombus [**Generate federated session token**](https://docs.rhombus.com/#927fe3b3-7e39-4709-9d4e-8d3da95940cd) API docs).

## Install

Add the published package to your application (requires **React 18+**):

```bash
npm install @rhombussystems/react
```

With Yarn or pnpm: `yarn add @rhombussystems/react` or `pnpm add @rhombussystems/react`.

**Peer dependencies:** `react` and `react-dom` (**>= 18**). Install them in your app if needed. **dashjs** is included as a dependency of this package for DASH playback—you do not need to install it separately for **`RhombusBufferedPlayer`**.

**Realtime WebSocket:** **`RhombusRealtimePlayer`** uses the browser **WebCodecs** `VideoDecoder` (Chrome, Edge, Safari 16.4+ with H.264; Firefox support is still limited). There is no extra npm dependency for realtime mode.

## Quick start

```tsx
import { RhombusBufferedPlayer } from "@rhombussystems/react";

export function CameraView() {
  return <RhombusBufferedPlayer cameraUuid="YOUR_CAMERA_UUID" />;
}
```

> [!WARNING]
> **Server setup required.** The SDK calls your app’s origin for a token, then Rhombus for media. Your server **must** implement **`POST /api/federated-token`** (the default path), or set **`paths.federatedToken`** to match whatever route you expose. Server side, when you call Rhombus **`generateFederatedSessionToken`**, include a **`domain`** that allows this page’s origin to use the token against `api2.rhombussystems.com` from the browser—otherwise you may see CORS or auth failures. 

See the Rhombus [**Generate federated session token**](https://docs.rhombus.com/#927fe3b3-7e39-4709-9d4e-8d3da95940cd) API docs. If something fails, check the browser console for **`[RhombusBufferedPlayer]`** messages.

Under the hood: the SDK **`POST`**s to **`window.location.origin` + `paths.federatedToken`** (default **`/api/federated-token`**), then **`POST`**s **media URIs** to Rhombus (`rhombusApiBaseUrl`, default **`https://api2.rhombussystems.com/api`**, path default **`/camera/getMediaUris`**) with federated auth headers.

## Realtime WebSocket: `RhombusRealtimePlayer`

Use **`getMediaUris`** (same POST as DASH). The component reads **`wanLiveH264Uri`** or **`wanLiveH264Uris`**, and **`lanLiveH264Uri`** or **`lanLiveH264Uris`** (Rhombus may return either a single string or an array). It decodes Rhombus’s TLV-framed H.264 stream and draws to a **`<canvas>`**.

- **`connectionMode="wan"`** — Picks the WAN H.264 WebSocket URI and appends **`x-auth-scheme=federated-token`** and **`x-auth-ft=<token>`** to the WebSocket URL (same idea as DASH segment URLs).
- **`connectionMode="lan"`** — Picks the LAN H.264 WebSocket URI, does **not** put federated auth on the URL (Rhombus LAN endpoints reject **`x-auth-scheme`** on the socket). Before connecting, the SDK can set a cookie **`RFT=<federated token>`** via **`setRhombusLanAuthCookie`** / **`applyLanAuthCookie`** (default **`true`**). Configure **`lanAuthCookieDomain`**, **`lanAuthCookiePath`**, **`lanAuthCookieSecure`**, etc. when your deployment allows the browser to set a cookie visible to the WebSocket origin.

> [!WARNING]
> **LAN cookies and browser security:** `document.cookie` cannot set a cookie for arbitrary hosts. Serving the app from **`localhost`** while the WebSocket is **`wss://…lan…`** typically means the **`RFT`** cookie **cannot** be applied by the page; LAN realtime works when your app and cookie domain align with Rhombus’s LAN DNS layout (or you set the cookie through another same-origin/auth flow). Use **`applyLanAuthCookie={false}`** if your integration sets **`RFT`** elsewhere.

```tsx
import { RhombusRealtimePlayer } from "@rhombussystems/react";

export function RealtimeCameraWan() {
  return (
    <RhombusRealtimePlayer
      cameraUuid="YOUR_CAMERA_UUID"
      connectionMode="wan"
      apiOverrideBaseUrl="https://your-api.example.com"
    />
  );
}
```

Optional exports for custom wiring: **`resolveLiveH264WebSocketUrl`**, **`startRhombusRealtimeSession`**, **`setRhombusLanAuthCookie`**.

## Stream quality (optional)

You can change how aggressively Rhombus serves **live** video without touching token or media-URI fetching yourself.

### DASH — `RhombusBufferedPlayer`

- **`bufferedStreamQuality`**: `"HIGH"` (default) | `"MEDIUM"` | `"LOW"`. Each step asks Rhombus to downscale on the **server** by adding a `_ds=…` query on **segment and manifest** URLs (same idea as Rhombus Console buffered quality). Dash.js ABR stays off; quality follows this setting.
- **`applyBufferedStreamQuality`**: default **`true`**. Set **`false`** to omit `_ds` entirely (for example when you know the viewer is on LAN and should not trigger WAN downscale logic).

Changing **`bufferedStreamQuality`** or **`applyBufferedStreamQuality`** does **not** re-fetch the MPD or federated token—the Dash **`RequestModifier`** reads the latest values on each request, so a simple prop update is enough.

### Realtime WebSocket — `RhombusRealtimePlayer`

- **`realtimeStreamQuality`**: **`"HD"`** (default) | **`"SD"`**. **`SD`** rewrites the socket path **`/ws` → `/wsl`**, which requests a lower-resolution stream from Rhombus (aligned with Console realtime SD/HD).

Changing **`realtimeStreamQuality`** **closes and reopens** the WebSocket, so expect a short blip—there is no in-place path switch.

Types are exported as **`RhombusBufferedStreamQuality`** and **`RhombusRealtimeStreamQuality`**.

```tsx
import {
  RhombusBufferedPlayer,
  RhombusRealtimePlayer,
  type RhombusBufferedStreamQuality,
  type RhombusRealtimeStreamQuality,
} from "@rhombussystems/react";
import { useState } from "react";

export function CameraWithQualityControls() {
  const [dashQ, setDashQ] = useState<RhombusBufferedStreamQuality>("HIGH");
  const [rtQ, setRtQ] = useState<RhombusRealtimeStreamQuality>("HD");

  return (
    <>
      <label>
        DASH quality{" "}
        <select value={dashQ} onChange={e => setDashQ(e.target.value as RhombusBufferedStreamQuality)}>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium</option>
          <option value="LOW">Low</option>
        </select>
      </label>
      <RhombusBufferedPlayer cameraUuid="YOUR_CAMERA_UUID" bufferedStreamQuality={dashQ} />

      <label>
        Realtime{" "}
        <select value={rtQ} onChange={e => setRtQ(e.target.value as RhombusRealtimeStreamQuality)}>
          <option value="HD">HD</option>
          <option value="SD">SD</option>
        </select>
      </label>
      <RhombusRealtimePlayer
        cameraUuid="YOUR_CAMERA_UUID"
        connectionMode="wan"
        realtimeStreamQuality={rtQ}
      />
    </>
  );
}
```

## Optional: `apiOverrideBaseUrl` (backend on another host)

When **set**, both the federated-token request and the media-URIs request use this base:

- `joinUrl(apiOverrideBaseUrl, paths.federatedToken)` (default path `/api/federated-token`)
- `joinUrl(apiOverrideBaseUrl, paths.mediaUris)` (default path `/api/media-uris`)

Use this if your API lives on another origin/port, or you do not use a domain-scoped federated token and need your own backend to forward Rhombus requests (so the browser never talks to Rhombus directly).

```tsx
<RhombusBufferedPlayer
  cameraUuid="YOUR_CAMERA_UUID"
  apiOverrideBaseUrl="https://your-api.example.com"
/>
```

## Props reference

Shared and **RhombusBufferedPlayer**-specific:

| Prop | Role |
|------|------|
| `apiOverrideBaseUrl` | Optional. If omitted, token uses same-origin + Rhombus API for media. If set, both requests use this base. |
| `rhombusApiBaseUrl` | Optional. Rhombus REST base when `apiOverrideBaseUrl` is omitted. Default `https://api2.rhombussystems.com/api`. |
| `paths.federatedToken` | Default `/api/federated-token`. Override if your route differs. |
| `paths.mediaUris` | With override: default `/api/media-uris`. Without override: default `/camera/getMediaUris` on Rhombus. |
| `federatedSessionToken` | If set, skips the token `fetch`; media step still runs (Rhombus or override, depending on `apiOverrideBaseUrl`). |
| `headers` / `getRequestHeaders` | Merged into the **federated-token** request always; into the **media-URIs** request only when `apiOverrideBaseUrl` is set. Not sent to Rhombus in direct mode. |
| `bufferedStreamQuality` | **RhombusBufferedPlayer** only. `HIGH` \| `MEDIUM` \| `LOW`. Server downscale via `_ds` on DASH requests. Default `HIGH`. Updating does not re-fetch the manifest. |
| `applyBufferedStreamQuality` | **RhombusBufferedPlayer** only. Default `true`. If `false`, `_ds` is not appended. |

**RhombusRealtimePlayer** also accepts everything above that applies to token/media resolution, plus:

| Prop | Role |
|------|------|
| `connectionMode` | `"wan"` or `"lan"` — see **Realtime WebSocket** above. |
| `realtimeStreamQuality` | `HD` \| `SD`. Default `HD`. `SD` uses `/wsl` instead of `/ws`; changing this prop reconnects the WebSocket. |
| `applyLanAuthCookie`, `lanAuthCookieName`, … | LAN cookie options (see realtime section above). |

Non-OK responses (e.g. **404** on the default token path) log **`[RhombusBufferedPlayer]`** hints in the console with the request URL and how to adjust `paths` / `apiOverrideBaseUrl`, while **`onError`** still receives a concise `Error`.

## Backend routes

### Same-origin token endpoint (typical with direct Rhombus)

Your server should expose **`POST`** (default **`/api/federated-token`**):

- Body: `{ "durationSec": number }` (forward to Rhombus `POST /org/generateFederatedSessionToken` with your API key server-side).
- Response JSON must include `federatedSessionToken` (string).
- When minting the token, pass Rhombus **`domain`** so the browser may call `api2.rhombussystems.com` for `getMediaUris` ([**Generate federated session token**](https://docs.rhombus.com/#927fe3b3-7e39-4709-9d4e-8d3da95940cd)).

### Override mode (both hops through your server)

Your server exposes two **`POST`** JSON endpoints (paths configurable; defaults **`/api/federated-token`** and **`/api/media-uris`**):

1. **Federated token** — as above.
2. **Media URIs** — body `{ "cameraUuid": string }`; response must include `wanLiveMpdUri`. Forward to Rhombus `POST /camera/getMediaUris`.

The player appends `x-auth-scheme=federated-token` and `x-auth-ft=<token>` to all media segment requests. See the [Rhombus player-example](https://github.com/rhombussystems/player-example) and `ai-context.md`.

Do **not** put Rhombus API keys in frontend headers.

## Developing this package (maintainers)

If you are working in this repository rather than consuming the published package:

```bash
yarn install
yarn build
```

Typecheck only: `yarn typecheck`. Publishing: `npm publish --access public` (from a clean `yarn build`).

## License

MIT
