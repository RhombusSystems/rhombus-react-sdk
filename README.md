# Rhombus React SDK (`@rhombussystems/react`)

React + TypeScript library for streaming Rhombus cameras over MPEG-DASH (Dash.js) using **federated session tokens**. Your Rhombus API key must never ship to the browser; the usual pattern is a short-lived federated token from your backend (or a token minted server-side with a browser-authorized `domain` — see the Rhombus [**Generate federated session token**](https://docs.rhombus.com/#927fe3b3-7e39-4709-9d4e-8d3da95940cd) API docs).

## Install

Add the published package to your application (requires **React 18+**):

```bash
npm install @rhombussystems/react
```

With Yarn or pnpm: `yarn add @rhombussystems/react` or `pnpm add @rhombussystems/react`.

**Peer dependencies:** `react` and `react-dom` (**>= 18**). Install them in your app if needed. **dashjs** is included as a dependency of this package—you do not need to install it separately for normal use.

## Quick start

```tsx
import { RhombusPlayer } from "@rhombussystems/react";

export function CameraView() {
  return <RhombusPlayer cameraUuid="YOUR_CAMERA_UUID" />;
}
```

> [!WARNING]
> **Server setup required.** The SDK calls your app’s origin for a token, then Rhombus for media. Your server **must** implement **`POST /api/federated-token`** (the default path), or set **`paths.federatedToken`** to match whatever route you expose. Server side, when you call Rhombus **`generateFederatedSessionToken`**, include a **`domain`** that allows this page’s origin to use the token against `api2.rhombussystems.com` from the browser—otherwise you may see CORS or auth failures. 

See the Rhombus [**Generate federated session token**](https://docs.rhombus.com/#927fe3b3-7e39-4709-9d4e-8d3da95940cd) API docs. If something fails, check the browser console for **`[RhombusPlayer]`** messages.

Under the hood: the SDK **`POST`**s to **`window.location.origin` + `paths.federatedToken`** (default **`/api/federated-token`**), then **`POST`**s **media URIs** to Rhombus (`rhombusApiBaseUrl`, default **`https://api2.rhombussystems.com/api`**, path default **`/camera/getMediaUris`**) with federated auth headers.

## Optional: `apiOverrideBaseUrl` (backend on another host)

When **set**, both the federated-token request and the media-URIs request use this base:

- `joinUrl(apiOverrideBaseUrl, paths.federatedToken)` (default path `/api/federated-token`)
- `joinUrl(apiOverrideBaseUrl, paths.mediaUris)` (default path `/api/media-uris`)

Use this if your API lives on another origin/port, or you do not use a domain-scoped federated token and need your own backend to forward Rhombus requests (so the browser never talks to Rhombus directly).

```tsx
<RhombusPlayer
  cameraUuid="YOUR_CAMERA_UUID"
  apiOverrideBaseUrl="https://your-api.example.com"
/>
```

## Props reference

| Prop | Role |
|------|------|
| `apiOverrideBaseUrl` | Optional. If omitted, token uses same-origin + Rhombus API for media. If set, both requests use this base. |
| `rhombusApiBaseUrl` | Optional. Rhombus REST base when `apiOverrideBaseUrl` is omitted. Default `https://api2.rhombussystems.com/api`. |
| `paths.federatedToken` | Default `/api/federated-token`. Override if your route differs. |
| `paths.mediaUris` | With override: default `/api/media-uris`. Without override: default `/camera/getMediaUris` on Rhombus. |
| `federatedSessionToken` | If set, skips the token `fetch`; media step still runs (Rhombus or override, depending on `apiOverrideBaseUrl`). |
| `headers` / `getRequestHeaders` | Merged into the **federated-token** request always; into the **media-URIs** request only when `apiOverrideBaseUrl` is set. Not sent to Rhombus in direct mode. |

Non-OK responses (e.g. **404** on the default token path) log **`[RhombusPlayer]`** hints in the console with the request URL and how to adjust `paths` / `apiOverrideBaseUrl`, while **`onError`** still receives a concise `Error`.

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
