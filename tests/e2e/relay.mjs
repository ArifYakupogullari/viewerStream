// End-to-end test of the widget inside the fake StreamBIM host:
//   1. document mode: project id from StreamBIM, .ply listed via
//      makeApiRequest, relative token download link resolved and loaded
//   2. remote mode: relay popup <-> fake renderer, camera sync, failure paths
//
// Needs (see .github/workflows/deploy.yml, or run locally):
//   python tests/make_test_ply.py public/test-scenes/test-scene.ply
//   VIEWERSTREAM_SECRET=devsecret123 python server/render_server.py --backend fake \
//       --host 127.0.0.1 --port 8765 --dev
//   npx vite --port 5173 --strictPort --host localhost
//   npm run test:e2e        (CHROMIUM_PATH=/path/to/chrome to use a local browser)
import { chromium } from 'playwright';

const HOST = process.env.HOST_URL || 'http://localhost:5173/host/index.html';
const SERVER = process.env.RENDERER_URL || 'http://127.0.0.1:8765';
const SECRET = process.env.VIEWERSTREAM_SECRET || 'devsecret123';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const health = async () => (await fetch(`${SERVER}/health`)).json();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

async function loadWidget() {
  await page.goto(HOST);
  await page.fill('#plyUrlInput', '');
  await page.click('#loadBtn');
  const widget = page.frameLocator('#widget-frame');
  await widget.locator('#remote-toggle').waitFor();
  return widget;
}

try {
  // --- 1. document mode -------------------------------------------------------
  let widget = await loadWidget();
  await widget.locator('#overlay.hidden').waitFor({ state: 'attached', timeout: 30000 });
  const options = await widget.locator('#model-select option').allTextContents();
  check('project .ply documents listed (non-ply filtered out)', options.join() === 'test-scene.ply', options.join());
  const events = await page.locator('#events').textContent();
  check('download link requested through makeApiRequest', /documents\/1\/downloadlink/.test(events));
  check('scene downloaded and loaded (overlay cleared)', await widget.locator('#overlay.hidden').count() === 1);
  check('no page errors in document mode', pageErrors.length === 0, pageErrors.join(' | '));

  // --- 2. remote mode -----------------------------------------------------------
  await widget.locator('#remote-toggle').click();
  await widget.locator('#remote-link').fill(`${SERVER}/?s=${SECRET}`);
  const [popup] = await Promise.all([page.waitForEvent('popup'), widget.locator('#remote-connect').click()]);
  await popup.waitForLoadState();
  check('popup opened on relay URL', popup.url().startsWith(`${SERVER}/relay?s=`), popup.url());

  await widget.locator('#remote-status', { hasText: 'Connected' }).waitFor({ timeout: 10000 });
  check('widget reports Connected', true, await widget.locator('#remote-status').textContent());
  await page.waitForTimeout(1500);
  const px = await widget.locator('canvas.remote-canvas').evaluate((c) => {
    const d = c.getContext('2d').getImageData((c.width / 2) | 0, (c.height * 0.85) | 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  check('frame drawn into widget canvas', px.some((v) => v > 0), `pixel ${px}`);

  const before = (await health()).frames;
  await page.fill('#posX', '4');
  await page.fill('#posZ', '2');
  await page.click('#sendBtn');
  await page.waitForTimeout(1500);
  const after = (await health()).frames;
  check('camera change from StreamBIM host triggers a new render', after > before, `frames ${before} -> ${after}`);

  const idle0 = (await health()).frames;
  await page.waitForTimeout(1500);
  check('no renders while the camera is still', (await health()).frames === idle0);

  await page.check('#orbitToggle');
  const o0 = (await health()).frames;
  await page.waitForTimeout(3000);
  const o1 = (await health()).frames;
  await page.uncheck('#orbitToggle');
  check('orbit animation streams frames', o1 - o0 >= 5, `${o1 - o0} frames in 3 s`);
  check('debug fps/latency readout shown in dev harness', /fps/.test(await widget.locator('#remote-stats').textContent()));

  await popup.close();
  await widget.locator('#remote-status', { hasText: 'closed' }).waitFor({ timeout: 5000 });
  check('closing the relay popup is detected', true);
  check('Connect button back after close', await widget.locator('#remote-connect').isVisible());
  await page.waitForTimeout(500);
  check('server sees the client leave', (await health()).clients === 0);
  await widget.locator('#overlay.hidden').waitFor({ state: 'attached', timeout: 30000 });
  check('falls back to the StreamBIM document after the stream ends', true);

  widget = await loadWidget();
  await widget.locator('#remote-toggle').click();
  await widget.locator('#remote-link').fill(`${SERVER}/?s=wrong-secret`);
  const [popup2] = await Promise.all([page.waitForEvent('popup'), widget.locator('#remote-connect').click()]);
  await widget.locator('#remote-status', { hasText: 'secret' }).waitFor({ timeout: 10000 });
  check('bad secret rejected and reported in widget', true);
  await page.waitForTimeout(500);
  check('rejected relay popup closed by widget', popup2.isClosed());

  await widget.locator('#remote-link').fill('https://vera.c3se.chalmers.se/node/x/1234/');
  await widget.locator('#remote-connect').click();
  check('link without ?s= rejected up front', /secret/.test(await widget.locator('#remote-status').textContent()));

  const stranger = await browser.newPage();
  await stranger.goto(`${SERVER}/relay?s=${SECRET}`);
  check('relay opened without a widget opener refuses to work',
    /No widget window/.test(await stranger.locator('#relay-status').textContent()));
} catch (err) {
  check('test run completed', false, err.message);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
