import 'streambim-widget-api';
import * as THREE from 'three';
import { debugLog } from './debug.js';

// The streambim-widget-api UMD bundle has no ES module exports - it detects
// the absence of a CJS `module.exports`/AMD environment and instead assigns
// itself to `window.StreamBIM`. Import it for its side effect and read the
// global it sets.
const StreamBIM = window.StreamBIM;

const _target = new THREE.Vector3();

// If this page is opened standalone (no StreamBIM parent), Penpal's
// handshake never completes and connectToParent() never settles. Race it
// against a timeout so the splat scene's loading overlay isn't stuck on
// "Connecting..." forever - the underlying connection attempt keeps running
// in case a real parent responds late.
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Connects this widget to the StreamBIM parent window, subscribes to camera
 * updates, and applies them to `camera`.
 *
 * @param {Object} opts
 * @param {(state: any) => void} opts.onCameraState - called whenever a new
 *   camera state is received (both the initial getCameraState() and every
 *   subsequent cameraChanged event).
 * @returns {Promise<void>} resolves once connected to StreamBIM.
 */
export function connectStreamBIM({ onCameraState, onEvent = () => {} }) {
  const connected = StreamBIM.connectToParent(window.parent, {
    cameraChanged: (cameraState) => {
      debugLog('[streambim] cameraChanged', cameraState);
      onCameraState(cameraState);
    },
    pickedObject: (result) => onEvent('pickedObject', result),
    spacesChanged: (guids) => onEvent('spacesChanged', guids),
    floorChanged: (floorId) => onEvent('floorChanged', floorId),
    didExpand: () => onEvent('didExpand'),
    didContract: () => onEvent('didContract'),
    beforeInit: () => onEvent('beforeInit'),
  }).then(() => {
    return StreamBIM.API.getCameraState()
      .then((initialState) => {
        debugLog('[streambim] initial cameraState', initialState);
        onCameraState(initialState);
      })
      .catch((err) => {
        console.warn('[streambim] getCameraState failed', err);
      });
  });

  const timeout = new Promise((_resolve, reject) => {
    setTimeout(
      () => reject(new Error('Timed out waiting for StreamBIM parent to connect')),
      CONNECT_TIMEOUT_MS
    );
  });

  return Promise.race([connected, timeout]);
}

/**
 * Fetches a time-limited download URL for a StreamBIM document using the
 * widget's authenticated API access.
 *
 * Endpoint: GET /project-{projectId}/api/v1/documents/{documentId}/downloadlink
 *
 * @param {string|number} projectId
 * @param {string|number} documentId
 * @returns {Promise<string>} resolves with the download URL (may be a full URL
 *   or a path relative to the StreamBIM origin; the caller must use it
 *   immediately as the token is time-limited).
 */
/**
 * Fetches all documents in a project and returns only the .ply files.
 *
 * Endpoint: GET /project-{projectId}/api/v1/documents
 *
 * @param {string|number} projectId
 * @returns {Promise<Array<{id: number, name: string}>>}
 */
export function fetchPlyDocuments(projectId) {
  return StreamBIM.API.makeApiRequest({
    method: 'GET',
    path: `/project-${projectId}/api/v1/documents`,
  }).then((response) => {
    debugLog('[streambim] documents response', response);
    const docs = Array.isArray(response)
      ? response
      : (response && (response.documents || response.data || response.items)) || [];
    return docs.filter((doc) => {
      const name = doc.filename || doc.name || doc.title || '';
      return name.toLowerCase().endsWith('.ply');
    });
  });
}

/**
 * The project this widget is embedded in, asked from StreamBIM itself, so the
 * widget URL needs no ?projectId=. Resolves to null if StreamBIM can't say.
 */
export function getStreamBIMProjectId() {
  if (!StreamBIM.API || typeof StreamBIM.API.getProjectId !== 'function') return Promise.resolve(null);
  return Promise.resolve(StreamBIM.API.getProjectId()).catch((err) => {
    console.warn('[streambim] getProjectId failed', err);
    return null;
  });
}

/**
 * Origin of the StreamBIM page hosting this widget. StreamBIM's downloadlink
 * endpoint returns a path relative to it (e.g.
 * "/documents/1078/_download/scene.ply?microtoken=..."), which must not be
 * resolved against this widget's own origin (github.io). ?streambimOrigin=
 * in the widget URL overrides the browser-reported parent origin.
 */
export function streambimOrigin() {
  const override = new URLSearchParams(window.location.search).get('streambimOrigin');
  if (override) return new URL(override).origin;
  const ancestors = window.location.ancestorOrigins; // parent first (Chrome, Safari)
  if (ancestors && ancestors.length) return ancestors[0];
  if (document.referrer) return new URL(document.referrer).origin; // Firefox
  return null;
}

/**
 * Absolute URLs to try, in order, for a downloadlink response. A relative
 * path is tried at the StreamBIM origin first, then under /project-<id>/ in
 * case it is relative to the project rather than the site.
 */
