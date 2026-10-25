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
async function loadPage(page, query = '', settle) {
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
    await sleep(400); // let any remaining async controller work finish
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

  // The output panel shows the native ZPL commands and the hex dump.
  const outCmd = doc.getElementById('out-cmd').textContent;
  assert.ok(outCmd.startsWith('^XA'), 'native output starts with ^XA');
  assert.ok(outCmd.includes('^GFA,'), 'the image element is emitted as a graphic field');
  assert.ok(outCmd.includes('^BQN'), 'the QR element is emitted');
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
  assert.ok(doc.getElementById('out-cmd').textContent.startsWith('SIZE 50 mm,30 mm'), 'TSPL output');
  lang.value = 'escpos';
  lang.dispatchEvent(new doc.defaultView.Event('change'));
  assert.match(doc.getElementById('out-cmd').textContent, /binary output - see the hex tab/, 'ESC/POS is binary');

  // Grid toggle and zoom keep the SVG valid.
  const grid = doc.getElementById('grid-toggle');
  grid.checked = true;
  grid.dispatchEvent(new doc.defaultView.Event('change'));
  assert.ok(doc.getElementById('preview').innerHTML.includes('stroke="#e2e8f0"'), 'grid overlay');
  doc.getElementById('btn-zoom-in').dispatchEvent(new doc.defaultView.Event('click'));
  assert.equal(doc.getElementById('zoom-label').textContent, '125%');
  assert.ok(doc.querySelector('#preview svg'), 'the preview survives the zoom');
});

