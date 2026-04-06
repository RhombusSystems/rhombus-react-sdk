# Rhombus React SDK (`@rhombussystems/react`)

React + TypeScript library for streaming Rhombus cameras over MPEG-DASH (Dash.js) using **federated session tokens** and a **backend proxy** (your API token must never ship to the browser).

This repository is **only** the publishable SDK—not a monorepo. For a local Vite + proxy smoke test, use the sibling folder **`rhombus-react-example`** next to this repo (same parent directory).

## Install & build

```bash
yarn install
yarn build
```

Publish:

```bash
npm publish --access public
```

## Quick start (consumers)

```tsx
import { RhombusPlayer } from "@rhombussystems/react";

export function CameraView() {
  return (
    <RhombusPlayer
      cameraUuid="YOUR_CAMERA_UUID"
      proxyBaseUrl="https://your-api.example.com"
    />
  );
}
```

### Proxy contract

Your server must expose two `POST` JSON endpoints (paths are configurable via `paths` on `RhombusPlayer`; defaults are `/api/federated-token` and `/api/media-uris`).

1. **Federated token** — body: `{ "durationSec": number }`  
   Response must include `federatedSessionToken` (string). Forward to Rhombus `POST /org/generateFederatedSessionToken` with your API key on the server.

2. **Media URIs** — body: `{ "cameraUuid": string }`  
   Response must include `wanLiveMpdUri` (string). Forward to Rhombus `POST /camera/getMediaUris`.

The player appends `x-auth-scheme=federated-token` and `x-auth-ft=<token>` to all media segment requests. See the [Rhombus player-example](https://github.com/rhombussystems/player-example) HTML and `ai-context.md` for the full flow.

Optional props: `headers` / `getRequestHeaders` for whatever your proxy expects (e.g. session cookies). Do **not** put Rhombus API keys in frontend headers.

## Local standalone example (sibling repo)

With `rhombus-react-sdk` and `rhombus-react-example` as siblings (e.g. both under `git/`):

```bash
cd ../rhombus-react-example
yarn install
cp .env.example .env
# Edit .env: RHOMBUS_API_TOKEN, VITE_CAMERA_UUID
yarn dev
```

The example links `@rhombussystems/react` via `file:../rhombus-react-sdk` and Vite aliases to this repo’s `src/` for fast HMR. It is **private** and **not** published.

## License

MIT
