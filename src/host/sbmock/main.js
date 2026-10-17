import * as THREE from 'three';
import { loadModel } from './model.js';
import { MockViewer, UP } from './viewer.js';
import { ViewerState, propOf } from './state.js';
import { WidgetHost } from './widgethost.js';

// StreamBIM imitation for developing the splat overlay widget before (and alongside)
// the real project. Open http://localhost:5173/host/streambim/ with `npm run dev`.

const $ = (id) => document.getElementById(id);
const logEl = $('mockLog');
function log(t) {
  const d = document.createElement('div'); d.textContent = t; logEl.appendChild(d);
  while (logEl.childNodes.length > 40) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

// GL1-42 storeys (IFC elevations, m): what StreamBIM's floorChanged reports by
const FLOORS = [['PLAN 10', 36.8], ['PLAN 11', 40.7], ['PLAN 12', 44.6], ['PLAN 13', 48.5], ['PLAN 14', 52.4]];
// level 12 interior, the same viewpoint used in the live StreamBIM test (IFC eye 198, 420, 46.3)
function homeState() {
  const sb = (X, Y, Z) => new THREE.Vector3(X, -Z, Y);
  const eye = sb(198, 420, 46.3), f = sb(1, 0.6, -0.12).normalize();
  const zc = f.clone().negate(), xc = new THREE.Vector3().crossVectors(UP, zc).normalize(), yc = new THREE.Vector3().crossVectors(zc, xc);
  return { position: eye.toArray(), quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xc, yc, zc)).toArray() };
}

const PALETTE = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
  '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080'];

