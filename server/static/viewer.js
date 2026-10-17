// Standalone remote viewer: first-person navigation (mouse, touch, keys) in
// the browser, rendering on the server. Opened from the session link the
// Vera launcher prints, e.g. https://vera.c3se.chalmers.se/node/<host>/<port>/?s=<secret>
import { createFrameLoop, createStats, requestSize } from './protocol.js';

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const hudEl = document.getElementById('hud');
const sceneEl = document.getElementById('scene');
const inspectEl = document.getElementById('inspect');
const legendEl = document.getElementById('legend');

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
let modes = ['splat'];
let mode = 'splat';
let statusBase = '';
let scenes = [];
let scene = 0;
let backendName = '';

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
let press = null; // a click (no drag) inspects the BIM element under the cursor
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
  press = pointers.size === 1 && e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  pinchDist = null;
});
canvas.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  pinchDist = null;
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5 && performance.now() - press.t < 500) pick(e);
  press = null;
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
  if ((e.key === 'n' || e.key === 'N') && scenes.length > 1) selectScene((scene + 1) % scenes.length);
  if ((e.key === 'm' || e.key === 'M') && modes.length > 1) {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    setStatus(`${statusBase} · ${mode}`);
    updateLegend();
  }
  if (e.key === 'Escape') inspectEl.classList.add('hidden');
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
  return { view: lookAtView(eye, add(eye, fwd), up), fovY, mode, scene, ...requestSize(w, h, maxSide) };
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

// --- inspection: click an element, see its verification and evidence ----------
function pick(e) {
  const view = getView();
  if (!view || !ws || ws.readyState !== WebSocket.OPEN) return;
  const r = canvas.getBoundingClientRect();
  ws.send(JSON.stringify({ type: 'pick', ...view, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }));
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const LABEL = { built: 'built', 'not built': 'not built', 'cannot tell': "can't tell", 'no view': 'no usable view' };

function showInspect(m) {
  if (!m.found) {
    inspectEl.innerHTML = `<button class="close" title="Close (Esc)">×</button><p>${esc(m.message || 'No BIM element here.')}</p>`;
  } else {
    const views = (m.per_view && typeof m.per_view === 'object') ? Object.entries(m.per_view) : [];
    inspectEl.innerHTML = `<button class="close" title="Close (Esc)">×</button>
      <div class="badge s-${esc((m.status || 'no view').replace(' ', '-'))}">${esc(LABEL[m.status] || m.status)}
        ${m.confidence != null ? `<span>conf ${esc(m.confidence)}</span>` : ''}</div>
      <h3>${esc(m.type || m.key)}</h3>
      <div class="meta">${esc(m.file || m.key)} · ${esc(m.class || '')} · MMI in model ${esc(m.mmi_model ?? '–')}
        ${m.mmi_proposed ? ` → proposed ${esc(m.mmi_proposed)}` : ''}<br><code>${esc(m.guid)}</code></div>
      ${m.law ? `<p class="law">rule: ${esc(m.law)}</p>` : ''}
      ${m.what_is_there ? `<p><b>What is there:</b> ${esc(m.what_is_there)}</p>` : ''}
      ${m.evidence_text ? `<p>${esc(m.evidence_text)}</p>` : ''}
      ${views.map(([k, v]) => `<p class="pv"><b>${esc(k)}</b> ${esc(v)}</p>`).join('')}
      <div class="ev">${(m.evidence || []).map((u) => `<a href="${esc(u)}" target="_blank"><img src="${esc(u)}" loading="lazy"></a>`).join('')}</div>`;
  }
  inspectEl.classList.remove('hidden');
  inspectEl.querySelector('.close').onclick = () => inspectEl.classList.add('hidden');
}

function updateLegend() {
  legendEl.classList.toggle('hidden', mode !== 'status');
}

/** Switch scene: its own start camera and step size; the frame loop picks it up. */
function selectScene(i) {
  scene = i;
  sceneEl.value = String(i);
  const sc = scenes[i];
  home = sc.defaultCamera;
  const [lo, hi] = sc.bounds;
  // walking-scale steps: 1% of the scene, but never more than 0.5 units
  // (whole-floor sites are tens of metres across; indoors that overshot walls)
  step = Math.min(0.5, Math.max(0.02, Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.01));
  resetCamera();
  const count = sc.numGaussians ? `${(sc.numGaussians / 1e6).toFixed(1)}M gaussians` : 'test pattern';
  statusBase = [backendName, sc.name, count].filter(Boolean).join(' · ');
  setStatus(modes.length > 1 ? `${statusBase} · ${mode} (M: switch view)` : statusBase);
  loop.refresh();
}
sceneEl.addEventListener('change', () => {
  selectScene(Number(sceneEl.value));
  sceneEl.blur(); // keep WASD / M / N going to the viewer
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
      maxSide = msg.maxSide || maxSide;
      modes = msg.modes || ['splat'];
      mode = modes[0]; // 'status' comes first when verification results are loaded
      updateLegend();
      backendName = msg.backend;
      scenes = msg.scenes
        || [{ name: '', numGaussians: msg.numGaussians, bounds: msg.bounds, defaultCamera: msg.defaultCamera }];
      sceneEl.innerHTML = '';
      scenes.forEach((sc, i) => sceneEl.add(new Option(sc.name || `Scene ${i + 1}`, String(i))));
      sceneEl.classList.toggle('hidden', scenes.length < 2);
      selectScene(0);
      loop.start();
    } else if (msg.type === 'pick') {
      showInspect(msg);
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
