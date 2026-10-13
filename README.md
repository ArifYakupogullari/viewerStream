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
  1. Reads `?plyUrl=<url>` from the page's query string and loads that splat
     scene with `@mkkellogg/gaussian-splats-3d`.
  2. Connects to StreamBIM via `StreamBIM.connectToParent` (`src/streambim.js`).
     If no parent responds within 5s (e.g. the widget is opened standalone),
     the connection attempt is abandoned for UI purposes and the splat scene
     is shown with its default camera.
  3. Subscribes to StreamBIM's `cameraChanged` event (and reads
     `getCameraState()` once on connect) and applies the resulting
     position/orientation/FOV to the splat viewer's camera via
     `applyCameraState()`.
- Camera sync is **one-way**: StreamBIM drives the splat camera. The widget
  never calls `setCameraState`/`setCameraPosition`.
- `host/index.html` / `src/host/host.js` - a local "fake StreamBIM" dev
  harness. It loads the widget in an iframe via `StreamBIM.connectToChild`,
  stubs the StreamBIM API methods the widget might call, and provides manual
  controls (position/target/up/FOV, a quaternion-mode toggle, and an orbit
  animation) to fire fake `cameraChanged` events at the widget.

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
  from its opener on an allowed widget origin (`--widget-origin`, default:
  GitHub Pages + local dev). Keep the popup open while streaming.
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
```

For local testing you need a `.ply` Gaussian Splat scene reachable by the dev
server. By default `host/index.html` points at
`/test-scenes/point_cloud.ply`, which is expected to be a symlink/file under
`public/test-scenes/` (gitignored - this directory is for local dev only and
is not part of the deployable widget).

```sh
mkdir -p public/test-scenes
ln -s /path/to/your/point_cloud.ply public/test-scenes/point_cloud.ply
```

## Development

```sh
npm run dev
```

- Open `http://localhost:5173/host/index.html` to use the fake StreamBIM host.
  It loads the widget (`/?plyUrl=...`) in an iframe and lets you drive the
  camera manually or via the "Animate orbit" toggle.
- Open `http://localhost:5173/?plyUrl=/test-scenes/point_cloud.ply` directly
  to view the widget standalone (it will log a connection warning since there
  is no StreamBIM parent, but the splat scene still renders with a default
  camera).

## Production build

```sh
npm run build
npm run preview   # smoke-test the static dist/ output
```

`dist/index.html` (plus its hashed assets) is the deployable widget. Host it
anywhere and point a StreamBIM widget iframe at it with a `?plyUrl=` query
parameter pointing to a hosted `.ply` file, e.g.:

```
https://your-host/widget/?plyUrl=https://your-cdn/scenes/scene.ply
```

`dist/host/index.html` is the dev harness; it can be left out of any
production deployment.

## Open risks / follow-ups

- **`CameraState` shape is unverified against a real StreamBIM instance.**
  `applyCameraState()` (in `src/streambim.js`) handles either a
  quaternion-based (`{ position, quaternion: [x,y,z,w] }`) or a
  target/up-based (`{ position, target, up }`) shape, plus an optional `fov`
  (and `near`/`far`). Every `cameraChanged` payload is logged via
  `console.debug('[streambim] cameraChanged', ...)`, and unrecognized shapes
  produce a `console.warn` - capture a real payload and refine the adapter if
  needed.
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
