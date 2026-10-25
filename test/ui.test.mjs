/**
 * UI smoke tests: the real pages are loaded with jsdom, `fetch` is stubbed to
 * serve data/*.json from disk and the real page controller modules are imported
 * from disk. Each page must render its key nodes (board cards, wiring diagram,
 * maintenance action cards, designer preview).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONTROLLERS = {
  'index.html': 'home.js',
  'install.html': 'install.js',
  'designer.html': 'designer.js',
  'troubleshoot.html': 'troubleshoot.js',
  'docs.html': 'docs.js'
};

/** Poll a predicate until it is truthy (or the timeout expires). */
async function waitFor(predicate, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    let value = false;
    try {
      value = predicate();
    } catch (e) {
      value = false;
    }
    if (value) return true;
    if (Date.now() - started > timeout) return false;
    await sleep(20);
  }
}

/**
 * Boot one real page: parse the HTML with jsdom, publish the DOM globals the
 * controllers expect, stub fetch with the on-disk catalogs and import the page
 * controller module (with a cache-busting query so every page runs fresh).
 */
async function loadPage(page, query = '', settle, quietMs = 400) {
  const html = readFileSync(`${ROOT}/${page}`, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `http://localhost/${page}${query}` });
  const { window } = dom;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  for (const key of ['window', 'document', 'localStorage', 'Image', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'DOMParser', 'XMLSerializer', 'NodeFilter', 'history']) {
    globalThis[key] = window[key];
  }
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\//, '');
    return {
      ok: true,
      status: 200,
      async json() {
        return JSON.parse(readFileSync(`${ROOT}/${path}`, 'utf8'));
      }
    };
  };
  // jsdom does not implement scrolling or layout.
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  const file = `${ROOT}/assets/js/ui/${CONTROLLERS[page]}`;
  await import(`${pathToFileURL(file).href}?ui-test=${Date.now()}-${Math.random()}`);
  if (settle) {
    const ready = await waitFor(() => settle(window.document));
    assert.ok(ready, `${page}: the page did not finish rendering within the timeout`);
    await sleep(quietMs); // let any remaining async controller work finish
  }
  return { dom, window, doc: window.document };
}

const count = (doc, selector) => doc.querySelectorAll(selector).length;

test('index.html renders the catalog statistics, app cards and board table', async () => {
  const { doc } = await loadPage('index.html', '', (d) => count(d, '#board-table tbody tr') > 0);
  assert.equal(doc.getElementById('stat-boards').textContent, '15');
  assert.equal(doc.getElementById('stat-apps').textContent, '7');
  assert.equal(doc.getElementById('stat-langs').textContent, '10');
  assert.equal(doc.getElementById('stat-symbologies').textContent, '11');

  assert.equal(count(doc, '#app-cards .card'), 7, 'one card per firmware variant');
  assert.equal(count(doc, '#board-table tbody tr'), 15, 'one row per board');
  assert.equal(count(doc, '#board-table thead th'), 6, 'board table columns');
  assert.equal(count(doc, '#board-family option'), 4, 'family filter options');
  assert.match(doc.getElementById('board-table').textContent, /ESP32 DevKit V1/);
  assert.match(doc.getElementById('board-table').textContent, /Raspberry Pi 4 Model B/);
  assert.match(doc.getElementById('app-cards').textContent, /Wi-Fi Print Server/);

  // The shell renders the header and footer around the page.
  assert.ok(doc.querySelector('header.site-header'), 'site header');
  assert.ok(doc.querySelector('footer.footer'), 'site footer');
  assert.equal(count(doc, 'header.site-header nav.main a'), 5, 'navigation links');
  assert.match(doc.querySelector('h1').textContent, /Make any printer wireless/);

  // The family filter narrows the table down.
  const select = doc.getElementById('board-family');
  select.value = 'rpi';
  select.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(count(doc, '#board-table tbody tr'), 4, 'only Raspberry Pi boards remain');
  select.value = 'all';
  select.dispatchEvent(new doc.defaultView.Event('change'));

  const filter = doc.getElementById('board-filter');
  filter.value = 'nodemcu';
  filter.dispatchEvent(new doc.defaultView.Event('input'));
  assert.equal(count(doc, '#board-table tbody tr'), 1, 'the search box filters the table');
  assert.match(doc.getElementById('board-table').textContent, /NodeMCU/);
});