export function downloadUrlCandidates(link, projectId) {
  if (/^https?:\/\//i.test(link)) return [link];
  const origin = streambimOrigin();
  if (!origin) {
    throw new Error('StreamBIM returned a relative download link but its origin is unknown - '
      + 'add ?streambimOrigin=https://<streambim host> to the widget URL');
  }
  const path = link.startsWith('/') ? link : '/' + link;
  const candidates = [origin + path];
  if (!path.startsWith('/project-')) candidates.push(`${origin}/project-${projectId}${path}`);
  return candidates;
}

export function fetchDocumentDownloadUrl(projectId, documentId) {
  return StreamBIM.API.makeApiRequest({
    method: 'GET',
    path: `/project-${projectId}/api/v1/documents/${documentId}/downloadlink`,
  }).then((response) => {
    debugLog('[streambim] downloadlink response', response);
    if (typeof response === 'string') return response;
    if (response && typeof response.url === 'string') return response.url;
    if (response && typeof response.downloadUrl === 'string') return response.downloadUrl;
    // Some endpoints return the link as the only key in the object
    const vals = response && Object.values(response);
    if (vals && vals.length === 1 && typeof vals[0] === 'string') return vals[0];
    throw new Error('Unexpected downloadlink response: ' + JSON.stringify(response));
  });
}

/** StreamBIM's own field of view (scene-manager._calculateFov): vertical degrees from the
 *  viewport aspect; StreamBIM's cameraState carries no fov. */
export function streambimFov(aspect) {
  return Math.min(Math.max(55, 105 / Math.pow(aspect, 1 / Math.E)), 140);
}

// StreamBIM world -> IFC world: (x, y, z)_SB = (X, -Z, Y)_IFC, so IFC = A * SB with
// A = [[1,0,0],[0,0,1],[0,-1,0]] (y points down in StreamBIM). Verified live on
// app.streambim.com against the Kaj16 IFC columns (2026-10-15).
const SB_TO_IFC = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const SB_TO_IFC_Q = new THREE.Quaternion().setFromRotationMatrix(SB_TO_IFC);

/**
 * A StreamBIM cameraState in the frame of a splat trained in a local IFC frame
 * (X_local = X_ifc - ifcOffset, z up): {position, quaternion} for a Three.js camera.
 */
export function streambimToScene(state, ifcOffset) {
  const p = new THREE.Vector3().fromArray(state.position).applyMatrix4(SB_TO_IFC)
    .sub(new THREE.Vector3().fromArray(ifcOffset));
  const q = SB_TO_IFC_Q.clone().multiply(new THREE.Quaternion().fromArray(state.quaternion));
  return { position: p.toArray(), quaternion: q.toArray() };
}

/**
 * Applies a StreamBIM CameraState to a Three.js camera. The exact shape of
 * CameraState is not fully documented, so this is written defensively to
 * handle either a quaternion-based or a target/up-based orientation.
 *
 * Recognized fields (all optional, applied independently):
 *   - position:   [x, y, z]
 *   - quaternion: [x, y, z, w]            (preferred orientation source)
 *   - target:     [x, y, z]  + up: [x,y,z] (used if quaternion absent)
 *   - fov:        number (degrees; values <= PI are treated as radians)
 *   - near, far:  number
 *
 * Position/up/target vectors are applied verbatim - no coordinate
 * transform - since the splat scene and the BIM model share one world
 * coordinate space.
 */
export function applyCameraState(camera, state, frame = null) {
  if (frame && frame.ifcOffset && state && Array.isArray(state.position) && Array.isArray(state.quaternion)) {
    // StreamBIM camera into the splat's local IFC frame, with StreamBIM's fov for
    // whatever aspect the view has when it renders (camera.userData.streambimFov)
    const s = streambimToScene(state, frame.ifcOffset);
    camera.position.fromArray(s.position);
    camera.quaternion.fromArray(s.quaternion);
    camera.userData.streambimFov = true;
    camera.fov = streambimFov(camera.aspect || 1);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return;
  }
  camera.userData.streambimFov = false;
  if (!state || typeof state !== 'object') {
    console.warn('[cameraAdapter] received non-object cameraState', state);
    return;
  }

  let recognized = false;

  if (Array.isArray(state.position) && state.position.length >= 3) {
    camera.position.fromArray(state.position);
    recognized = true;
  }

  if (Array.isArray(state.quaternion) && state.quaternion.length >= 4) {
    camera.quaternion.fromArray(state.quaternion);
    recognized = true;
  } else if (Array.isArray(state.target) && state.target.length >= 3) {
    if (Array.isArray(state.up) && state.up.length >= 3) {
      camera.up.fromArray(state.up);
    }
    _target.fromArray(state.target);
    camera.lookAt(_target);
    recognized = true;
  }

  let projectionDirty = false;

  if (typeof state.fov === 'number' && camera.isPerspectiveCamera) {
    // Three.js PerspectiveCamera.fov is vertical FOV in degrees. If the
    // value looks like radians, convert it.
    camera.fov = state.fov <= Math.PI ? THREE.MathUtils.radToDeg(state.fov) : state.fov;
    recognized = true;
    projectionDirty = true;
  }

  if (camera.isPerspectiveCamera) {
    if (typeof state.near === 'number') {
      camera.near = state.near;
      recognized = true;
      projectionDirty = true;
    }
    if (typeof state.far === 'number') {
      camera.far = state.far;
      recognized = true;
      projectionDirty = true;
    }
  }

  if (!recognized) {
    console.warn('[cameraAdapter] unrecognized cameraState shape, no fields applied:', JSON.stringify(state));
    return;
  }

  camera.updateMatrixWorld(true);
  if (projectionDirty) {
    camera.updateProjectionMatrix();
  }
}
