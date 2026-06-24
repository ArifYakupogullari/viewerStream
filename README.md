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
- **`sharedMemoryForWorkers: false`**: disabled to avoid requiring
  `SharedArrayBuffer` + COOP/COEP headers, which are unlikely to be available
  when this widget is embedded as a cross-origin iframe inside StreamBIM. This
  costs some sorting performance; revisit if the hosting environment can
  guarantee those headers (and StreamBIM's iframe embedding tolerates COEP).