test('install.html renders the wizard, the wiring diagram and the flash panel', async () => {
  const { doc } = await loadPage('install.html', '?app=print-server-wifi&board=esp32-devkit-v1', (d) => !!d.querySelector('#wiring-diagram svg'));
  assert.equal(count(doc, '#app-list .card'), 7, 'application cards');
  assert.equal(count(doc, '#transport-list .card'), 3, 'transport cards for the Wi-Fi bridge');
  assert.equal(count(doc, '#board-list .card'), 15, 'board cards');

  // Breadcrumbs reflect the deep link.
  assert.match(doc.getElementById('crumb-app').textContent, /Wi-Fi Print Server/);
  assert.match(doc.getElementById('crumb-transport').textContent, /UART \/ COM port/);
  assert.match(doc.getElementById('crumb-board').textContent, /ESP32 DevKit V1/);

  // The wiring section is visible and contains a real SVG diagram.
  assert.equal(doc.getElementById('section-wiring').hidden, false);
  const svgHost = doc.getElementById('wiring-diagram');
  const svg = svgHost.querySelector('svg');
  assert.ok(svg, 'wiring diagram svg');
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 960 420');
  assert.ok(!svgHost.innerHTML.includes('NaN'), 'no NaN in the diagram');
  const diagramText = svg.textContent;
  assert.match(diagramText, /TX: GPIO 17 \(TX2\) -> Printer RX/, 'the TX wire label is drawn');
  assert.match(diagramText, /GND: GND -> Printer GND/, 'the GND wire label is drawn');
  assert.match(diagramText, /TTL serial wiring/, 'the recipe title is drawn');
  assert.match(doc.getElementById('wiring-title').textContent, /TTL serial wiring/);
  assert.match(doc.getElementById('wiring-summary').textContent, /Cross TX and RX/, 'recipe summary');

  // The remaining wiring tabs are populated.
  assert.ok(count(doc, '#wiring-table tr') >= 4, 'connection table rows');
  assert.ok(count(doc, '#wiring-bom tr') >= 3, 'bill of materials');
  assert.ok(count(doc, '#wiring-steps li') >= 5, 'step by step list');
  assert.ok(doc.getElementById('wiring-requirements').textContent.length > 10, 'requirements panel');
  assert.ok(doc.getElementById('wiring-warnings').textContent.length > 10, 'warnings panel');

  // Flash + configure panels are shown for a compatible combination.
  assert.equal(doc.getElementById('section-flash').hidden, false);
  assert.ok(doc.getElementById('flash-panel').textContent.length > 20, 'flash instructions');
  assert.ok(count(doc, '#flash-panel details') >= 1, 'manual build instructions');
  assert.match(doc.getElementById('flash-panel').textContent, /esp32:esp32:esp32/, 'the FQBN is offered');
  assert.ok(doc.getElementById('configure-panel').textContent.length > 10, 'configure panel');
});