async function main() {
  let model;
  try {
    model = await loadModel('/sbmock-data/');
  } catch (e) {
    $('scene').innerHTML = `<p style="padding:40px;font:16px sans-serif">${e.message}</p>`;
    return;
  }
  model.floors = FLOORS.map(([id, z]) => ({ id, name: id, elevation: z }));
  log(`model: ${model.elements.length} elements, ${model.layers.map((l) => `${l.name} ${(l.indices / 3 / 1e6).toFixed(2)}M tris`).join(', ')}`);

  const group = $('slider-group--left');
  let host = null;
  const viewer = new MockViewer($('scene'), model, {
    onCamera: (cs) => { host && host.trigger('cameraChanged', cs); updateStatus(cs); },
    onFloor: (f) => { host && host.trigger('floorChanged', f); },
    onPick: (hit) => {
      const guid = state.pick(hit && hit.element);
      if (!guid) return;
      showObjectInfo(guid);
      host && host.trigger('pickedObject', { point: hit.point.toArray(), guid });
      log(`picked ${guid} (${hit.element.kind} ${hit.element.name})`);
    },
  });
  const state = new ViewerState(model, viewer);
  state.apply();
  host = new WidgetHost({ model, viewer, state, group, log });
  host.onHome = () => viewer.setCameraState(homeState());
  viewer.setCameraState(homeState());

  // ---- panels (StreamBIM: one active slider at a time, the group slides in) ----
  const sliders = [...group.querySelectorAll('.slider--left')];
  function activate(id) {
    const already = id && !$(id).classList.contains('slider--inactive');
    sliders.forEach((s) => s.classList.add('slider--inactive'));
    group.classList.remove('slider-group--active');
    if (id && !already) {
      $(id).classList.remove('slider--inactive');
      group.classList.add('slider-group--active');
    }
    if (id === 'widgets' && !already) host.openWidget($('widgetUrl').value);
    else if (host.open && (id !== 'widgets' || already)) host.closeWidget();
  }
  group.querySelectorAll('.tab.left').forEach((t) => t.addEventListener('click', () => activate(t.dataset.slider)));
  $('widgetClose').addEventListener('click', () => activate(null));
  $('widgetExpand').addEventListener('click', () => host.setExpanded(!host.expanded));
  document.querySelector('.tab--hiddenobjects').addEventListener('click', () => {
    const on = $('hiddenobjects').classList.toggle('slider--active');
    $('hiddenobjects').classList.toggle('slider--inactive', !on);
  });

  // models / layers
  for (const l of model.layers) {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" checked data-layer="${l.name}" /> ${l.name} <span class="hint">(${l.elements} elements)</span>`;
    $('layerList').appendChild(lab);
  }
  $('layerList').addEventListener('change', (e) => state.setLayers({ [e.target.dataset.layer]: e.target.checked }));
  document.querySelectorAll('input[name=nav]').forEach((r) => r.addEventListener('change', () => { viewer.navigationMode = +r.value; }));

  // object info
  function showObjectInfo(guid) {
    const e = model.byGuid.get(guid), a = model.assemblies.get(guid);
    $('oiTitle').textContent = e ? (e.name || e.kind) : (a ? a.name || 'Element assembly' : guid);
    const rows = e
      ? [['Name', e.name], ['IFC Type', e.kind], ['Object type', e.type], ['Layer', e.layer], ['Floor', e.storey], ['Material', e.material], ['Assembly', e.assemblyName], ['GUID', e.guid]]
      : [['IFC Type', 'Element assembly'], ['Layer', a && model.elements[a.parts[0]].layer], ['Parts', a && a.parts.length], ['GUID', guid]];
    $('oiTable').innerHTML = rows.filter((r) => r[1] !== undefined && r[1] !== '').map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    $('oiParts').innerHTML = '';
    activate('objectinfo');
  }
  $('oiHide').addEventListener('click', () => { if (state.selectedGuid) { state.hide(state.selectedGuid); state.clearSelection(); refreshHidden(); } });
  $('oiSelectParts').addEventListener('click', () => {
    const a = model.assemblies.get(state.selectedGuid);
    $('oiParts').innerHTML = a ? a.parts.map((i) => `<li data-guid="${model.elements[i].guid}">${model.elements[i].kind} ${model.elements[i].name}</li>`).join('') : '';
  });
  $('oiParts').addEventListener('click', (e) => { const g = e.target.dataset.guid; if (g) { state.select(g); showObjectInfo(g); } });

  // hidden objects
  function refreshHidden() {
    const g = state.hiddenGuids();
    $('hList').innerHTML = g.map((x) => { const e = model.byGuid.get(x), a = model.assemblies.get(x); return `<li data-guid="${x}">${e ? e.kind + ' ' + e.name : (a ? a.name : x)} ↺</li>`; }).join('');
  }
  state.onChange((what) => { if (what === 'hidden') refreshHidden(); });
  $('hList').addEventListener('click', (e) => { const g = e.target.dataset.guid; if (g) state.show(g); });
  $('hShowAll').addEventListener('click', () => state.showAll());

  // search
  function fillValues() {
    const key = $('sProp').value;
    const vals = [...new Set(model.elements.map((e) => propOf(e, key)).filter(Boolean))].sort().slice(0, 400);
    $('sValues').innerHTML = vals.map((v) => `<option value="${String(v).replace(/"/g, '&quot;')}">`).join('');
  }
  $('sProp').addEventListener('change', fillValues);
  fillValues();
  const smode = () => document.querySelector('input[name=smode]:checked').value;
  $('sGo').addEventListener('click', () => {
    const hits = state.applySearch([[{ propKey: $('sProp').value, propValue: $('sVal').value, operator: $('sOp').value }]], smode());
    $('sCount').textContent = `${hits.length} objects`;
  });
  $('sReset').addEventListener('click', () => { state.resetSearch(); $('sCount').textContent = ''; });
  document.querySelectorAll('input[name=smode]').forEach((r) => r.addEventListener('change', () => state.setSearchMode(smode())));
  function colorBy(key) {
    const vals = [...new Set(model.elements.map((e) => propOf(e, key)))];
    const col = new Map(vals.map((v, i) => [v, PALETTE[i % PALETTE.length]]));
    state.colorCode(Object.fromEntries(model.elements.map((e) => [e.guid, col.get(propOf(e, key))])));
    $('ccLegend').innerHTML = vals.slice(0, 20).map((v) => `<div><span style="background:${col.get(v)}"></span>${v}</div>`).join('');
  }
  $('ccKind').addEventListener('click', () => colorBy('@kind'));
  $('ccLayer').addEventListener('click', () => colorBy('Layer'));
  $('ccOff').addEventListener('click', () => { state.colorCode({}); $('ccLegend').innerHTML = ''; });

  $('homeBtn').addEventListener('click', () => viewer.setCameraState(homeState()));
  function updateStatus(cs) {
    const p = cs.position;
    $('status').textContent = `IFC ${p[0].toFixed(2)}, ${p[2].toFixed(2)}, ${(-p[1]).toFixed(2)} m · fov ${viewer.camera.fov.toFixed(1)}°`;
  }
  window.sbmock = { model, viewer, state, host }; // for debugging in the console
}

main();
