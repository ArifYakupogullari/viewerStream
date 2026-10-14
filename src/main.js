import { initSplatViewer, loadSplatScene, fetchScene, PLY_FORMAT } from './splatViewer.js';
import { initRemoteViewer, parseSessionLink } from './remoteViewer.js';
import { DEBUG, debugLog } from './debug.js';
import {
  connectStreamBIM,
  applyCameraState,
  fetchPlyDocuments,
  fetchDocumentDownloadUrl,
  getStreamBIMProjectId,
  downloadUrlCandidates,
} from './streambim.js';

const overlay = document.getElementById('overlay');
const overlayMessage = document.getElementById('overlay-message');
const modelPicker = document.getElementById('model-picker');
const modelSelect = document.getElementById('model-select');
const remoteToggle = document.getElementById('remote-toggle');
const remoteForm = document.getElementById('remote-form');
const remoteLink = document.getElementById('remote-link');
const remoteConnect = document.getElementById('remote-connect');
const remoteDisconnect = document.getElementById('remote-disconnect');
const remoteStatus = document.getElementById('remote-status');
const remoteStats = document.getElementById('remote-stats');

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
const projectIdParam = params.get('projectId');
const initialDocumentId = params.get('documentId');

const container = document.getElementById('splat-container');

// The view currently on screen - the local WebGL splat viewer or the remote
// stream. StreamBIM camera updates always go to its camera.
let active = null;
let lastCameraState = null;
// Re-creates the local viewer for the current selection; null when there is
// nothing to show locally (remote-only use).
let showLocal = null;

function teardown() {
  if (active) {
    try { active.viewer.stop(); } catch (_) {}
    try { active.viewer.dispose(); } catch (_) {}
    active = null;
  }
  container.innerHTML = '';
}

function activate(view) {
  active = view;
  // Re-apply the latest known camera state so the view snaps to the right
  // position immediately after a swap.
  if (lastCameraState) applyCameraState(view.camera, lastCameraState);
}

const streambim = connectStreamBIM({
  onCameraState: (state) => {
    lastCameraState = state;
    if (active) applyCameraState(active.camera, state);
  },
});

// Document mode: the project's .ply files stored in StreamBIM (access stays
// under StreamBIM's own permissions), with an in-widget picker.
function startDocumentMode(projectId) {
  // StreamBIM returns a time-limited, usually relative download link: resolve
  // it against StreamBIM's origin, download it once with progress, and load
  // the scene from memory. If the site-root form fails, retry once with a
  // fresh link under /project-<id>/.
  async function downloadDocument(documentId) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const link = await fetchDocumentDownloadUrl(projectId, documentId);
      const candidates = downloadUrlCandidates(link, projectId);
      if (attempt >= candidates.length) break;
      debugLog('[main] downloadlink', link, '-> trying', candidates[attempt]);
      try {
        return await fetchScene(candidates[attempt], (got, total) => {
          setOverlay(total
            ? `Downloading scene… ${Math.round((100 * got) / total)}%`
            : `Downloading scene… ${(got / 1e6).toFixed(0)} MB`);
        });
      } catch (err) {
        lastErr = err;
        debugLog('[main] download attempt failed', candidates[attempt], err);
      }
    }
    throw lastErr;
  }

  function loadModel(documentId) {
    teardown();
    const { viewer, camera } = initSplatViewer(container);
    activate({ viewer, camera, kind: 'local' });
    setOverlay('Fetching scene file…');

    downloadDocument(documentId)
      .then((blobUrl) => {
        setOverlay('Loading scene…');
        // addSplatScene returns the library's own AbortablePromise (no .finally)
        return Promise.resolve(loadSplatScene(viewer, blobUrl, PLY_FORMAT)).finally(() => URL.revokeObjectURL(blobUrl));
      })
      .then(() => {
        if (!active || active.viewer !== viewer) return; // swapped out meanwhile
        viewer.start();
        hideOverlay();
      })
      .catch((err) => {
        console.error('[main] loadModel error', err);
        setOverlay('Error: ' + (err && err.message ? err.message : String(err)), { error: true });
      });
  }

  setOverlay('Loading document list…');
  return fetchPlyDocuments(projectId)
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

      modelSelect.addEventListener('change', () => loadModel(modelSelect.value));

      // Auto-load: prefer ?documentId= param, otherwise first in list.
      modelSelect.value = initialDocumentId || docs[0].id;
      showLocal = () => {
        modelPicker.classList.remove('hidden');
        loadModel(modelSelect.value);
      };
      if (!active || active.kind !== 'remote') showLocal();
    })
    .catch((err) => {
      console.error('[main] setup error', err);
      if (!active || active.kind !== 'remote') {
        setOverlay('Error: ' + (err && err.message ? err.message : String(err)), { error: true });
      }
    });
}

// Nothing to show locally: offer the remote renderer panel.
function showRemoteOnly(message) {
  remoteForm.classList.remove('hidden');
  if (!active || active.kind !== 'remote') {
    setOverlay(message || 'Paste a remote renderer session link (top right), or use ?projectId=P / ?plyUrl=<url>.');
  }
}