test('install.html filters incompatible boards and explains why they are greyed out', async () => {
  // The USB-host build cannot run on a plain ESP32 or an ESP8266.
  const { doc } = await loadPage('install.html', '?app=print-server-usbhost', (d) => d.querySelectorAll('#transport-list .card').length > 0);
  assert.equal(count(doc, '#app-list .card'), 7);
  assert.equal(count(doc, '#transport-list .card'), 1, 'the USB-host build only offers the USB transport');
  assert.equal(doc.getElementById('section-board').hidden, true, 'the board step waits for a transport choice');
  assert.equal(count(doc, '#board-list .card'), 0);

  // Picking the transport reveals the board list (only compatible boards by default).
  doc.querySelector('#transport-list .card').dispatchEvent(new doc.defaultView.Event('click'));
  assert.equal(doc.getElementById('section-board').hidden, false, 'the board step is revealed');
  const listed = count(doc, '#board-list .card');
  assert.ok(listed > 0 && listed < 15, `only compatible boards are listed by default (got ${listed})`);
  assert.equal(count(doc, '#board-list .card.disabled'), 0, 'incompatible boards are hidden by default');
  assert.ok(!doc.getElementById('board-list').textContent.includes('Incompatible'));
  assert.match(doc.getElementById('crumb-transport').textContent, /USB host/);

  // With the filter off, an incompatible board can still be inspected.
  const toggle = doc.getElementById('only-compatible');
  toggle.checked = false;
  toggle.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(count(doc, '#board-list .card'), 15, 'every board is listed');
  assert.ok(count(doc, '#board-list .card.disabled') > 0, 'incompatible boards are greyed out');
  const text = doc.getElementById('board-list').textContent;
  assert.match(text, /Incompatible/);
  assert.match(text, /Why is this board greyed out\?/);
  assert.match(text, /no USB host radio/);
  assert.match(text, /needs board family: esp32 \/ rpi/);

  // Choosing an incompatible board still renders the wiring step and warns.
  const incompatible = [...doc.querySelectorAll('#board-list .card.disabled')].find((c) => c.textContent.includes('ESP32 DevKit V1'));
  assert.ok(incompatible, 'the plain ESP32 is listed as incompatible');
  incompatible.dispatchEvent(new doc.defaultView.Event('click'));
  assert.equal(doc.getElementById('section-wiring').hidden, false, 'the wiring step is still reachable');
  assert.equal(doc.getElementById('crumb-board').textContent, 'ESP32 DevKit V1 (WROOM-32)');
  assert.ok(doc.querySelector('#wiring-diagram svg'), 'a diagram is drawn for the incompatible pair too');
});


