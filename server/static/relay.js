// Relay popup. The widget runs in a cross-origin iframe inside StreamBIM,
// where the browser won't attach the Vera portal login cookie, so it can't
// open /ws itself. This page is a top-level window on the portal origin
// (login works normally here); it holds the WebSocket and forwards:
//   widget -> relay   {type:'vs-hello'} until acknowledged, then {type:'vs-camera', msg}
//   relay  -> widget  {type:'vs-ready', info} | {type:'vs-frame', buf} |
//                     {type:'vs-error', message} | {type:'vs-closed', code, reason}
// Only messages from window.opener on an allowed widget origin are accepted,
// and everything is posted back to that exact origin.
const config = JSON.parse(document.getElementById('vs-config').textContent);
const statusEl = document.getElementById('relay-status');
const statsEl = document.getElementById('relay-stats');

const secret =
  new URLSearchParams(location.search).get('s') || new URLSearchParams(location.hash.slice(1)).get('s');

let widget = null; // { source, origin }
let ws = null;
let info = null;
let frames = 0;
let bytes = 0;

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function post(msg, transfer = []) {
  if (widget) widget.source.postMessage(msg, widget.origin, transfer);
}

function connect() {
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.hash = '';
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', secret }));
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      frames += 1;
      bytes += e.data.byteLength;
      post({ type: 'vs-frame', buf: e.data }, [e.data]);
      return;
    }
    const msg = JSON.parse(e.data);
    if (msg.type === 'info') {
      info = msg;
      setStatus(`Streaming to ${widget.origin}`);
      post({ type: 'vs-ready', info });
    } else if (msg.type === 'error') {
      setStatus(msg.message, true);
      post({ type: 'vs-error', message: msg.message });
    }
  };
  ws.onclose = (e) => {
    const reason = e.code === 4401 ? 'bad or missing session secret' : e.reason || 'renderer closed';
    setStatus(`Disconnected (${e.code}): ${reason}`, true);
    post({ type: 'vs-closed', code: e.code, reason });
    ws = null;
    info = null;
  };
}

window.addEventListener('message', (ev) => {
  if (!config.widgetOrigins.includes(ev.origin) || ev.source !== window.opener) return;
  const msg = ev.data || {};
  if (msg.type === 'vs-hello') {
    widget = { source: ev.source, origin: ev.origin };
    if (!secret) {
      post({ type: 'vs-error', message: 'relay link has no session secret' });
      return;
    }
    if (info) post({ type: 'vs-ready', info });
    else if (!ws) {
      setStatus('Connecting to renderer…');
      connect();
    }
  } else if (msg.type === 'vs-camera' && widget && ev.origin === widget.origin) {
    if (ws && ws.readyState === WebSocket.OPEN && typeof msg.msg === 'string') ws.send(msg.msg);
  }
});

if (!secret) {
  setStatus('This relay link has no session secret (?s=…). Reconnect from the widget.', true);
} else if (!window.opener) {
  setStatus(
    'No widget window attached. Open this page with the widget’s Connect button, not directly.',
    true,
  );
}

setInterval(() => {
  if (frames) statsEl.textContent = `${frames} frames · ${(bytes / 1e6).toFixed(1)} MB relayed`;
}, 1000);
