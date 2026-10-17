import { FLAG } from './viewer.js';

// StreamBIM's viewer state with the semantics seen in app.streambim.com (2026-10-15):
//  - hiddenObjects: GUIDs (viewerController.hiddenObjects, hideObject/showObject/showAllObjects)
//  - selection: first click selects the outermost IfcElementAssembly, a click on the
//    selected assembly selects the clicked part (selectPickedObjects)
//  - layers: one per published IFC file, visibility map (getLayers/setLayers)
//  - IFC search: matches HIGHLIGHTED (#00ff00), the rest FADED | HIDDEN | ORIGINAL
//  - colour coding by GUID (colorCodeObjects)
// getViewportState() returns the same shape as StreamBIM's widget API.

export class ViewerState {
  constructor(model, viewer) {
    this.model = model;
    this.viewer = viewer;
    this.hidden = new Set();           // element indices hidden one by one
    this.selected = new Set();         // element indices drawn as selected
    this.selectedGuid = null;          // what pickedObject reports (assembly or part)
    this.layers = Object.fromEntries(model.layers.map((l) => [l.name, true]));
    this.search = null;                // { hits: Set(index), mode: 'FADED'|'HIDDEN'|'ORIGINAL', color }
    this.colorCoding = new Map();      // index -> '#rrggbb'
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _changed(what) { this.apply(); for (const fn of this.listeners) fn(what); }

  indicesFor(guid) {
    const e = this.model.byGuid.get(guid);
    if (e) return [e.index];
    const a = this.model.assemblies.get(guid);
    return a ? a.parts : [];
  }

  apply() {
    const v = this.viewer;
    const layerOf = (e) => e.layerName || e.layer;
    for (const e of this.model.elements) {
      const i = e.index;
      let f = 0;
      if (this.hidden.has(i)) f |= FLAG.HIDDEN;
      if (!this.layers[layerOf(e)]) f |= FLAG.LAYER_HIDDEN;
      if (this.search) {
        if (this.search.hits.has(i)) { f |= FLAG.SEARCH; v.setOverride(i, this.colorCoding.get(i) || this.search.color); }
        else if (this.search.mode === 'FADED') f |= FLAG.FADED;
        else if (this.search.mode === 'HIDDEN') f |= FLAG.HIDDEN;
      } else if (this.colorCoding.has(i)) { f |= FLAG.COLORED; v.setOverride(i, this.colorCoding.get(i)); }
      if (this.selected.has(i)) f |= FLAG.SELECTED;
      v.setFlags(i, f);
    }
    v.commitState();
  }

  // ---- selection (click semantics) ----------------------------------------
  pick(element) {
    if (!element) { this.clearSelection(); return null; }
    const asm = element.assembly && this.model.assemblies.get(element.assembly);
    let guid;
    if (asm && this.selectedGuid === asm.guid) guid = element.guid;      // drill down into the part
    else guid = asm ? asm.guid : element.guid;
    this.select(guid);
    return guid;
  }

  select(guid) {
    this.selected = new Set(this.indicesFor(guid));
    this.selectedGuid = guid;
    this._changed('selection');
  }

  clearSelection() { this.selected.clear(); this.selectedGuid = null; this._changed('selection'); }

  // ---- hide / show ----------------------------------------------------------
  hide(guid) { const ix = this.indicesFor(guid); if (!ix.length) return false; ix.forEach((i) => this.hidden.add(i)); this._changed('hidden'); return true; }
  show(guid) { this.indicesFor(guid).forEach((i) => this.hidden.delete(i)); this._changed('hidden'); return true; }
  showAll() { this.hidden.clear(); this._changed('hidden'); }
  hiddenGuids() {
    // report assemblies whole when all their parts are hidden, like StreamBIM's hidden list
    const out = [];
    const done = new Set();
    for (const i of this.hidden) {
      const e = this.model.elements[i];
      const a = e.assembly && this.model.assemblies.get(e.assembly);
      if (a && a.parts.every((p) => this.hidden.has(p))) { if (!done.has(a.guid)) { done.add(a.guid); out.push(a.guid); } }
      else out.push(e.guid);
    }
    return out;
  }

  // ---- layers ---------------------------------------------------------------
  setLayers(map) { for (const [k, val] of Object.entries(map)) if (k in this.layers) this.layers[k] = !!val; this._changed('layers'); }

  // ---- search ---------------------------------------------------------------
  /** rules: [[{propKey, propValue, operator?}]] (OR of AND-groups), as StreamBIM's ifc-searches. */
  applySearch(rules, mode = 'FADED', color = '#00ff00') {
    const hits = new Set();
    for (const e of this.model.elements) {
      if (rules.some((group) => group.every((r) => matchRule(e, r)))) hits.add(e.index);
    }
    this.search = { hits, mode, color, rules };
    this._changed('search');
    return [...hits].map((i) => this.model.elements[i].guid);
  }
  setSearchMode(mode) { if (this.search) { this.search.mode = mode; this._changed('search'); } this.searchMode = mode; }
  resetSearch() { this.search = null; this._changed('search'); }

  colorCode(map) {
    this.colorCoding.clear();
    for (const [guid, color] of Object.entries(map || {})) {
      for (const i of this.indicesFor(guid)) this.colorCoding.set(i, color.startsWith('#') ? color : '#' + color);
    }
    this._changed('colorcoding');
  }

  viewportState(cameraState) {
    return {
      cameraState,
      hiddenObjects: this.hiddenGuids(),
      highlightedObjects: this.selectedGuid ? [this.selectedGuid, ...[...this.selected].map((i) => this.model.elements[i].guid)] : [],
      hiddenLayers: Object.entries(this.layers).filter(([, v]) => !v).map(([k]) => k),
      highlightedLayers: [],
      clippingPlanes: [],
    };
  }
}

// properties searchable like StreamBIM's quick rules (@kind = IFC class)
export function propOf(e, key) {
  switch (key) {
    case '@kind': case 'kind': case 'IFC Type': return e.kind;
    case 'Name': return e.name;
    case 'ObjectType': case 'Type': return e.type;
    case 'Tag': return e.tag;
    case 'Floor': case 'Storey': return e.storey;
    case 'Layer': return e.layer;
    case 'Material': return e.material || '';
    case 'Assembly': return e.assemblyName || '';
    case 'GUID': case 'GlobalId': return e.guid;
    default: return undefined;
  }
}

function matchRule(e, r) {
  const v = propOf(e, r.propKey);
  if (v === undefined || v === null) return false;
  const want = String(r.propValue ?? '');
  const op = r.operator || '=';
  if (op === '=' ) return String(v).toLowerCase() === want.toLowerCase() || (want.includes('*') && wildcard(want).test(String(v)));
  if (op === '~' || op === 'contains') return String(v).toLowerCase().includes(want.toLowerCase());
  if (op === '!=') return String(v).toLowerCase() !== want.toLowerCase();
  const a = parseFloat(v), b = parseFloat(want);
  if (op === '>') return a > b;
  if (op === '<') return a < b;
  return false;
}

function wildcard(p) { return new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'); }
