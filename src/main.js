import { initSplatViewer, loadSplatScene } from './splatViewer.js';
import {
  connectStreamBIM,
  applyCameraState,
  fetchPlyDocuments,
  fetchDocumentDownloadUrl,
} from './streambim.js';

const overlay = document.getElementById('overlay');
const overlayMessage = document.getElementById('overlay-message');
const modelPicker = document.getElementById('model-picker');
const modelSelect = document.getElementById('model-select');

function setOverlay(message, { error = false } = {}) {
  overlayMessage.textContent = message;
  overlay.classList.toggle('error', error);
  overlay.classList.remove('hidden');
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

const params = new URLSearchParams(window.location.search);
const plyUrl = params.get('plyUrl');
const projectId = params.get('projectId');
const initialDocumentId = params.get('documentId');

const container = document.getElementById('splat-container');

if (projectId) {
  // Document mode: StreamBIM-hosted .ply files, with an in-widget picker.
  let currentCamera = null;
  let currentViewer = null;
  let lastCameraState = null;

  function loadModel(documentId) {
    // Tear down any existing viewer before creating a new one.
    if (currentViewer) {
      try { currentViewer.stop(); } catch (_) {}
      try { currentViewer.dispose(); } catch (_) {}
      container.innerHTML = '';
    }

    const { viewer, camera } = initSplatViewer(container);
    currentViewer = viewer;
    currentCamera = camera;

    // Re-apply the latest known camera state so the view snaps to the right
    // position immediately after the scene swap.
    if (lastCameraState) applyCameraState(camera, lastCameraState);

    setOverlay('Fetching scene file…');

    fetchDocumentDownloadUrl(projectId, documentId)
      .then((url) => {
        setOverlay('Loading scene…');
        return loadSplatScene(viewer, url);
      })
      .then(() => {
        viewer.start();
        hideOverlay();
      })
      .catch((err) => {
        console.error('[main] loadModel error', err);
        setOverlay('Error: ' + (err && err.message ? err.message : String(err)), { error: true });
      });
  }

  setOverlay('Connecting to StreamBIM…');

  connectStreamBIM({
    onCameraState: (state) => {
      lastCameraState = state;
      if (currentCamera) applyCameraState(currentCamera, state);
    },
  })
    .then(() => {
      setOverlay('Loading document list…');
      return fetchPlyDocuments(projectId);
    })
    .then((docs) => {
      if (docs.length === 0) {
        setOverlay('No .ply documents found in this project.', { error: true });
        return;
      }

      // Populate the picker dropdown.
      modelSelect.innerHTML = '';
      docs.forEach((doc) => {
        const opt = document.createElement('option');
        opt.value = doc.id;
        opt.textContent = doc.filename || doc.name || doc.title || `Document ${doc.id}`;
        modelSelect.appendChild(opt);
      });
      modelPicker.classList.remove('hidden');

      modelSelect.addEventListener('change', () => loadModel(modelSelect.value));

      // Auto-load: prefer ?documentId= param, otherwise first in list.
      const autoId = initialDocumentId || docs[0].id;
      modelSelect.value = autoId;
      loadModel(autoId);
    })
    .catch((err) => {
      console.error('[main] setup error', err);
      setOverlay('Error: ' + (err && err.message ? err.message : String(err)), { error: true });
    });

} else if (plyUrl) {
  // Direct URL mode: for development and testing outside StreamBIM.
  // StreamBIM camera sync is attempted but failures are non-fatal.
  const { viewer, camera } = initSplatViewer(container);

  let streambimReady = false;
  let splatReady = false;

  const maybeHideOverlay = () => {
    if (streambimReady && splatReady) hideOverlay();
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
      if (!splatReady) setOverlay('Could not connect to StreamBIM (see console). Loading splat scene…');
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
    'Missing required parameters. Use ?projectId=P (StreamBIM project) or ?plyUrl=<url> (direct URL).',
    { error: true }
  );
}
