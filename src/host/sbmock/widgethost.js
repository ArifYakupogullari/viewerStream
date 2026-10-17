import 'streambim-widget-api';
import * as THREE from 'three';
import { elementBox } from './model.js';

const StreamBIM = window.StreamBIM;

// Hosts a widget the way app.streambim.com does (components/widget-component, 2026-10-15):
//  - <iframe id="iframe-widget" class="width-100 margin-top-66 z-index-5 absolute"
//     style="height: calc(100% - 66px)"> appended to #slider-group--left,
//    src = rootUrl + ('?'|'&') + Date.now()
//  - closing the widget hides the iframe (display: none), reopening shows it again
//  - Penpal connection with the widget methods below (same names and semantics)
//  - events to the widget: cameraChanged, pickedObject {point, guid}, floorChanged,
//    spacesChanged, didExpand / didContract (queued while the widget is closed)

export class WidgetHost {
  constructor({ model, viewer, state, group, log }) {
    Object.assign(this, { model, viewer, state, group, log: log || (() => {}) });
    this.iframe = null;
    this.api = null;
    this.open = false;
    this.expanded = false;
    this.pending = [];
    this.styleLinks = [];
  }

  openWidget(rootUrl) {
    if (!this.iframe) {
      const f = this.iframe = document.createElement('iframe');
      f.id = 'iframe-widget';
      f.className = 'width-100 margin-top-66 z-index-5 absolute';
      f.style = 'height: calc(100% - 66px)';
      f.src = rootUrl + (rootUrl.includes('?') ? '&' : '?') + Date.now();
      this.group.appendChild(f);
      StreamBIM.connectToChild(f, this.methods()).then(() => {
        this.api = StreamBIM.API;
        this.log('widget connected');
        this._call('beforeInit');
        this._flush();
        this.trigger('cameraChanged', this.viewer.getCameraState());
      }).catch((e) => this.log('widget connection failed: ' + JSON.stringify(e)));
    } else {
      this.iframe.style.display = '';
    }
    this.open = true;
    this._flush();
  }

  closeWidget() {
    if (this.iframe) this.iframe.style.display = 'none';
    this.open = false;
  }

  setExpanded(on) {
    this.expanded = !!on;
    this.group.classList.toggle('slider-group--expanded', this.expanded);
    this.trigger(this.expanded ? 'didExpand' : 'didContract');
  }

  trigger(action, params) {
    if (this.open && this.api) this._call(action, params);
    else this.pending.push([action, params]);
  }

  _flush() {
    if (!this.open || !this.api) return;
    const p = this.pending; this.pending = [];
    for (const [a, x] of p) this._call(a, x);
  }

  _call(action, params) {
    const fn = this.api && this.api[action];
    if (typeof fn !== 'function') return;
    Promise.resolve(fn(params)).catch(() => {}); // widgets need not implement every event
  }

