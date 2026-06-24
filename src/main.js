import { initSplatViewer, loadSplatScene } from './splatViewer.js';
import { connectStreamBIM, applyCameraState, fetchDocumentDownloadUrl } from './streambim.js';

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
const projectId = params.get('projectId');
const documentId = params.get('documentId');

const container = document.getElementById('splat-container');

if (projectId && documentId) {
  // Document mode: fetch the .ply URL from StreamBIM via its authenticated API,
  // then load it. StreamBIM connection is required for both the API call and
  // camera sync, so errors here are fatal.
  const { viewer, camera } = initSplatViewer(container);

  setOverlay('Connecting to StreamBIM…');

  connectStreamBIM({
    onCameraState: (state) => applyCameraState(camera, state),
  })
    .then(() => {
      setOverlay('Fetching scene file…');
      return fetchDocumentDownloadUrl(projectId, documentId);
    })
    .then((url) => {
      setOverlay('Loading scene…');
      return loadSplatScene(viewer, url).then(() => {
        viewer.start();
        hideOverlay();
      });
    })
    .catch((err) => {
      console.error('[main] document mode error', err);
      setOverlay('Error: ' + (err && err.message ? err.message : String(err)), { error: true });
    });

} else if (plyUrl) {
  // Direct URL mode: useful for development and testing outside StreamBIM.
  // StreamBIM camera sync is attempted but failures are non-fatal.
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

} else {
  setOverlay(
    'Missing required parameters. Use ?projectId=P&documentId=D (StreamBIM document) or ?plyUrl=<url> (direct URL).',
    { error: true }
  );
}
