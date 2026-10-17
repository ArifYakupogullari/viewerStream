// Overlay mode: the widget becomes a transparent, click-through layer over StreamBIM's
// own 3D view, so StreamBIM keeps rendering (and filtering, colouring, highlighting) the
// BIM and the splat sits on top. Done with StreamBIM.API.setStyles(), which appends a
// stylesheet to StreamBIM's page; tested live on app.streambim.com (2026-10-15).
//
// StreamBIM puts the widget in <iframe id="iframe-widget"> inside #slider-group--left.
// That panel group is translated by CSS state (closed -308px, --active 0, --hidden -352px,
// --filtermenuOpen +242px), so the iframe is offset by the opposite amount to stay
// full-screen; with a panel open the iframe is clipped behind it. The group is dropped
// to z-index 0 so StreamBIM's controls (minimap, toolbars, tabs) stay above the layer.
// `display` is left alone: StreamBIM hides a closed widget with display:none, which is
// the natural off switch. Selectors depend on StreamBIM's DOM - re-check after updates.

const OVERLAY_CSS = [
  '#slider-group--left{z-index:0!important}',
  '#iframe-widget{position:absolute!important;top:0!important;left:100%!important;width:100vw!important;height:100vh!important;' +
    'margin:0!important;border:0!important;pointer-events:none!important;background:transparent!important;z-index:0!important;' +
    'transition:left .3s ease-out,clip-path .3s ease-out!important;clip-path:inset(0 0 0 0)}',
  '#slider-group--left.slider-group--active #iframe-widget{left:0!important;clip-path:inset(0 0 0 308px)!important}',
  '#slider-group--left.slider-group--hidden #iframe-widget{left:calc(100% + 44px)!important}',
  '#slider-group--left.slider-group--filtermenuOpen #iframe-widget{left:-242px!important}',
  '#slider-group--left.slider-group--expanded #iframe-widget{left:0!important;clip-path:none!important}',
].join('');

// setStyles can only add stylesheets, so leaving overlay mode adds one that restores
// StreamBIM's own values (panel group z 1, active z 4; iframe as StreamBIM creates it).
const PANEL_CSS = [
  '#slider-group--left{z-index:1!important}',
  '#slider-group--left.slider-group--active{z-index:4!important}',
  '#iframe-widget{position:absolute!important;top:0!important;left:0!important;width:100%!important;height:calc(100% - 66px)!important;' +
    'margin:66px 0 0 0!important;pointer-events:auto!important;clip-path:none!important;transition:none!important}',
  '#slider-group--left.slider-group--active #iframe-widget,#slider-group--left.slider-group--hidden #iframe-widget,' +
    '#slider-group--left.slider-group--filtermenuOpen #iframe-widget,#slider-group--left.slider-group--expanded #iframe-widget' +
    '{left:0!important;clip-path:none!important}',
].join('');

export function createOverlayMode({ api, onChange = () => {} }) {
  let on = false;
  const set = async (want) => {
    if (want === on) return on;
    const parentApi = api();
    if (!parentApi) throw new Error('Overlay needs StreamBIM (no parent connection)');
    await parentApi.setStyles(want ? OVERLAY_CSS : PANEL_CSS);
    on = want;
    document.documentElement.classList.toggle('vs-overlay', on);
    onChange(on);
    return on;
  };
  return {
    get active() { return on; },
    enter: () => set(true),
    exit: () => set(false),
    toggle: () => set(!on),
  };
}
