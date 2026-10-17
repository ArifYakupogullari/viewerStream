import * as THREE from 'three';

// A StreamBIM-like 3D view, reverse engineered from app.streambim.com (2026-10-15):
//  - world frame (x, y, z) = (X_ifc, -Z_ifc, Y_ifc): y points DOWN, camera.up = (0,-1,0)
//  - scene rendered around the building centre; cameraState reports world coordinates
//  - vertical fov = clamp(105 / aspect^(1/e), 55, 140) degrees (scene-manager._calculateFov)
//  - sky: gradient sphere 0x7FA4E0 -> white; lights hemi .3, ambient .5, dir .5/.3, camera .3
//  - selection #ffa500, search hits #00ff00, out-of-search FADED / HIDDEN / ORIGINAL
//  - cameraChanged throttled to 10 ms with {position, quaternion}
// Element state lives in a texture indexed by element, so filters cost no geometry work.

export const FLAG = { HIDDEN: 1, FADED: 2, SELECTED: 4, SEARCH: 8, COLORED: 16, LAYER_HIDDEN: 32 };
export const UP = new THREE.Vector3(0, -1, 0);
const EAST = new THREE.Vector3(1, 0, 0);
const NORTH = new THREE.Vector3(0, 0, 1);

export function streambimFov(aspect) {
  return Math.min(Math.max(55, 105 / Math.pow(aspect, 1 / Math.E)), 140);
}

const VERT = /* glsl */ `
  attribute vec4 color;
  attribute float eid;
  uniform sampler2D stateTex;
  uniform sampler2D colorTex;
  uniform float texW;
  varying vec4 vColor;
  varying vec3 vWorld;
  varying vec3 vView;
  varying float vFlags;
  varying vec3 vOverride;
  void main() {
    ivec2 uv = ivec2(int(mod(eid, texW)), int(floor(eid / texW)));
    vFlags = floor(texelFetch(stateTex, uv, 0).r * 255.0 + 0.5);
    vOverride = texelFetch(colorTex, uv, 0).rgb;
    vColor = color;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  uniform int uPass;          // 0 opaque, 1 transparent
  uniform vec3 uSelColor;
  varying vec4 vColor;
  varying vec3 vWorld;
  varying vec3 vView;
  varying float vFlags;
  varying vec3 vOverride;
  void main() {
    int f = int(vFlags);
    if ((f & 1) != 0 || (f & 32) != 0) discard;           // hidden object / hidden layer
    bool faded = (f & 2) != 0;
    vec3 base = vColor.rgb;
    float a = vColor.a;
    if ((f & 16) != 0 || (f & 8) != 0) base = vOverride;   // colour coded / search hit
    if ((f & 4) != 0) base = uSelColor;                    // selected
    if (faded) { base = mix(base, vec3(0.86, 0.88, 0.92), 0.65); a = 0.12; }
    bool transparent = a < 0.99;
    if (uPass == 0 && transparent) discard;
    if (uPass == 1 && !transparent) discard;
    vec3 nw = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    vec3 nv = normalize(cross(dFdx(vView), dFdy(vView)));
    float hemi = 0.5 + 0.5 * dot(nw, vec3(0.0, -1.0, 0.0));
    float dir1 = max(dot(nw, normalize(vec3(0.4, -1.0, 0.25))), 0.0);
    float dir2 = max(dot(nw, normalize(vec3(-0.5, -0.4, -0.6))), 0.0);
    float head = abs(nv.z);
    float lit = 0.5 + 0.3 * hemi + 0.5 * dir1 + 0.3 * dir2 + 0.3 * head;
    gl_FragColor = vec4(base * min(lit, 1.35) * 0.82, a);
  }`;

// picking writes the element index (passed per vertex) instead of colour
const PICK_VERT = VERT.replace('vColor = color;', 'vColor = vec4(mod(eid + 1.0, 256.0), mod(floor((eid + 1.0) / 256.0), 256.0), floor((eid + 1.0) / 65536.0), 255.0) / 255.0;');
const PICK_FRAG = /* glsl */ `
  varying vec4 vColor;
  varying vec3 vWorld;
  varying vec3 vView;
  varying float vFlags;
  varying vec3 vOverride;
  void main() {
    int f = int(vFlags);
    if ((f & 1) != 0 || (f & 32) != 0 || (f & 2) != 0) discard;
    gl_FragColor = vec4(vColor.rgb, 1.0);
  }`;

