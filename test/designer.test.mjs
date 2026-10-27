/**
 * Label designer regression tests.
 *
 * The designer is a real application (canvas, layers, arrange tools, undo/redo,
 * snapping, output panels), so these tests drive the real page with jsdom and
 * the real controller module - exactly like test/ui.test.mjs does - and assert
 * the behaviour a user depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Boot designer.html with the real controller and the on-disk catalogs. */
async function loadDesigner() {
  const html = readFileSync(`${ROOT}/designer.html`, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/designer.html' });
  const { window } = dom;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  for (const key of ['window', 'document', 'localStorage', 'Image', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'DOMParser', 'XMLSerializer', 'NodeFilter', 'history']) {
    globalThis[key] = window[key];
  }
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\//, '');
    return { ok: true, status: 200, async json() { return JSON.parse(readFileSync(`${ROOT}/${path}`, 'utf8')); } };
  };
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const file = `${ROOT}/assets/js/ui/designer.js`;
  await import(`${pathToFileURL(file).href}?designer-test=${Date.now()}-${Math.random()}`);
  const ready = await waitFor(() => window.document.getElementById('out-cmd').textContent.startsWith('^XA'));
  assert.ok(ready, 'the designer did not finish rendering');
  await sleep(120);
  const doc = window.document;
  const click = (node) => node.dispatchEvent(new window.Event('click', { bubbles: true }));
  const xValue = () => Number(doc.querySelector('#props input[type=number]').value);
  return { dom, window, doc, click, xValue };
}

test('the palette exposes every element type and the quick presets', async () => {
  const { doc } = await loadDesigner();
  const adds = [...doc.querySelectorAll('#palette [data-add]')].map((b) => b.dataset.add);
  assert.deepEqual(adds.sort(), ['barcode', 'box', 'image', 'line', 'qrcode', 'text'], 'one button per element type');
  assert.ok(doc.querySelectorAll('#preset-list [data-preset]').length >= 6, 'quick presets are offered');
  assert.match(doc.getElementById('palette').textContent, /Text/);
  assert.match(doc.getElementById('palette').textContent, /QR code/);
});

test('the document panel exposes the full label and printer option set', async () => {
  const { doc } = await loadDesigner();
  const fields = [...doc.querySelectorAll('#doc-props .field label')].map((l) => l.textContent);
  for (const needed of ['Name', 'Width (mm)', 'Height (mm)', 'Gap (mm)', 'DPI', 'Copies', 'Media', 'Darkness', 'Speed (ips)', 'Rotation', 'Printer profile']) {
    assert.ok(fields.includes(needed), `the document panel exposes "${needed}"`);
  }
  assert.ok(doc.querySelectorAll('#doc-props .field').length >= 10, 'at least ten document fields');
});

test('the element panel exposes the full option set for every element type', async () => {
  const { doc, click } = await loadDesigner();
  const propsFor = (index) => {
    click(doc.querySelectorAll('#el-list .el-item')[index]);
    return [...doc.querySelectorAll('#props .field label')].map((l) => l.textContent);
  };
  // Layers are listed top-most first: box, qrcode, barcode, text, text.
  const box = propsFor(0);
  assert.ok(box.includes('Corner radius (mm)'), 'box exposes the corner radius');
  assert.ok(box.includes('Thickness (mm)'), 'box exposes the thickness');
  const qr = propsFor(1);
  assert.ok(qr.includes('Error correction'), 'QR exposes the error correction level');
  assert.ok(qr.includes('Size (mm)'), 'QR exposes the module size');
  const barcode = propsFor(2);
  assert.ok(barcode.includes('Symbology'), 'barcode exposes the symbology');
  assert.ok(barcode.includes('Narrow bar (mm)'), 'barcode exposes the narrow bar width');
  assert.ok(barcode.includes('Bar height (mm)'), 'barcode exposes the bar height');
  const text = propsFor(3);
  assert.ok(text.includes('Font size (mm)'), 'text exposes the font size');
  assert.ok(text.includes('Line spacing'), 'text exposes the line spacing');
  assert.ok(text.includes('Letter spacing'), 'text exposes the letter spacing');
  assert.ok(text.includes('Align'), 'text exposes the alignment');
});

