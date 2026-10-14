import 'streambim-widget-api';
import * as THREE from 'three';

// See src/streambim.js - the streambim-widget-api UMD bundle assigns itself
// to `window.StreamBIM` rather than exporting anything.
const StreamBIM = window.StreamBIM;

const iframe = document.getElementById('widget-frame');
const plyUrlInput = document.getElementById('plyUrlInput');
const loadBtn = document.getElementById('loadBtn');
const sendBtn = document.getElementById('sendBtn');
const quaternionModeCheckbox = document.getElementById('quaternionMode');
const targetUpFields = document.getElementById('targetUpFields');
const eulerFields = document.getElementById('eulerFields');
const orbitToggle = document.getElementById('orbitToggle');
const eventsEl = document.getElementById('events');

let widgetAPI = null;
let lastFakeCameraState = null;
let orbitIntervalId = null;
let orbitAngle = 0;

function logEvent(text) {
  const el = document.createElement('div');
  el.textContent = text;
  eventsEl.appendChild(el);
  eventsEl.scrollTop = eventsEl.scrollHeight;
}

// Methods exposed to the widget as `StreamBIM.API`. The widget calls these
// the same way it would call into a real StreamBIM instance.
const hostMethods = {
  getProjectId: () => 'fake-project-1',
  getUserEmail: () => 'dev@example.com',
  getBuildingId: () => 'fake-building-1',
  getCameraState: () => lastFakeCameraState,
  setCameraState: (state) => {
    logEvent('widget -> setCameraState: ' + JSON.stringify(state));
    return true;
  },
  setCameraPosition: (position) => {
    logEvent('widget -> setCameraPosition: ' + JSON.stringify(position));
    return true;
  },
  setShowExpandButton: () => true,
  setExpanded: () => true,
  setStyles: () => true,
  setSkyColor: () => true,
  setNavigationMode: () => true,
  // Document endpoints, shaped like StreamBIM's: the downloadlink is a path
  // relative to the StreamBIM origin with a short-lived token, e.g.
  // "/documents/1078/_download/scene.ply?microtoken=...". Here it points at
  // the dev server's public/test-scenes/test-scene.ply (tests/make_test_ply.py).
  makeApiRequest: ({ method, path }) => {
    logEvent(`widget -> makeApiRequest ${method} ${path}`);
    if (/\/api\/v1\/documents$/.test(path)) {
      return [{ id: 1, filename: 'test-scene.ply' }, { id: 2, filename: 'notes.pdf' }];
    }
    if (/\/api\/v1\/documents\/1\/downloadlink$/.test(path)) {
      return '/test-scenes/test-scene.ply?microtoken=fake-token';
    }
    throw new Error('fake host: no such endpoint ' + path);
  },
};

function connectWidget(plyUrl) {
  if (StreamBIM._connection && typeof StreamBIM._connection.destroy === 'function') {
    StreamBIM._connection.destroy();
  }
  widgetAPI = null;

  // Empty plyUrl = StreamBIM document mode (project id from getProjectId,
  // documents from makeApiRequest below); the Remote panel works in both.
  // relative, so it also works in the deployed dev channel (/viewerStream/dev/host/)
  iframe.src = '../?debug=1' + (plyUrl ? '&plyUrl=' + encodeURIComponent(plyUrl) : '');

  StreamBIM.connectToChild(iframe, hostMethods)
    .then(() => {
      widgetAPI = StreamBIM.API;
      logEvent('Widget connected');
      if (lastFakeCameraState) {
        sendCameraChanged(lastFakeCameraState);
      }
    })
    .catch((err) => {
      logEvent('Connection failed: ' + JSON.stringify(err));
    });
}

function readNumber(id) {
  return parseFloat(document.getElementById(id).value);
}

function buildCameraState() {
  const position = [readNumber('posX'), readNumber('posY'), readNumber('posZ')];
  const fov = readNumber('fov');

  if (quaternionModeCheckbox.checked) {
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(readNumber('pitch')),
      THREE.MathUtils.degToRad(readNumber('yaw')),
      THREE.MathUtils.degToRad(readNumber('roll')),
      'YXZ'
    );
    const quaternion = new THREE.Quaternion().setFromEuler(euler);
    return { position, quaternion: quaternion.toArray(), fov };
  }

  const target = [readNumber('tgtX'), readNumber('tgtY'), readNumber('tgtZ')];
  const up = [readNumber('upX'), readNumber('upY'), readNumber('upZ')];
  return { position, target, up, fov };
}

function sendCameraChanged(state) {
  lastFakeCameraState = state;
  if (!widgetAPI) {
    logEvent('Cannot send cameraChanged: widget not connected yet');
    return;
  }
  widgetAPI.cameraChanged(state).catch((err) => {
    logEvent('cameraChanged error: ' + JSON.stringify(err));
  });
}

function computeOrbitState(angle) {
  const radius = 5;
  const position = [Math.sin(angle) * radius, 1.6, Math.cos(angle) * radius];
  const fov = readNumber('fov');

  if (quaternionModeCheckbox.checked) {
    const dummy = new THREE.Object3D();
    dummy.position.fromArray(position);
    dummy.up.set(0, 1, 0);
    dummy.lookAt(0, 0, 0);
    return { position, quaternion: dummy.quaternion.toArray(), fov };
  }

  return { position, target: [0, 0, 0], up: [0, 1, 0], fov };
}

loadBtn.addEventListener('click', () => connectWidget(plyUrlInput.value));

sendBtn.addEventListener('click', () => sendCameraChanged(buildCameraState()));

quaternionModeCheckbox.addEventListener('change', (e) => {
  targetUpFields.classList.toggle('hidden', e.target.checked);
  eulerFields.classList.toggle('hidden', !e.target.checked);
});

orbitToggle.addEventListener('change', (e) => {
  if (e.target.checked) {
    orbitIntervalId = setInterval(() => {
      orbitAngle += 0.05;
      const state = computeOrbitState(orbitAngle);
      document.getElementById('posX').value = state.position[0].toFixed(2);
      document.getElementById('posY').value = state.position[1].toFixed(2);
      document.getElementById('posZ').value = state.position[2].toFixed(2);
      sendCameraChanged(state);
    }, 1000 / 15);
  } else {
    clearInterval(orbitIntervalId);
    orbitIntervalId = null;
  }
});

connectWidget(plyUrlInput.value);
