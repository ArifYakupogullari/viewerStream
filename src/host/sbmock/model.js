import * as THREE from 'three';

// Loads the BIM written by ~/Kaj16/bim_mock_export.py (public/sbmock-data/, local only,
// never committed or deployed). Positions are in StreamBIM's world frame
// (x, y, z) = (X_ifc, -Z_ifc, Y_ifc) minus `centre`, like StreamBIM's translated scene.
// Each layer .bin = positions f32x3 | colours u8x4 | element index f32 | indices u32.

export async function loadModel(baseUrl) {
  const res = await fetch(baseUrl + 'model.json');
  // the dev server answers a missing file with index.html, so check the type too
  if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) {
    throw new Error(`no model data at ${baseUrl}model.json - run ~/Kaj16/bim_mock_export.py into public/sbmock-data/`);
  }
  const model = await res.json();
  model.centre = new THREE.Vector3().fromArray(model.centre);
  model.byGuid = new Map(model.elements.map((e, i) => { e.index = i; return [e.guid, e]; }));
  // assemblies: StreamBIM selects the outermost assembly first, the part on a second click
  model.assemblies = new Map();
  for (const e of model.elements) {
    if (!e.assembly) continue;
    if (!model.assemblies.has(e.assembly)) model.assemblies.set(e.assembly, { guid: e.assembly, name: e.assemblyName, parts: [] });
    model.assemblies.get(e.assembly).parts.push(e.index);
  }
  model.storeys = [...new Set(model.elements.map((e) => e.storey).filter(Boolean))].sort();

  for (const layer of model.layers) {
    const buf = await (await fetch(baseUrl + layer.file)).arrayBuffer();
    const nv = layer.vertices;
    let off = 0;
    const pos = new Float32Array(buf, off, nv * 3); off += nv * 12;
    const col = new Uint8Array(buf, off, nv * 4); off += nv * 4;
    const eid = new Float32Array(buf, off, nv); off += nv * 4;
    const idx = new Uint32Array(buf, off, layer.indices);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4, true));
    g.setAttribute('eid', new THREE.BufferAttribute(eid, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    layer.geometry = g;
    // vertex range per element (the exporter writes each element contiguously, un-indexed)
    let start = 0;
    for (let v = 1; v <= nv; v++) {
      if (v === nv || eid[v] !== eid[start]) {
        const e = model.elements[eid[start]];
        e.vStart = start; e.vCount = v - start; e.layerName = layer.name;
        start = v;
      }
    }
  }
  return model;
}

export function elementBox(model, e) {
  const b = e.bbox; // StreamBIM world frame (untranslated)
  return new THREE.Box3(new THREE.Vector3(b[0], Math.min(b[1], b[4]), b[2]), new THREE.Vector3(b[3], Math.max(b[1], b[4]), b[5]))
    .translate(model.centre.clone().negate());
}