  // ---- the widget API (StreamBIM.API inside the widget) ------------------------
  methods() {
    const m = this.model, v = this.viewer, s = this.state;
    const guidCheck = (g) => { if (typeof g !== 'string' || g.length !== 22) throw { code: 'invalid', debug: 'guid must be a valid 22 characters GUID string' }; };
    const info = (guid) => {
      const e = m.byGuid.get(guid);
      const a = m.assemblies.get(guid);
      if (!e && !a) throw { code: 'notFound' };
      const props = e
        ? { Name: [e.name], 'IFC Type': [e.kind], ObjectType: [e.type], Tag: [e.tag], Floor: [e.storey], Layer: [e.layer], Material: [e.material || ''], GUID: [e.guid], 'Assembly Global Id': [e.assembly || ''] }
        : { Name: [a.name], 'IFC Type': ['IfcElementAssembly'], GUID: [a.guid], Parts: [String(a.parts.length)] };
      return { guid, properties: props };
    };
    return {
      getProjectId: () => 'mock-project',
      getBuildingId: () => '1000',
      getUserEmail: () => 'mock@streambim.local',
      getCameraState: () => v.getCameraState(),
      setCameraState: (st) => {
        if (!st || st.position?.length !== 3) throw { code: 'invalid', debug: 'state.position must be an array of 3 floats' };
        if (st.quaternion?.length !== 4) throw { code: 'invalid', debug: 'state.quaternion must be an array of 4 floats' };
        v.setCameraState(st); return true;
      },
      setCameraPosition: (p) => { v.setCameraState({ position: p, quaternion: v.camera.quaternion.toArray() }); return true; },
      getViewportState: () => s.viewportState(v.getCameraState()),
      setViewportState: (st) => {
        if (st.cameraState) v.setCameraState(st.cameraState);
        if (st.hiddenObjects) { s.hidden.clear(); st.hiddenObjects.forEach((g) => s.indicesFor(g).forEach((i) => s.hidden.add(i))); s.apply(); }
        if (st.hiddenLayers) s.setLayers(Object.fromEntries(Object.keys(s.layers).map((k) => [k, !st.hiddenLayers.includes(k)])));
        return true;
      },
      getFloors: () => (m.floors || []).map((f) => ({ id: f.id, name: f.name, height: f.elevation })),
      getSpaces: () => [],
      getObjectInfo: (g) => { guidCheck(g); return info(g); },
      gotoObject: (g) => { guidCheck(g); const ix = s.indicesFor(g); if (!ix.length) throw { code: 'notFound' }; const b = new THREE.Box3(); ix.forEach((i) => b.union(elementBox(m, m.elements[i]))); v.lookAtBox(b); return true; },
      gotoFloor: () => true,
      gotoSpace: () => true,
      goHome: () => { this.onHome && this.onHome(); return true; },
      highlightObject: (g) => { guidCheck(g); s.select(g); return true; },
      deHighlightObject: () => { s.clearSelection(); return true; },
      deHighlightAllObjects: () => { s.clearSelection(); return true; },
      hideObject: (g) => { guidCheck(g); return s.hide(g); },
      showObject: (g) => { guidCheck(g); return s.show(g); },
      showAllObjects: () => { s.showAll(); return true; },
      highlightSystem: () => true,
      getLayers: () => ({ ...s.layers }),
      setLayers: (map) => { s.setLayers(map); return true; },
      showGrids: () => true,
      hideGrids: () => true,
      findObjects: (q) => s.applySearch([[{ propKey: q.key, propValue: q.value }]], s.search?.mode || 'ORIGINAL').slice(0, q.limit || 1000),
      applyObjectSearch: (q) => s.applySearch(q.rules || q.filter?.rules || [[{ propKey: q.key, propValue: q.value }]], s.searchMode || 'FADED'),
      getObjectInfoForSearch: (q) => s.applySearch(q.filter?.rules || [[{ propKey: q.filter?.key, propValue: q.filter?.value }]], s.searchMode || 'FADED').map(info),
      resetObjectSearch: () => { s.resetSearch(); return true; },
      setSearchVisualizationMode: (mode) => { s.setSearchMode(mode); return true; },
      zoomToSearchResult: () => { if (!s.search?.hits.size) return false; const b = new THREE.Box3(); s.search.hits.forEach((i) => b.union(elementBox(m, m.elements[i]))); v.lookAtBox(b); return true; },
      colorCodeObjects: (map) => { s.colorCode(map); return true; },
      quickSearch: (text) => ({ object: s.applySearch([[{ propKey: 'Name', propValue: text, operator: '~' }]], 'ORIGINAL').slice(0, 100) }),
      takeScreenshot: () => v.screenshot(),
      setStyles: (css) => {
        // StreamBIM: a <link rel=stylesheet href="data:text/css;base64,..."> appended to <head>
        const l = document.createElement('link');
        l.href = 'data:text/css;base64,' + btoa(css); l.type = 'text/css'; l.rel = 'stylesheet';
        document.getElementsByTagName('head')[0].appendChild(l);
        this.styleLinks.push(l);
        this.log(`widget -> setStyles (${css.length} chars)`);
        return true;
      },
      setSkyColor: (c) => { v.setSkyColor(c); return true; },
      setNavigationMode: (mode) => { v.navigationMode = mode ? 1 : 0; return true; },
      setExpanded: (on) => { this.setExpanded(on); return true; },
      setShowExpandButton: (on) => { this.onExpandButton && this.onExpandButton(on); return true; },
      makeApiRequest: ({ url, method = 'GET' }) => { this.log(`widget -> makeApiRequest ${method} ${url}`); throw { code: 'notFound', detail: 'mock has no REST API' }; },
      openUrl: () => true,
    };
  }
}
