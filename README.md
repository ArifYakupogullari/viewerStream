# StreamBIM Gaussian Splat Widget

A [StreamBIM widget](https://github.com/streambim/streambim-widget-api) that
renders a Gaussian Splatting `.ply` scene (via
[`@mkkellogg/gaussian-splats-3d`](https://github.com/mkkellogg/GaussianSplats3D),
WebGL/Three.js) in sync with StreamBIM's camera.

Because the splat scene and the BIM model are assumed to share the same world
coordinate space, **no spatial alignment/registration is performed** - the
widget simply mirrors StreamBIM's camera position/orientation/FOV onto the
splat viewer's Three.js camera every time it changes.

## How it works

- `index.html` / `src/main.js` - the widget itself. On load it:
  1. Connects to StreamBIM via `StreamBIM.connectToParent` (`src/streambim.js`).
  2. **Inside StreamBIM (document mode):** takes the project from
     `?projectId=` or, if absent, from StreamBIM itself (`getProjectId()`),
     lists the project's `.ply` documents through `makeApiRequest()` (model
     picker if there are several, `?documentId=` preselects), asks
     `/project-<id>/api/v1/documents/<doc>/downloadlink` for a time-limited
     link, resolves it against StreamBIM's origin (it is a relative path like
     `/documents/1078/_download/scene.ply?microtoken=…`; falls back to
     `/project-<id>/…` if the site-root form fails), downloads it once with a
     progress readout and loads it from memory. Access control stays inside
     StreamBIM.
  3. **`?plyUrl=<url>`:** loads that scene directly (testing outside StreamBIM).
  4. **Outside StreamBIM** (no parent answers within 5 s): shows the Remote
     panel for a Vera session link.
  5. Subscribes to StreamBIM's `cameraChanged` event (and reads
     `getCameraState()` once on connect) and applies the resulting
     position/orientation/FOV to the splat viewer's camera via
     `applyCameraState()`.
- Camera sync is **one-way**: StreamBIM drives the splat camera. The widget
  never calls `setCameraState`/`setCameraPosition`.
- `host/index.html` / `src/host/host.js` - a "fake StreamBIM" dev
  harness. It loads the widget in an iframe via `StreamBIM.connectToChild`,
  stubs the StreamBIM API methods the widget calls (including the document
  endpoints, answering like StreamBIM with a relative token link), and
  provides manual controls (position/target/up/FOV, a quaternion-mode toggle,
  and an orbit animation) to fire fake `cameraChanged` events at the widget.

## Remote rendering on Vera

Large site splats (tens of millions of Gaussians, GBs of `.ply`) are too heavy
to download and sort in a browser, let alone on a phone. The widget can
instead show frames rendered on a Vera GPU: StreamBIM still drives the camera
exactly as above, but the camera goes to a renderer on Vera and JPEG frames
come back.

```
StreamBIM ──camera──▶ widget (iframe) ──postMessage──▶ relay popup ──WebSocket──▶ render_server.py
                       ◀──────────────── frames ◀──────────────────────◀── gsplat on an A100
```