test('arrange tools move the selected element inside the label', async () => {
  const { doc, click, xValue } = await loadDesigner();
  const selected = doc.querySelector('#el-list .el-item.selected');
  assert.ok(selected, 'the seeded document selects an element');
  const before = xValue();
  assert.ok(before > 0, 'the seeded text starts away from the left edge');

  click(doc.querySelector('#arrange [data-align="left"]'));
  assert.equal(xValue(), 0, 'align-left snaps the element to the left edge');

  click(doc.querySelector('#arrange [data-align="right"]'));
  assert.ok(xValue() > 0, 'align-right moves it back');

  click(doc.querySelector('#arrange [data-align="center-h"]'));
  const centred = xValue();
  click(doc.getElementById('btn-center'));
  assert.ok(centred >= 0 && xValue() >= 0, 'the centre button keeps the element inside the label');
});

test('undo and redo walk the edit history', async () => {
  const { doc, click } = await loadDesigner();
  assert.equal(doc.querySelectorAll('#el-list .el-item').length, 5, 'the seeded document has five elements');
  assert.equal(doc.getElementById('btn-undo').disabled, true, 'nothing to undo at first');

  click(doc.querySelector('#palette [data-add="qrcode"]'));
  assert.equal(doc.querySelectorAll('#el-list .el-item').length, 6, 'the element was added');
  assert.equal(doc.getElementById('btn-undo').disabled, false, 'undo is available');

  click(doc.getElementById('btn-undo'));
  assert.equal(doc.querySelectorAll('#el-list .el-item').length, 5, 'undo removed the element');
  assert.equal(doc.getElementById('btn-redo').disabled, false, 'redo is available');

  click(doc.getElementById('btn-redo'));
  assert.equal(doc.querySelectorAll('#el-list .el-item').length, 6, 'redo brought it back');
});

test('the canvas draws a selection overlay with resize handles and never leaks NaN', async () => {
  const { doc } = await loadDesigner();
  const preview = doc.getElementById('preview');
  assert.ok(!preview.innerHTML.includes('NaN'), 'no NaN in the preview');
  const overlay = preview.querySelector('svg.preview-overlay');
  assert.ok(overlay, 'the selection overlay is rendered');
  assert.equal(overlay.querySelectorAll('[data-handle]').length, 8, 'eight resize handles');
  assert.ok(overlay.querySelector('[data-handle="se"]'), 'the south-east handle exists');
  assert.ok(!overlay.innerHTML.includes('NaN'), 'no NaN in the overlay');
});


test('rulers, grid, snap and grid size are wired to the canvas', async () => {
  const { doc, window } = await loadDesigner();
  assert.ok(doc.querySelector('#ruler-h svg'), 'horizontal ruler');
  assert.ok(doc.querySelector('#ruler-v svg'), 'vertical ruler');
  const grid = doc.getElementById('grid-toggle');
  grid.checked = true;
  grid.dispatchEvent(new window.Event('change'));
  assert.ok(doc.getElementById('preview').innerHTML.includes('stroke="#e2e8f0"'), 'the grid overlay is drawn');
  assert.ok(doc.getElementById('snap-toggle'), 'snap toggle');
  const size = doc.getElementById('grid-size');
  size.value = '5';
  size.dispatchEvent(new window.Event('change'));
  assert.equal(size.value, '5', 'the grid size selector keeps the value');
});

test('arrow keys nudge the selected element by the grid step', async () => {
  const { doc, window, xValue } = await loadDesigner();
  const before = xValue();
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(xValue(), before + 1, 'the element moves by the 1 mm grid step');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
  assert.equal(xValue(), before - 4, 'shift moves by 5 mm');
});

test('layers can be reordered, duplicated and locked', async () => {
  const { doc, click } = await loadDesigner();
  const first = doc.querySelector('#el-list .el-item .type').textContent;
  assert.equal(first, 'box', 'the box is on top by default');
  click(doc.querySelector('#el-list .el-item [title="Send backward"]'));
  assert.notEqual(doc.querySelector('#el-list .el-item .type').textContent, 'box', 'the layer order changed');

  click(doc.querySelector('#el-list .el-item'));
  click(doc.querySelector('#arrange [data-arrange="duplicate"]'));
  assert.equal(doc.querySelectorAll('#el-list .el-item').length, 6, 'duplicate adds a layer');

  click(doc.querySelector('#el-list .el-item [title="Lock"]'));
  assert.ok(doc.querySelector('#el-list .el-item.locked'), 'the layer can be locked');
  assert.ok(doc.getElementById('preview').innerHTML.includes('locked'), 'the overlay marks a locked element');
});