test('designer.html renders the preview SVG, the element list and the output panels', async () => {
  const { doc } = await loadPage('designer.html', '', (d) => !!d.querySelector('#preview svg'));
  assert.equal(count(doc, '#preset option'), 10, 'size presets');
  assert.equal(count(doc, '#language option'), 10, 'printer languages');
  assert.equal(count(doc, '#mode option'), 2, 'native + raster output modes');

  // The seeded sample document is rendered as a real SVG preview.
  const svg = doc.querySelector('#preview svg');
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 400 240', '50 x 30 mm at 203 dpi');
  const previewText = svg.textContent;
  assert.ok(previewText.includes('Arsin Print Server'), 'the {{product}} variable is substituted');
  assert.ok(previewText.includes('S/N 00042'), 'the {{serial}} variable is substituted');
  assert.ok(!doc.getElementById('preview').innerHTML.includes('NaN'), 'no NaN in the preview');

  // Element list, layer count and property panels.
  assert.equal(count(doc, '#el-list .el-item'), 5, 'seeded elements');
  assert.equal(doc.getElementById('el-count').textContent, '5');
  assert.ok(count(doc, '#doc-props .field') >= 8, 'document property fields');
  assert.ok(count(doc, '#var-list input') >= 2, 'variable fields');
  assert.match(doc.getElementById('size-label').textContent, /50 x 30 mm @ 203 dpi \(400 x 240 dots\)/);
  assert.equal(doc.getElementById('zoom-label').textContent, '100%');

  // Selecting an element renders its property editor.
  doc.querySelector('#el-list .el-item').dispatchEvent(new doc.defaultView.Event('click'));
  assert.ok(count(doc, '#props .field') >= 4, 'element property fields');

  // The output panel shows the native ZPL commands and the hex dump. The
  // designer renders the output asynchronously (it prepares image bitmaps
  // first), so wait for it instead of reading synchronously.
  const outReady = await waitFor(() => doc.getElementById('out-cmd').textContent.startsWith('^XA'));
  assert.ok(outReady, 'the native output panel is populated');
  const outCmd = doc.getElementById('out-cmd').textContent;
  assert.ok(outCmd.includes('^BCN,'), 'the barcode element is emitted');
  assert.ok(outCmd.includes('^BQN'), 'the QR element is emitted');
  assert.ok(outCmd.includes('^GB'), 'the box element is emitted');
  assert.match(doc.getElementById('out-hex').textContent, /^(?:[0-9A-F]{2} )+/, 'hex dump');
  assert.match(doc.getElementById('out-json').textContent, /"elements"/, 'JSON view');
  assert.equal(doc.getElementById('warn-host').textContent.trim(), '', 'no warnings for a valid ZPL document');

  // Adding an element updates the preview and the layer list.
  const before = doc.getElementById('preview').innerHTML;
  doc.querySelector('[data-add="qrcode"]').dispatchEvent(new doc.defaultView.Event('click'));
  assert.equal(count(doc, '#el-list .el-item'), 6, 'the new element is listed');
  assert.notEqual(doc.getElementById('preview').innerHTML, before, 'the preview is re-rendered');

  // Switching the language re-renders the output for that printer.
  const lang = doc.getElementById('language');
  lang.value = 'tspl';
  lang.dispatchEvent(new doc.defaultView.Event('change'));
  assert.ok(await waitFor(() => doc.getElementById('out-cmd').textContent.startsWith('SIZE 50 mm,30 mm')), 'TSPL output');
  lang.value = 'escpos';
  lang.dispatchEvent(new doc.defaultView.Event('change'));
  // ESC/POS is a binary language: the text view is a printable preview and the
  // hex panel must show the ESC @ initialise sequence.
  assert.ok(await waitFor(() => doc.getElementById('out-hex').textContent.startsWith('1B 40')), 'ESC/POS hex output');
  assert.ok(!doc.getElementById('out-cmd').textContent.startsWith('^XA'), 'the ZPL output was replaced');
  lang.value = 'zpl';
  lang.dispatchEvent(new doc.defaultView.Event('change'));

  // Grid toggle and zoom keep the SVG valid.
  const grid = doc.getElementById('grid-toggle');
  grid.checked = true;
  grid.dispatchEvent(new doc.defaultView.Event('change'));
  assert.ok(doc.getElementById('preview').innerHTML.includes('stroke="#e2e8f0"'), 'grid overlay');
  doc.getElementById('btn-zoom-in').dispatchEvent(new doc.defaultView.Event('click'));
  assert.equal(doc.getElementById('zoom-label').textContent, '125%');
  assert.ok(doc.querySelector('#preview svg'), 'the preview survives the zoom');
});