- `server/render_server.py` - aiohttp + [gsplat](https://github.com/nerfstudio-project/gsplat).
  Loads a graphdeco/INRIA `point_cloud.ply` (what `final_hope.sh` writes) onto
  the GPU, renders only the newest camera it has been sent, and returns JPEGs.
  It also serves a standalone viewer (`/`, mouse + touch navigation) and the
  relay popup (`/relay`). `--backend fake` renders a test pattern without a GPU.
- `server/static/protocol.js` - the camera/frame protocol, shared by the
  server's pages and the widget (`src/remoteViewer.js`).
- `server/vera/` - `setup_env.sh` (one-time env inside `gs.sif`),
  `launch.py` + `viewerstream.ipynb` (start/stop from an OnDemand Jupyter
  session), `render_server.sh` (same thing as a batch job).

### Access and security

- The renderer is reached only through the Vera portal's authenticated proxy,
  `https://vera.c3se.chalmers.se/node/<host>/<port>/`, so every viewer logs
  in with a Chalmers account. It deliberately listens **outside 8888-8988**:
  that range is forwarded by C3SE's *unauthenticated* public proxy
  (`proxy.c3se.chalmers.se`), and `render_server.py` refuses those ports.
- Other cluster users can reach `<host>:<port>` directly, so each run gets a
  random session secret (the `?s=` in the link) that every WebSocket must
  present, and WebSocket `Origin` must be the portal. The secret is passed to
  the server via the environment, never on the command line.
- Inside StreamBIM the widget is a cross-origin iframe, where browsers won't
  send the portal login cookie. So **Connect** opens a small popup on the
  portal (log in there if asked); the popup holds the WebSocket and relays
  camera ↔ frames with the widget via `postMessage`, accepting messages only
  from its opener on an allowed widget origin (`--widget-origin`; default:
  the GitHub Pages widget, plus `localhost:5173` with `--dev`). Keep the popup open while streaming.
- The portal requires a Swedish university network: eduroam or the Chalmers
  VPN, including on phones.
- The link only works while that renderer runs; it stops on
  `session.stop()`, when the OnDemand session ends, or after 30 minutes with
  no viewer (`--idle-timeout`).

### Running it

One-time, from a terminal inside a Vera OnDemand session with a GPU:

```sh
git clone https://github.com/ArifYakupogullari/viewerStream.git /cephyr/users/ahmetari/Vera/viewerStream
cd /cephyr/users/ahmetari/Vera/viewerStream
bash server/vera/setup_env.sh      # builds the venv inside gs.sif, compiles + smoke-tests gsplat
```

Each session:

1. At https://vera.c3se.chalmers.se start **Jupyter** with one **A100** for
   as long as you want to stream.
2. Open `server/vera/viewerstream.ipynb`, set `PLY`, run the start cell. It
   prints the session link and a QR code.
3. Open the link in a browser or phone (standalone viewer), **or** in
   StreamBIM click **Remote** in the widget, paste the link, press
   **Connect**, and log in to the popup if asked.

Without Jupyter: `sbatch server/vera/render_server.sh /path/to/point_cloud.ply`
from the repo root; the link is written to `~/viewerstream-logs/session-*.txt`
(user-only) rather than to the job's `.out` file.

### Local development (no GPU)

```sh
VIEWERSTREAM_SECRET=devsecret python server/render_server.py --backend fake --host 127.0.0.1 --port 8765 --dev
npm run dev
```

Open `http://127.0.0.1:8765/?s=devsecret` for the standalone viewer, or the
fake StreamBIM host (`/host/index.html`) with an empty plyUrl and paste
`http://127.0.0.1:8765/?s=devsecret` into the widget's Remote panel.

## Setup

```sh
npm install
python3 tests/make_test_ply.py public/test-scenes/test-scene.ply   # small test splat (npm run test:scene)
```

`public/test-scenes/` is gitignored and never part of the deployed widget; the
fake StreamBIM host serves `test-scene.ply` as the project's "document".

## Development

```sh
npm run dev
```

- `http://localhost:5173/host/index.html` - the fake StreamBIM host. Empty
  plyUrl = document mode (as inside StreamBIM); drive the camera manually or
  with "Animate orbit"; the widget's Remote panel connects to a renderer.
- `http://localhost:5173/?plyUrl=/test-scenes/test-scene.ply` - the widget
  standalone, default camera.

Debug output (`[streambim] cameraChanged …` logs, fps/latency readout) is on
in the dev server and the dev channel; in production add `?debug=1` to the
widget URL.

### End-to-end test

`npm run test:e2e` (`tests/e2e/relay.mjs`, Playwright) loads the widget in the
fake host and checks document mode (project id, document list, relative
token link, download, render) and remote mode (relay popup, camera sync,
popup close, bad secret, malformed link). It needs the test scene, the dev
server and a fake renderer:

```sh
VIEWERSTREAM_SECRET=devsecret123 python server/render_server.py --backend fake --host 127.0.0.1 --port 8765 --dev &
npx vite --port 5173 --strictPort --host localhost &
npm run test:e2e        # CHROMIUM_PATH=/path/to/chrome to use a local browser
```

## Channels and deployment

`.github/workflows/deploy.yml` runs the end-to-end test on every push and PR.
Only pushes to `main` deploy, and only after the test passes. GitHub Pages
then serves two builds of the same commit:

| URL | Build | Use |
|---|---|---|
| `https://arifyakupogullari.github.io/viewerStream/` | `npm run build` (widget only, quiet) | **production** - what StreamBIM projects point at |
| `https://arifyakupogullari.github.io/viewerStream/dev/` | `npm run build:dev` (debug on) | testing; fake host at `dev/host/` |

Asset paths are relative (`base: './'`), so both work under their subpaths.
Work on a branch, merge to `main` to release.

## StreamBIM sandbox setup

Widget URL to register in the project:

```
https://arifyakupogullari.github.io/viewerStream/
```

No parameters are needed: the widget asks StreamBIM for the project and
loads the project's `.ply` document(s). Optional: `?projectId=` (if
`getProjectId()` isn't available), `?documentId=` (preselect a document),
`?streambimOrigin=https://<host>` (if the browser hides the parent origin),
`?debug=1` (console logging + stats).

What the widget needs from the StreamBIM side:
- the `.ply` uploaded as a project document, readable by the users who should
  see it;
- the download URL from `downloadlink` must be fetchable from the widget's
  origin (`https://arifyakupogullari.github.io`), i.e. CORS allowed; a
  blocked download shows "download blocked or unreachable";
- for the remote (Vera) renderer only: the widget iframe must be allowed to
  open popups (`allow-popups`, `allow-popups-to-escape-sandbox` if it is
  sandboxed) - the Connect button opens the Vera portal in a small window.

## Open risks / follow-ups

- **`CameraState` shape is unverified against a real StreamBIM instance.**
  `applyCameraState()` (in `src/streambim.js`) handles either a
  quaternion-based (`{ position, quaternion: [x,y,z,w] }`) or a
  target/up-based (`{ position, target, up }`) shape, plus an optional `fov`
  (and `near`/`far`). With `?debug=1` every `cameraChanged` payload is
  logged (`[streambim] cameraChanged …`), and unrecognized shapes always
  produce a `console.warn` - capture a real payload and refine the adapter if
  needed.
- **Download path base and CORS are unverified against real StreamBIM.** The
  relative `downloadlink` path is tried at the StreamBIM origin, then under
  `/project-<id>/`; with `?debug=1` the console shows which URL was tried.
- **FOV units/orientation**: Three.js `PerspectiveCamera.fov` is *vertical*
  FOV in degrees. The adapter treats `fov <= Math.PI` as radians and converts,
  but a horizontal-vs-vertical FOV mismatch (or aspect-ratio differences
  between StreamBIM's viewport and this widget's iframe) can't be ruled out
  without testing against a real instance.
- **Remote rendering through the Vera portal is untested on the real
  portal so far.** To verify there: that `node/<host>/<port>/` reaches the
  node and upgrades WebSockets; that the popup keeps `window.opener` (a
  `Cross-Origin-Opener-Policy` header from the portal would sever it); and
  whether the `?s=` secret survives a fresh login redirect (if not, open the
  link again once logged in). Remote frames should line up with the local
  WebGL view at the same camera - compare both in the fake host to confirm
  the axis/FOV conversion on a real scene.
- **`sharedMemoryForWorkers: false`**: disabled to avoid requiring
  `SharedArrayBuffer` + COOP/COEP headers, which are unlikely to be available
  when this widget is embedded as a cross-origin iframe inside StreamBIM. This
  costs some sorting performance; revisit if the hosting environment can
  guarantee those headers (and StreamBIM's iframe embedding tolerates COEP).
