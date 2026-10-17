import * as THREE from 'three';
import { createFrameLoop, createStats, requestSize } from '../server/static/protocol.js';
import { streambimFov } from './streambim.js';

const HELLO_INTERVAL_MS = 500;

/**
 * Parses a session link printed by the Vera launcher, e.g.
 *   https://vera.c3se.chalmers.se/node/<host>/<port>/?s=<secret>
 * into the relay popup URL and the origin frames will come from.
 * Throws with a readable message on anything else.
 */
export function parseSessionLink(link) {
  let url;
  try {
    url = new URL(link.trim());
  } catch (_) {
    throw new Error('Not a valid URL');
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Session link must be https');
  }
  const secret = url.searchParams.get('s') || new URLSearchParams(url.hash.slice(1)).get('s');
  if (!secret) throw new Error('Session link has no ?s= secret');
  const base = url.origin + (url.pathname.endsWith('/') ? url.pathname : url.pathname + '/');
  const relay = new URL('relay', base);
  relay.searchParams.set('s', secret);
  return { relayUrl: relay.href, relayOrigin: url.origin };
}

/**
 * Remote counterpart of initSplatViewer(): same {viewer, camera} shape, so the
 * StreamBIM camera sync (applyCameraState) drives it unchanged. Rendering
 * happens on the server; frames arrive through the relay popup `relay`
 * (opened by the caller from a click so popup blockers allow it).
 *
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {Window} opts.relay - the popup window returned by window.open
 * @param {string} opts.relayOrigin
 * @param {(info: Object) => void} [opts.onReady] - renderer connected
 * @param {(text: string) => void} [opts.onStats]
 * @param {(reason: string) => void} [opts.onClosed] - relay/renderer gone
 */
export function initRemoteViewer(container, { relay, relayOrigin, onReady, onStats, onClosed }) {
  const camera = new THREE.PerspectiveCamera(65, container.clientWidth / container.clientHeight || 1, 0.1, 500);
  camera.position.set(0, 1.6, 5);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.className = 'remote-canvas';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let ready = false;
  let maxSide = 1920;
  let disposed = false;
  const stats = createStats();

  function getView() {
    if (!ready) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.round(container.clientWidth * dpr);
    const h = Math.round(container.clientHeight * dpr);
    if (!w || !h) return null;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    camera.aspect = w / h;
    if (camera.userData.streambimFov) camera.fov = streambimFov(camera.aspect);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true); // also refreshes matrixWorldInverse
    return { view: camera.matrixWorldInverse.elements, fovY: camera.fov, ...requestSize(w, h, maxSide) };
  }

  const loop = createFrameLoop({
    getView,
    send: (msg) => relay.postMessage({ type: 'vs-camera', msg }, relayOrigin),
    onFrame: (blob, { latencyMs }) => {
      createImageBitmap(blob).then((bmp) => {
        if (!disposed) ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
        stats.add(latencyMs);
        if (onStats) onStats(stats.text());
      });
    },
  });

  function close(reason) {
    if (disposed) return;
    dispose();
    if (onClosed) onClosed(reason);
  }

  function onMessage(ev) {
    if (ev.origin !== relayOrigin || ev.source !== relay) return;
    const msg = ev.data || {};
    if (msg.type === 'vs-ready') {
      if (!ready) {
        ready = true;
        maxSide = msg.info.maxSide || maxSide;
        loop.refresh();
        if (onReady) onReady(msg.info);
      }
    } else if (msg.type === 'vs-frame') {
      loop.frame(msg.buf);
    } else if (msg.type === 'vs-error') {
      close('Renderer: ' + msg.message);
    } else if (msg.type === 'vs-closed') {
      close(`Renderer disconnected (${msg.code}${msg.reason ? ': ' + msg.reason : ''})`);
    }
  }
  window.addEventListener('message', onMessage);

  // Keep greeting the popup until it answers: it may still be on the Vera
  // login page (a different origin, so these messages are simply dropped).
  const timer = setInterval(() => {
    if (relay.closed) close('Renderer window was closed');
    else if (!ready) relay.postMessage({ type: 'vs-hello' }, relayOrigin);
  }, HELLO_INTERVAL_MS);

  function dispose() {
    disposed = true;
    loop.stop();
    clearInterval(timer);
    window.removeEventListener('message', onMessage);
    canvas.remove();
  }

  const viewer = {
    start: () => loop.start(),
    stop: () => loop.stop(),
    dispose,
  };
  return { viewer, camera };
}
