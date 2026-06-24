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

export function loadSplatScene(viewer, plyUrl) {
  return viewer.addSplatScene(plyUrl, {
    splatAlphaRemovalThreshold: 5,
    showLoadingUI: true,
  });
}