test('troubleshoot.html renders the dashboard, the maintenance grid and the console', async () => {
  // The page starts a 5 second auto-refresh interval; keep the test process from
  // staying alive because of it.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  let doc;
  try {
    ({ doc } = await loadPage('troubleshoot.html', '', (d) => d.querySelectorAll('#dash-status dt').length > 0 && d.querySelectorAll('#cfg-form .field').length > 0, 1500));
  } finally {
    globalThis.setInterval = realSetInterval;
  }

  // The demo device renders a full dashboard.
  assert.ok(count(doc, '#dash-status dt') >= 10, 'status rows');
  assert.equal(count(doc, '#dash-counters dd'), 3, 'counter rows');
  assert.ok(count(doc, '#dash-wifi dd') >= 4, 'wifi rows');
  assert.ok(count(doc, '#dash-io dd') >= 4, 'bluetooth/usb rows');
  assert.match(doc.getElementById('dash-status').textContent, /Demo|demo|arsin_print_server/);
  assert.match(doc.getElementById('dev-state').textContent, /Demo mode/, 'demo badge');
  assert.match(doc.getElementById('dev-last').textContent, /^updated /, 'last refresh timestamp');

  // One language option per printer language and one card per action.
  assert.equal(count(doc, '#maint-lang option'), 10);
  assert.equal(count(doc, '#maint-grid .card'), 19, 'maintenance action cards');
  assert.match(doc.getElementById('maint-count').textContent, /19 of 19 actions supported by ESC\/POS/);

  // Switching the language re-renders the grid with the right support count.
  const lang = doc.getElementById('maint-lang');
  lang.value = 'ipl';
  lang.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(count(doc, '#maint-grid .card'), 19, 'every action stays listed');
  assert.match(doc.getElementById('maint-count').textContent, /6 of 19 actions supported by IPL/);
  assert.ok(count(doc, '#maint-grid .card.disabled') > 0, 'unsupported actions are greyed out');

  // The Preview button renders the generated command for the selected action.
  const firstCard = doc.querySelector('#maint-grid .card:not(.disabled)');
  const buttons = [...firstCard.querySelectorAll('button')];
  const preview = buttons.find((b) => b.textContent === 'Preview');
  assert.ok(preview, 'the action card has a Preview button');
  preview.dispatchEvent(new doc.defaultView.Event('click'));
  const previewText = doc.getElementById('maint-preview').textContent;
  assert.match(previewText, /^Action : /);
  assert.match(previewText, /Hex {4}: [0-9A-F]{2}/);
  assert.match(previewText, /Note {3}: /);
  assert.match(firstCard.textContent, /Self test page/);

  // The raw console is wired to the parser: the hex quick-fill buttons work.
  const quick = doc.querySelector('[data-quick="1D 56 00"]');
  assert.ok(quick, 'quick command buttons');
  quick.dispatchEvent(new doc.defaultView.Event('click'));
  assert.equal(doc.getElementById('console-input').value, '1D 56 00');
  assert.equal(doc.getElementById('console-mode').value, 'hex');
  doc.getElementById('console-send').dispatchEvent(new doc.defaultView.Event('click'));
  assert.match(doc.getElementById('console-out').textContent, /1D 56 00/, 'the echo line shows the sent bytes');
  // The send handler awaits the device reply, so let it settle before the test
  // ends (otherwise it would write into the next page's document).
  await sleep(400);
  assert.match(doc.getElementById('console-out').textContent, /<< sent 3 bytes/, 'the device reply is logged');

  // Configuration form + firmware/backup panel.
  assert.ok(count(doc, '#cfg-form .field') >= 20, 'configuration fields');
  assert.match(doc.getElementById('cfg-raw').textContent, /"printer"/, 'raw JSON view');
  assert.ok(doc.getElementById('backup-download') && doc.getElementById('ota-file'), 'firmware & backup controls');
  assert.match(doc.getElementById('diag-out').textContent, /Connect to a device/, 'diagnostics placeholder');
});

