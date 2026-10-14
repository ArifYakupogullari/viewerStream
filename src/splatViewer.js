import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';

/**
 * Sets up a GaussianSplats3D viewer rendered via Three.js WebGLRenderer,
 * confined to `container`, with an externally-driven camera (no built-in
 * orbit controls) so it can be kept in sync with StreamBIM's camera.
 */
export function initSplatViewer(container) {
  const aspect = container.clientWidth / container.clientHeight || 1;

  const camera = new THREE.PerspectiveCamera(65, aspect, 0.1, 500);
  camera.position.set(0, 1.6, 5);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  const viewer = new GaussianSplats3D.Viewer({
    camera,
    rootElement: container,
    useBuiltInControls: false,
    selfDrivenMode: true,
    // Avoids requiring SharedArrayBuffer / COOP+COEP headers, which are
    // unlikely to be configurable when this widget is embedded as a
    // cross-origin iframe inside StreamBIM.
    sharedMemoryForWorkers: false,
  });

  return { viewer, camera };
}

export const PLY_FORMAT = GaussianSplats3D.SceneFormat.Ply;

/**
 * @param {string} plyUrl
 * @param {number} [format] - needed for blob: URLs, which carry no extension
 */
export function loadSplatScene(viewer, plyUrl, format) {
  return viewer.addSplatScene(plyUrl, {
    splatAlphaRemovalThreshold: 5,
    showLoadingUI: true,
    ...(format !== undefined ? { format } : {}),
  });
}

/**
 * Downloads a scene once, reporting progress, and returns a blob: URL for
 * loadSplatScene(). StreamBIM download links carry a short-lived token, so
 * they are fetched exactly once rather than handed to the loader to retry.
 * Revoke the URL (URL.revokeObjectURL) once the scene has loaded.
 */
export async function fetchScene(url, onProgress) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    // A network-level failure here is usually CORS: the file server must
    // allow this widget's origin (see README "StreamBIM sandbox").
    throw new Error(`download blocked or unreachable (${err.message})`);
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  return URL.createObjectURL(new Blob(chunks));
}
