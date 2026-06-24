import 'streambim-widget-api';
import * as THREE from 'three';

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
export function connectStreamBIM({ onCameraState }) {
  const connected = StreamBIM.connectToParent(window.parent, {
    cameraChanged: (cameraState) => {
      console.debug('[streambim] cameraChanged', cameraState);
      onCameraState(cameraState);
    },
    pickedObject: () => {},
    spacesChanged: () => {},
    floorChanged: () => {},
    didExpand: () => {},
    didContract: () => {},
    beforeInit: () => {},
  }).then(() => {
    return StreamBIM.API.getCameraState()
      .then((initialState) => {
        console.debug('[streambim] initial cameraState', initialState);
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
export function fetchDocumentDownloadUrl(projectId, documentId) {
  return StreamBIM.API.makeApiRequest({
    method: 'GET',
    path: `/project-${projectId}/api/v1/documents/${documentId}/downloadlink`,
  }).then((response) => {
    console.debug('[streambim] downloadlink response', response);
    if (typeof response === 'string') return response;
    if (response && typeof response.url === 'string') return response.url;
    if (response && typeof response.downloadUrl === 'string') return response.downloadUrl;
    // Some endpoints return the link as the only key in the object
    const vals = response && Object.values(response);
    if (vals && vals.length === 1 && typeof vals[0] === 'string') return vals[0];
    throw new Error('Unexpected downloadlink response: ' + JSON.stringify(response));
  });
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
export function applyCameraState(camera, state) {
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