test('changing the label size preset updates the preview and the size readout', async () => {
  const { doc, window } = await loadDesigner();
  const preset = doc.getElementById('preset');
  preset.value = 'label-100x150';
  preset.dispatchEvent(new window.Event('change'));
  assert.match(doc.getElementById('size-label').textContent, /100 x 150 mm @ 203 dpi/);
  const svg = doc.querySelector('#preview svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 799 1199', '100 x 150 mm at 203 dpi');
});

test('the canvas drags and resizes elements with the values each type really renders', async () => {
  const { doc, window, click } = await loadDesigner();
  const scale = 50 / 400; // document mm per rendered px at 100% zoom (50 mm, 400 dots)
  const px = (mm) => Math.round(mm / scale);
  const at = (mmX, mmY) => new window.MouseEvent('pointermove', { clientX: px(mmX), clientY: px(mmY), bubbles: true });
  const down = (mmX, mmY) => new window.MouseEvent('pointerdown', { clientX: px(mmX), clientY: px(mmY), bubbles: true });
  const up = () => new window.MouseEvent('pointerup', { bubbles: true });
  const svg = doc.querySelector('#preview svg');
  const numbers = () => [...doc.querySelectorAll('#props input[type=number]')].map((i) => Number(i.value));

  // Layers are listed top-most first: box, qrcode, barcode, text, text.
  click(doc.querySelectorAll('#el-list .el-item')[2]);
  assert.deepEqual(numbers().slice(0, 3), [4, 15, 30], 'the barcode starts at x=4, y=15, w=30');

  // Drag the element 5 mm to the right and 2 mm down (grid snapping is 1 mm).
  svg.dispatchEvent(down(10, 18));
  svg.dispatchEvent(at(15, 20));
  svg.dispatchEvent(up());
  assert.deepEqual(numbers().slice(0, 2), [9, 17], 'the drag moved the element by the snapped delta');

  // Resize from the south-east handle: +5 mm wide, +2.5 mm tall.
  svg.dispatchEvent(down(39, 26));
  svg.dispatchEvent(at(44, 28.5));
  svg.dispatchEvent(up());
  const after = numbers();
  assert.equal(after[2], 35, 'the barcode width follows the resize handle');
  assert.equal(after[3], 12, 'the barcode bar height follows the resize handle');

  // A QR code is sized by sizeMm, so its handle must change that - not a stale w.
  click(doc.querySelectorAll('#el-list .el-item')[1]);
  const qrBefore = numbers();
  const qrBox = { x: 33, y: 14, size: 13 };
  svg.dispatchEvent(down(qrBox.x + qrBox.size, qrBox.y + qrBox.size));
  svg.dispatchEvent(at(qrBox.x + qrBox.size + 4, qrBox.y + qrBox.size + 4));
  svg.dispatchEvent(up());
  const qrAfter = numbers();
  assert.equal(qrAfter[2], 17, 'the QR size grows with the handle (sizeMm, not w)');
  assert.notDeepEqual(qrAfter, qrBefore, 'the QR properties changed');
});

test('the printer language selector re-renders the native output', async () => {
  const { doc, window } = await loadDesigner();
  const lang = doc.getElementById('language');
  lang.value = 'tspl';
  lang.dispatchEvent(new window.Event('change'));
  assert.ok(await waitFor(() => doc.getElementById('out-cmd').textContent.startsWith('SIZE 50 mm,30 mm')), 'TSPL output');
  lang.value = 'zpl';
  lang.dispatchEvent(new window.Event('change'));
  assert.ok(await waitFor(() => doc.getElementById('out-cmd').textContent.startsWith('^XA')), 'back to ZPL');
  assert.equal(doc.getElementById('warn-host').textContent.trim(), '', 'the seeded document produces no warnings');
});

