// Shared by the render server's own pages (served as a plain ES module) and
// the viewerStream widget (imported through Vite), so both speak exactly the
// same camera/frame format.
//
//   client -> server  JSON {type:'camera', seq, view, fovY, width, height}
//                     view = Three.js camera.matrixWorldInverse.elements
//                     (column-major, camera looking down -Z, +Y up)
//   server -> client  binary: uint32 little-endian seq, then JPEG bytes

export const MAX_SIDE = 1920;
const LOST_FRAME_MS = 3000;

export function cameraMessage(seq, { view, fovY, width, height, mode }) {
  return JSON.stringify({ type: 'camera', seq, view: Array.from(view), fovY, width, height, mode });
}

export function parseFrame(buffer) {
  const seq = new DataView(buffer).getUint32(0, true);
  return { seq, blob: new Blob([new Uint8Array(buffer, 4)], { type: 'image/jpeg' }) };
}

/** Request size for a canvas, capped at MAX_SIDE on the long side. */
export function requestSize(width, height, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return { width: Math.max(16, Math.round(width * scale)), height: Math.max(16, Math.round(height * scale)) };
}

function viewKey({ view, fovY, width, height, mode }) {
  let key = `${width}x${height}@${fovY.toFixed(3)}:${mode || ''}`;
  for (let i = 0; i < 16; i++) key += ',' + view[i].toFixed(5);
  return key;
}

/**
 * Drives the request/response cycle: at most one frame in flight, and only
 * when the camera actually changed. When a frame arrives the newest camera is
 * sent next, so a fast-moving camera skips intermediate poses instead of
 * queueing them.
 *
 * @param {Object} opts
 * @param {() => ({view, fovY, width, height}|null)} opts.getView
 * @param {(message: string) => void} opts.send
 * @param {(blob: Blob, stats: {seq: number, latencyMs: number|null}) => void} opts.onFrame
 */
export function createFrameLoop({ getView, send, onFrame }) {
  let inFlight = null;
  let lastKey = null;
  let seq = 0;
  let raf = 0;
  let running = false;

  function tick() {
    if (!running) return;
    const now = performance.now();
    if (inFlight && now - inFlight.sentAt > LOST_FRAME_MS) inFlight = null;
    if (!inFlight) {
      const v = getView();
      if (v) {
        const key = viewKey(v);
        if (key !== lastKey) {
          lastKey = key;
          seq = (seq + 1) >>> 0;
          inFlight = { seq, sentAt: now };
          send(cameraMessage(seq, v));
        }
      }
    }
    raf = requestAnimationFrame(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    /** Feed a binary frame received from the server or relay. */
    frame(buffer) {
      const f = parseFrame(buffer);
      let latencyMs = null;
      if (inFlight && f.seq === inFlight.seq) {
        latencyMs = performance.now() - inFlight.sentAt;
        inFlight = null;
      }
      onFrame(f.blob, { seq: f.seq, latencyMs });
    },
    /** Forget the last sent camera, e.g. after (re)connecting. */
    refresh() {
      lastKey = null;
      inFlight = null;
    },
  };
}

/** Rolling frames-per-second + latency readout. */
export function createStats() {
  const times = [];
  let latency = null;
  return {
    add(latencyMs) {
      const now = performance.now();
      times.push(now);
      while (times.length && now - times[0] > 2000) times.shift();
      if (latencyMs != null) latency = latency == null ? latencyMs : 0.8 * latency + 0.2 * latencyMs;
    },
    text() {
      const fps = times.length / 2;
      return `${fps.toFixed(0)} fps` + (latency != null ? ` · ${latency.toFixed(0)} ms` : '');
    },
  };
}
