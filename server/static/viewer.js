// Standalone remote viewer: first-person navigation (mouse, touch, keys) in
// the browser, rendering on the server. Opened from the session link the
// Vera launcher prints, e.g. https://vera.c3se.chalmers.se/node/<host>/<port>/?s=<secret>
import { createFrameLoop, createStats, requestSize } from './protocol.js';

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const hudEl = document.getElementById('hud');

const secret =
  new URLSearchParams(location.search).get('s') || new URLSearchParams(location.hash.slice(1)).get('s');

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

// --- small vector helpers -------------------------------------------------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/** Rodrigues rotation of v around unit axis k. */
function rotate(v, k, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

/** Three.js-convention view matrix (camera looks down -Z), column-major. */
function lookAtView(eye, target, up) {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
}

// --- camera state ----------------------------------------------------------
let home = null;
let eye = [0, 1.6, 6];
let fwd = [0, 0, -1];
let up = [0, 1, 0];
let fovY = 60;
let step = 0.1; // world units per "nudge", derived from scene size

function resetCamera() {
  if (!home) return;
  eye = home.position.slice();
  up = normalize(home.up);
  fwd = normalize(sub(home.target, home.position));
  fovY = home.fovY || 60;
}

/** "Grab the scene" look-around (like Street View): drag right turns the view left. */
function look(dx, dy) {
  fwd = normalize(rotate(fwd, up, dx * 0.004));
  const right = normalize(cross(fwd, up));
  const pitched = normalize(rotate(fwd, right, dy * 0.004));
  if (Math.abs(dot(pitched, up)) < 0.995) fwd = pitched;
}

function move(forward, strafe, lift) {
  const right = normalize(cross(fwd, up));
  eye = add(eye, add(add(mul(fwd, forward), mul(right, strafe)), mul(up, lift)));
}

// --- input -----------------------------------------------------------------
const pointers = new Map();
let pinchDist = null;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
  pinchDist = null;
});
canvas.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  pinchDist = null;
});
canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  pinchDist = null;
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  if (pointers.size === 1) {
    if (p.button === 2 || e.shiftKey) move(0, -dx * step * 0.01, dy * step * 0.01);
    else look(dx, dy);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist != null) move((dist - pinchDist) * step * 0.01, 0, 0);
    pinchDist = dist;
    // two-finger drag pans by half of each finger's motion
    move(0, -dx * step * 0.005, dy * step * 0.005);
  }
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    move(-e.deltaY * step * 0.002, 0, 0);
  },
  { passive: false },
);

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') resetCamera();
  keys.add(e.key.toLowerCase());
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

let lastT = performance.now();
function keyLoop(t) {
  const dt = Math.min(100, t - lastT) / 16.7;
  lastT = t;
  const k = (step * 0.04 * dt) * (keys.has('shift') ? 4 : 1);
  const f = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const s = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  const l = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
  if (f || s || l) move(f * k, s * k, l * k);
  requestAnimationFrame(keyLoop);
}
requestAnimationFrame(keyLoop);

// --- streaming -------------------------------------------------------------
let maxSide = 1920;
const stats = createStats();

function getView() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  if (!w || !h) return null;
  return { view: lookAtView(eye, add(eye, fwd), up), fovY, ...requestSize(w, h, maxSide) };
}

let ws = null;
const loop = createFrameLoop({
  getView,
  send: (msg) => ws && ws.readyState === WebSocket.OPEN && ws.send(msg),
  onFrame: (blob, { latencyMs }) => {
    createImageBitmap(blob).then((bmp) => {
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      stats.add(latencyMs);
      hudEl.textContent = stats.text();
    });
  },
});

function connect() {
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.hash = '';
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', secret }));
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      loop.frame(e.data);
      return;
    }
    const msg = JSON.parse(e.data);
    if (msg.type === 'info') {
      home = msg.defaultCamera;
      maxSide = msg.maxSide || maxSide;
      const [lo, hi] = msg.bounds;
      // walking-scale steps: 1% of the scene, but never more than 0.5 units
      // (whole-floor sites are tens of metres across; indoors that overshot walls)
      step = Math.min(0.5, Math.max(0.02, Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.01));
      resetCamera();
      const count = msg.numGaussians ? `${(msg.numGaussians / 1e6).toFixed(1)}M gaussians` : 'test pattern';
      setStatus(`${msg.backend} · ${count}`);
      loop.refresh();
      loop.start();
    } else if (msg.type === 'error') {
      setStatus(msg.message, true);
    }
  };
  ws.onclose = (e) => {
    loop.stop();
    if (e.code === 4401) setStatus('Rejected: bad or missing session secret. Reopen the link from the notebook.', true);
    else setStatus(`Disconnected (${e.code}). The renderer may have stopped; reload to retry.`, true);
  };
}

if (!secret) {
  setStatus(
    'This link has no session secret (?s=…). If you were just sent through the Vera login, open the link from the notebook again.',
    true,
  );
} else {
  connect();
}
