import { initSplatViewer, loadSplatScene } from './splatViewer.js';
import { connectStreamBIM, applyCameraState } from './streambim.js';

const overlay = document.getElementById('overlay');
const overlayMessage = document.getElementById('overlay-message');

function setOverlay(message, { error = false } = {}) {
  overlayMessage.textContent = message;
  overlay.classList.toggle('error', error);
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

const params = new URLSearchParams(window.location.search);
const plyUrl = params.get('plyUrl');

if (!plyUrl) {
  setOverlay('Missing required "plyUrl" query parameter. Append ?plyUrl=<url-to-ply> to this page\'s URL.', { error: true });
} else {
  const container = document.getElementById('splat-container');
  const { viewer, camera } = initSplatViewer(container);

  let streambimReady = false;
  let splatReady = false;

  const maybeHideOverlay = () => {
    if (streambimReady && splatReady) {
      hideOverlay();
    }
  };

  setOverlay('Connecting to StreamBIM…');

  connectStreamBIM({
    onCameraState: (state) => applyCameraState(camera, state),
  })
    .then(() => {
      streambimReady = true;
      maybeHideOverlay();
    })
    .catch((err) => {
      console.warn('[streambim] connection failed, using default camera', err);
      streambimReady = true;
      if (!splatReady) {
        setOverlay('Could not connect to StreamBIM (see console). Loading splat scene…');
      }
      maybeHideOverlay();
    });

  loadSplatScene(viewer, plyUrl)
    .then(() => {
      viewer.start();
      splatReady = true;
      maybeHideOverlay();
    })
    .catch((err) => {
      console.error('[splatViewer] failed to load splat scene', err);
      setOverlay('Failed to load splat scene: ' + (err && err.message ? err.message : err), { error: true });
    });
}
