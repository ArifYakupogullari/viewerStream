// Debug output for the widget. On in the dev server and the dev channel
// (/viewerStream/dev/); in production only with ?debug=1 in the widget URL,
// so StreamBIM's console stays quiet but the live widget can still be
// inspected in place.
export const DEBUG =
  import.meta.env.MODE !== 'production' || new URLSearchParams(window.location.search).has('debug');

export function debugLog(...args) {
  if (DEBUG) console.debug(...args);
}