if (plyUrl) {
  // Direct URL mode: for development and testing outside StreamBIM.
  // StreamBIM camera sync is attempted but failures are non-fatal.
  let streambimSettled = false;
  let localReady = false;

  const maybeHideOverlay = () => {
    if (streambimSettled && localReady && active && active.kind === 'local') hideOverlay();
  };

  streambim
    .catch((err) => {
      console.warn('[streambim] connection failed, using default camera', err);
      if (!localReady && active && active.kind === 'local') {
        setOverlay('Could not connect to StreamBIM (see console). Loading splat scene…');
      }
    })
    .then(() => {
      streambimSettled = true;
      maybeHideOverlay();
    });

  showLocal = () => {
    teardown();
    localReady = false;
    const { viewer, camera } = initSplatViewer(container);
    activate({ viewer, camera, kind: 'local' });
    setOverlay(streambimSettled ? 'Loading splat scene…' : 'Connecting to StreamBIM…');

    loadSplatScene(viewer, plyUrl)
      .then(() => {
        if (!active || active.viewer !== viewer) return;
        viewer.start();
        localReady = true;
        maybeHideOverlay();
      })
      .catch((err) => {
        console.error('[splatViewer] failed to load splat scene', err);
        setOverlay('Failed to load splat scene: ' + (err && err.message ? err.message : err), { error: true });
      });
  };
  showLocal();

} else {
  // Inside StreamBIM: the project comes from ?projectId= or from StreamBIM
  // itself; its .ply documents are listed and loaded. Outside StreamBIM (no
  // parent answers) the widget falls back to the remote renderer panel.
  setOverlay('Connecting to StreamBIM…');
  streambim.then(
    () => Promise.resolve(projectIdParam || getStreamBIMProjectId()).then((projectId) => {
      if (projectId) return startDocumentMode(projectId);
      showRemoteOnly('Connected to StreamBIM but no project id - add ?projectId=… or use a remote renderer (top right).');
      return undefined;
    }),
    (err) => {
      console.warn('[streambim] connection failed', err);
      showRemoteOnly();
    },
  );
}

// ---------------------------------------------------------------------------
// Remote renderer (Vera). The session link comes from the launcher notebook;
// connecting opens a relay popup on the Vera portal (where the Chalmers login
// happens) that carries camera -> frames for this iframe.
// ---------------------------------------------------------------------------
const REMOTE_LINK_KEY = 'viewerstream.remoteLink';
let relayWindow = null;

function setRemoteStatus(text, error = false) {
  remoteStatus.textContent = text;
  remoteStatus.classList.toggle('error', error);
}

function setRemoteUi(connected) {
  remoteConnect.classList.toggle('hidden', connected);
  remoteDisconnect.classList.toggle('hidden', !connected);
  remoteLink.disabled = connected;
  remoteStats.classList.toggle('hidden', !(connected && DEBUG));
  remoteStats.textContent = '';
}

try {
  remoteLink.value = localStorage.getItem(REMOTE_LINK_KEY) || '';
} catch (_) {
  // storage unavailable (e.g. blocked third-party storage) - just don't prefill
}

remoteToggle.addEventListener('click', () => remoteForm.classList.toggle('hidden'));

remoteConnect.addEventListener('click', () => {
  let session;
  try {
    session = parseSessionLink(remoteLink.value);
  } catch (err) {
    setRemoteStatus(err.message, true);
    return;
  }
  try {
    localStorage.setItem(REMOTE_LINK_KEY, remoteLink.value.trim());
  } catch (_) {}

  // Must happen synchronously in the click handler or popup blockers step in.
  relayWindow = window.open(session.relayUrl, 'viewerstream-relay', 'popup,width=420,height=360');
  if (!relayWindow) {
    setRemoteStatus('Popup blocked - allow popups for this widget and try again.', true);
    return;
  }
  startRemote(session.relayOrigin);
});

remoteDisconnect.addEventListener('click', () => stopRemote(null));

function startRemote(relayOrigin) {
  teardown();
  modelPicker.classList.add('hidden');
  setRemoteUi(true);
  setRemoteStatus('Waiting for the renderer window…');
  setOverlay('Waiting for the renderer window - log in to Vera there if asked.');

  const remote = initRemoteViewer(container, {
    relay: relayWindow,
    relayOrigin,
    onReady: (info) => {
      // Outside StreamBIM nothing drives the camera: start at the scene's
      // own default view instead of the generic one.
      if (!lastCameraState && info.defaultCamera) {
        const { position, target, up, fovY } = info.defaultCamera;
        applyCameraState(remote.camera, { position, target, up, fov: fovY });
      }
      const what = info.numGaussians ? `${(info.numGaussians / 1e6).toFixed(1)}M gaussians` : 'test pattern';
      setRemoteStatus(`Connected - ${info.backend}, ${what}`);
      hideOverlay();
    },
    onStats: (text) => {
      remoteStats.textContent = text;
    },
    onClosed: (reason) => stopRemote(reason),
  });
  activate({ ...remote, kind: 'remote' });
  remote.viewer.start();
}

function stopRemote(reason) {
  if (relayWindow && !relayWindow.closed) relayWindow.close();
  relayWindow = null;
  setRemoteUi(false);
  setRemoteStatus(reason || 'Disconnected', Boolean(reason));
  if (active && active.kind === 'remote') teardown();
  if (showLocal) showLocal();
  else setOverlay((reason ? reason + '. ' : '') + 'Paste a session link to reconnect.', { error: Boolean(reason) });
}