test('docs.html renders the wiring library, the language reference and the FAQ', async () => {
  const { doc } = await loadPage('docs.html', '', (d) => d.querySelectorAll('#wiring-doc .card').length > 0);
  assert.equal(count(doc, '#wiring-app option'), 7, 'one option per firmware variant');
  assert.equal(count(doc, '#wiring-board option'), 15, 'one option per board');
  assert.equal(count(doc, '#wiring-doc .card'), 3, 'one card per transport of the Wi-Fi bridge');
  assert.ok(doc.querySelector('#wiring-doc svg'), 'the wiring library embeds a diagram');
  assert.match(doc.getElementById('wiring-doc').textContent, /TTL serial wiring/);

  assert.ok(doc.getElementById('languages-doc').children.length >= 5, 'printer language reference');
  assert.match(doc.getElementById('languages-doc').textContent, /ESC\/POS/);
  assert.match(doc.getElementById('languages-doc').textContent, /ZPL II/);
  assert.ok(doc.getElementById('api-doc').children.length >= 3, 'REST API reference');
  assert.match(doc.getElementById('api-doc').textContent, /\/api\/print/);
  assert.ok(doc.getElementById('boards-doc').children.length >= 4, 'add-a-board documentation');
  assert.ok(doc.getElementById('build-doc').children.length >= 2, 'build documentation');
  assert.match(doc.getElementById('build-doc').textContent, /npm run build/);
  assert.equal(count(doc, '#faq-doc details'), 12, 'troubleshooting FAQ entries');
  assert.match(doc.getElementById('faq-doc').textContent, /board is not detected/i);

  // Changing the app selection refills the board list and the recipes.
  const appSelect = doc.getElementById('wiring-app');
  appSelect.value = 'print-server-cups';
  appSelect.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(count(doc, '#wiring-board option'), 15, 'every board stays selectable');
  assert.ok(count(doc, '#wiring-board option') > 0);
  assert.match(doc.getElementById('wiring-board').textContent, /\(partial\)/, 'incompatible boards are marked partial');
  assert.equal(count(doc, '#wiring-doc .card'), 3, 'one card per CUPS transport');
  assert.match(doc.getElementById('wiring-doc').textContent, /Raspberry Pi serial wiring|Network printer/);
});


/**
 * Boot install.html with a stubbed manifest index so both CI states can be
 * checked: the installer must only offer the browser flash button when the
 * compiled binaries are really reachable (the manifest files themselves are
 * committed, so their existence is not a signal).
 */
async function loadInstallWithBinaries(available) {
  const html = readFileSync(`${ROOT}/install.html`, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost/install.html?app=print-server-wifi&board=esp32-devkit-v1'
  });
  const { window } = dom;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  for (const key of ['window', 'document', 'localStorage', 'Image', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'DOMParser', 'XMLSerializer', 'NodeFilter', 'history']) {
    globalThis[key] = window[key];
  }
  globalThis.window = window;
  globalThis.location = window.location;
  const json = (value) => ({ ok: true, status: 200, async json() { return value; } });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\//, '');
    if (path.startsWith('manifests/index.json')) {
      const index = JSON.parse(readFileSync(`${ROOT}/manifests/index.json`, 'utf8'));
      index.builds = index.builds.map((b) => ({ ...b, available }));
      return json(index);
    }
    if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
      return { ok: available, status: available ? 200 : 404, async json() { return {}; } };
    }
    return json(JSON.parse(readFileSync(`${ROOT}/${path}`, 'utf8')));
  };
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const file = `${ROOT}/assets/js/ui/install.js`;
  await import(`${pathToFileURL(file).href}?binaries=${available}-${Date.now()}-${Math.random()}`);
  const ready = await waitFor(() => window.document.getElementById('flash-panel').textContent.trim().length > 20);
  assert.ok(ready, 'install.html: the flash panel did not render');
  await sleep(200);
  return window.document;
}

test('install.html asks for a build when the CI has not produced the binaries yet', async () => {
  const doc = await loadInstallWithBinaries(false);
  const panel = doc.getElementById('flash-panel');
  assert.match(panel.textContent, /build required/i, 'the badge says a build is needed');
  assert.equal(count(doc, '#flash-panel esp-web-install-button'), 0, 'no flash button without binaries');
  assert.ok(count(doc, '#flash-panel details') >= 1, 'manual build instructions are offered instead');
});

test('install.html offers the Web Serial button once the binaries exist', async () => {
  const doc = await loadInstallWithBinaries(true);
  const panel = doc.getElementById('flash-panel');
  assert.match(panel.textContent, /firmware ready/i, 'the badge says the firmware is ready');
  const button = doc.querySelector('#flash-panel esp-web-install-button');
  assert.ok(button, 'the esp-web-tools button is rendered');
  assert.equal(button.getAttribute('manifest'), 'manifests/print-server-wifi/esp32-devkit-v1.json');
});