export class MockViewer {
  constructor(container, model, { onCamera, onPick, onFloor } = {}) {
    this.model = model;
    this.container = container;
    this.onCamera = onCamera || (() => {});
    this.onPick = onPick || (() => {});
    this.onFloor = onFloor || (() => {});
    this.navigationMode = 0; // 0 person (walk/look), 1 spin (orbit)

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.LinearSRGBColorSpace; // colours are used as given, like StreamBIM's r113 pipeline
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 3000);
    this.camera.up.copy(UP);
    this.skyColor = new THREE.Color(0x7fa4e0);
    this._makeSky();

    // element state textures
    const n = model.elements.length;
    this.texW = 1024;
    const texH = Math.ceil((n + 1) / this.texW);
    this.flags = new Uint8Array(this.texW * texH * 4);
    this.colors = new Uint8Array(this.texW * texH * 4);
    this.stateTex = new THREE.DataTexture(this.flags, this.texW, texH, THREE.RGBAFormat);
    this.colorTex = new THREE.DataTexture(this.colors, this.texW, texH, THREE.RGBAFormat);
    for (const t of [this.stateTex, this.colorTex]) { t.magFilter = t.minFilter = THREE.NearestFilter; t.needsUpdate = true; }

    const uniforms = () => ({
      stateTex: { value: this.stateTex }, colorTex: { value: this.colorTex }, texW: { value: this.texW },
      uPass: { value: 0 }, uSelColor: { value: new THREE.Color(0xffa500) },
    });
    this.opaqueMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: uniforms(), side: THREE.DoubleSide });
    this.transMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: uniforms(), side: THREE.DoubleSide,
      transparent: true, depthWrite: false });
    this.transMat.uniforms.uPass.value = 1;
    this.pickMat = new THREE.ShaderMaterial({ vertexShader: PICK_VERT, fragmentShader: PICK_FRAG, uniforms: uniforms(), side: THREE.DoubleSide });

    this.layerMeshes = new Map();
    for (const layer of model.layers) {
      const o = new THREE.Mesh(layer.geometry, this.opaqueMat);
      const t = new THREE.Mesh(layer.geometry, this.transMat);
      t.renderOrder = 1;
      o.frustumCulled = t.frustumCulled = false;
      this.scene.add(o, t);
      this.layerMeshes.set(layer.name, [o, t]);
    }
    this.pickScene = new THREE.Scene();
    for (const layer of model.layers) {
      const p = new THREE.Mesh(layer.geometry, this.pickMat);
      p.frustumCulled = false;
      this.pickScene.add(p);
    }
    this.pickTarget = new THREE.WebGLRenderTarget(1, 1);

    // camera: person mode state (position + yaw/pitch with world up = -y)
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this._lastEmit = 0;
    this._emitTimer = null;
    this._keys = new Set();
    this._dirty = true;
    this._floor = null;
    this._bindInput();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = (t) => { this._tick(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  _makeSky() {
    const g = new THREE.SphereGeometry(1500, 32, 16);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { topColor: { value: this.skyColor }, bottomColor: { value: new THREE.Color(0xffffff) } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); }',
      fragmentShader: 'uniform vec3 topColor; uniform vec3 bottomColor; varying vec3 vDir; void main(){ float h = clamp(-vDir.y * 1.6 + 0.35, 0.0, 1.0); gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0); }',
    });
    this.sky = new THREE.Mesh(g, this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
  }

  setSkyColor(c) { this.skyColor.set(c); this._dirty = true; }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.fov = streambimFov(this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this._dirty = true;
  }

  // ---- camera ------------------------------------------------------------
  _forward() {
    const cp = Math.cos(this.pitch);
    return EAST.clone().multiplyScalar(cp * Math.cos(this.yaw)).addScaledVector(NORTH, cp * Math.sin(this.yaw)).addScaledVector(UP, Math.sin(this.pitch));
  }

  _applyCamera() {
    this.camera.position.copy(this.pos);
    this.camera.up.copy(UP);
    this.camera.lookAt(this.pos.clone().add(this._forward()));
    this.camera.updateMatrixWorld(true);
    this._dirty = true;
    this._scheduleEmit();
  }

  /** StreamBIM cameraState {position, quaternion} in world coordinates. */
  getCameraState() {
    return { position: this.camera.position.clone().add(this.model.centre).toArray(), quaternion: this.camera.quaternion.toArray() };
  }

  setCameraState(state) {
    this.pos.fromArray(state.position).sub(this.model.centre);
    const q = new THREE.Quaternion().fromArray(state.quaternion);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    this.pitch = Math.asin(THREE.MathUtils.clamp(f.dot(UP), -1, 1));
    this.yaw = Math.atan2(f.dot(NORTH), f.dot(EAST));
    this._applyCamera();
  }

  lookAtBox(box) {
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.6, 1.5);
    const f = this._forward();
    this.pos.copy(c).addScaledVector(f, -r * 1.6);
    this._applyCamera();
  }

  _scheduleEmit() {
    // StreamBIM: _.throttle(cameraChangedEvent.fire, 10)
    const now = performance.now();
    if (now - this._lastEmit >= 10) { this._emit(); return; }
    if (!this._emitTimer) this._emitTimer = setTimeout(() => { this._emitTimer = null; this._emit(); }, 10);
  }

  _emit() {
    this._lastEmit = performance.now();
    const cs = this.getCameraState();
    this.onCamera(cs);
    const fl = this.floorFor(cs.position);
    if (fl !== this._floor) { this._floor = fl; this.onFloor(fl); }
  }

  floorFor(position) {
    const zIfc = -position[1];
    let best = null;
    for (const s of this.model.floors || []) if (zIfc >= s.elevation - 0.3) best = s.id;
    return best;
  }

  // ---- input (person: left look, right/middle pan, wheel dolly to cursor, WASD/arrows) --
  _bindInput() {
    const el = this.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const hit = this.pickPoint(e.offsetX, e.offsetY);
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, button: e.button, yaw: this.yaw, pitch: this.pitch,
        pos: this.pos.clone(), pivot: hit ? hit.point.clone().sub(this.model.centre) : null, moved: false };
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const w = el.clientWidth;
      if (drag.button === 0 && this.navigationMode === 0) {
        this.yaw = drag.yaw - (dx / w) * Math.PI * 1.1;
        this.pitch = THREE.MathUtils.clamp(drag.pitch + (dy / w) * Math.PI * 1.1, -1.5, 1.5);
        this._applyCamera();
      } else if (drag.button === 0 && this.navigationMode === 1) {
        const pivot = drag.pivot || drag.pos.clone().addScaledVector(this._forward(), 6);
        const off = drag.pos.clone().sub(pivot);
        const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, (dx / w) * Math.PI * 1.5);
        const right = this._forward().cross(UP).normalize();
        const qPitch = new THREE.Quaternion().setFromAxisAngle(right, (dy / w) * Math.PI * 1.5);
        off.applyQuaternion(qPitch).applyQuaternion(qYaw);
        this.pos.copy(pivot).add(off);
        const f = pivot.clone().sub(this.pos).normalize();
        this.pitch = Math.asin(THREE.MathUtils.clamp(f.dot(UP), -1, 1));
        this.yaw = Math.atan2(f.dot(NORTH), f.dot(EAST));
        drag.pos.copy(this.pos); drag.x0 = e.clientX; drag.y0 = e.clientY;
        this._applyCamera();
      } else {
        const dist = drag.pivot ? drag.pivot.distanceTo(drag.pos) : 6;
        const k = (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / el.clientHeight;
        const right = this._forward().cross(UP).normalize();
        const camUp = right.clone().cross(this._forward()).normalize();
        this.pos.copy(drag.pos).addScaledVector(right, -dx * k).addScaledVector(camUp, dy * k);
        this._applyCamera();
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && drag.button === 0) this._click(e);
      drag = null;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const hit = this.pickPoint(e.offsetX, e.offsetY);
      const ray = this._rayAt(e.offsetX, e.offsetY);
      const dist = hit ? hit.point.clone().sub(this.model.centre).distanceTo(this.pos) : 8;
      const step = Math.sign(-e.deltaY) * Math.max(0.2, dist * 0.15);
      this.pos.addScaledVector(ray.direction, step);
      this._applyCamera();
    }, { passive: false });
    window.addEventListener('keydown', (e) => { if (!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) this._keys.add(e.code); });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
  }

  _tick(t) {
    const dt = Math.min((t - (this._lastT || t)) / 1000, 0.1);
    this._lastT = t;
    if (this._keys.size) {
      const speed = (this._keys.has('ShiftLeft') || this._keys.has('ShiftRight') ? 6 : 2.2) * dt;
      const f = this._forward(), right = f.clone().cross(UP).normalize();
      const k = this._keys;
      const mv = new THREE.Vector3();
      if (k.has('KeyW') || k.has('ArrowUp')) mv.add(f);
      if (k.has('KeyS') || k.has('ArrowDown')) mv.sub(f);
      if (k.has('KeyD') || k.has('ArrowRight')) mv.add(right);
      if (k.has('KeyA') || k.has('ArrowLeft')) mv.sub(right);
      if (k.has('KeyE')) mv.add(UP);
      if (k.has('KeyQ')) mv.sub(UP);
      if (mv.lengthSq()) { this.pos.addScaledVector(mv.normalize(), speed); this._applyCamera(); }
    }
    if (this._dirty) {
      this._dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  }

  invalidate() { this._dirty = true; }

  _rayAt(x, y) {
    const ndc = new THREE.Vector2((x / this.renderer.domElement.clientWidth) * 2 - 1, -(y / this.renderer.domElement.clientHeight) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc.ray;
  }

  /** GPU pick of the element under a canvas pixel, then the exact hit on its triangles. */
  pickPoint(x, y) {
    const el = this.renderer.domElement;
    const dpr = this.renderer.getPixelRatio();
    const cam = this.camera.clone();
    cam.setViewOffset(el.clientWidth * dpr, el.clientHeight * dpr, Math.floor(x * dpr), Math.floor(y * dpr), 1, 1);
    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.pickScene, cam);
    const px = new Uint8Array(4);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, px);
    this.renderer.setRenderTarget(null);
    const id = px[0] + px[1] * 256 + px[2] * 65536 - 1;
    if (id < 0) return null;
    const e = this.model.elements[id];
    const ray = this._rayAt(x, y);
    const layer = this.model.layers.find((l) => l.name === e.layerName);
    const p = layer.geometry.attributes.position.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    let best = null;
    for (let v = e.vStart; v < e.vStart + e.vCount; v += 3) {
      a.fromArray(p, v * 3); b.fromArray(p, v * 3 + 3); c.fromArray(p, v * 3 + 6);
      if (ray.intersectTriangle(a, b, c, false, hit)) {
        const d = hit.distanceTo(ray.origin);
        if (!best || d < best.d) best = { d, point: hit.clone() };
      }
    }
    const point = (best ? best.point : ray.origin.clone().addScaledVector(ray.direction, 5)).add(this.model.centre);
    return { element: e, point };
  }

  _click(e) {
    const hit = this.pickPoint(e.offsetX, e.offsetY);
    this.onPick(hit, e);
  }

  // ---- element state ----------------------------------------------------
  setFlags(index, flags) { this.flags[index * 4] = flags; }
  getFlags(index) { return this.flags[index * 4]; }
  setOverride(index, color) {
    const c = new THREE.Color(color);
    this.colors[index * 4] = Math.round(c.r * 255); this.colors[index * 4 + 1] = Math.round(c.g * 255); this.colors[index * 4 + 2] = Math.round(c.b * 255);
  }
  commitState() { this.stateTex.needsUpdate = true; this.colorTex.needsUpdate = true; this._dirty = true; }

  screenshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}
