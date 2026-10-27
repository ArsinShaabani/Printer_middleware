/**
 * Wiring diagram generator: the SVG must be well-formed, contain every link
 * label and never leak NaN/undefined into the markup, and the plain-text guide
 * must contain every section the installer renders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { mergeCatalogs, resolveWiring, boardById, appById } from '../assets/js/core/catalog.js';
import { renderWiringSvg, wiringToText, signalKind, signalColor } from '../assets/js/core/wiring.js';

const catalog = mergeCatalogs(
  JSON.parse(readFileSync(new URL('../data/boards.json', import.meta.url), 'utf8')),
  JSON.parse(readFileSync(new URL('../data/apps.json', import.meta.url), 'utf8'))
);

const board = (id) => boardById(catalog, id);
const app = (id) => appById(catalog, id);

/** Parse an SVG string with jsdom and fail on XML errors. */
function parseSvg(markup) {
  const dom = new JSDOM(markup, { contentType: 'image/svg+xml' });
  const doc = dom.window.document;
  const errors = doc.getElementsByTagName('parsererror');
  assert.equal(errors.length, 0, `SVG must be well-formed: ${errors[0] ? errors[0].textContent : ''}`);
  const root = doc.documentElement;
  assert.equal(root.tagName.toLowerCase(), 'svg');
  assert.equal(root.namespaceURI, 'http://www.w3.org/2000/svg');
  return doc;
}

const serialCase = () => {
  const b = board('esp32-devkit-v1');
  const a = app('print-server-wifi');
  return { b, a, wiring: resolveWiring(b, a, 'serial') };
};

test('renderWiringSvg produces a well-formed SVG with every link label', () => {
  const { b, a, wiring } = serialCase();
  const svg = renderWiringSvg(wiring, b, a);
  assert.ok(svg.startsWith('<svg '), 'starts with an <svg> root');
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.ok(!svg.includes('NaN'), 'no NaN in the markup');
  assert.ok(!svg.includes('undefined'), 'no undefined in the markup');
  assert.ok(!svg.includes('Infinity'), 'no Infinity in the markup');

  const doc = parseSvg(svg);
  const root = doc.documentElement;
  assert.equal(root.getAttribute('viewBox'), '0 0 960 420');
  assert.equal(root.getAttribute('role'), 'img');
  assert.equal(root.getAttribute('aria-label'), wiring.title);

  const text = root.textContent;
  for (const link of wiring.links.filter((l) => !l.unresolved)) {
    const label = `${link.signal}: ${link.board} -> ${link.printer}`;
    assert.ok(text.includes(label), `diagram must contain the link label "${label}"`);
  }
  assert.ok(text.includes(wiring.title), 'diagram title');
  assert.ok(text.includes(a.name), 'app name');
  assert.ok(text.includes(b.name), 'board name');
  assert.ok(text.includes(b.mcu.slice(0, 20)), 'board MCU');
  assert.ok(text.includes(b.io.logicVoltage), 'logic voltage');
  assert.ok(text.includes(wiring.transportId), 'transport id');

  // One wire path per resolved link, plus the two endpoint dots each.
  const paths = [...root.querySelectorAll('path')];
  const wires = paths.filter((p) => /^M \d+ \d+ C /.test(p.getAttribute('d') || ''));
  assert.equal(wires.length, wiring.links.filter((l) => !l.unresolved).length);
  const circles = [...root.querySelectorAll('circle')];
  assert.ok(circles.length >= wires.length * 2, 'each wire has two endpoints');
  for (const path of wires) assert.ok(!path.getAttribute('d').includes('NaN'));

  // Board and printer boxes plus the colour legend.
  for (const kicker of ['BOARD', 'PRINTER']) assert.ok(text.includes(kicker), `legend kicker ${kicker}`);
  for (const kind of ['power', 'gnd', 'data', 'usb', 'net']) assert.ok(text.includes(kind), `legend entry ${kind}`);
});

test('renderWiringSvg honours the width/height options and is stable for every pair', () => {
  const { b, a, wiring } = serialCase();
  const narrow = renderWiringSvg(wiring, b, a, { width: 640, height: 520 });
  const doc = parseSvg(narrow);
  assert.equal(doc.documentElement.getAttribute('viewBox'), '0 0 640 520');

  let checked = 0;
  for (const appDef of catalog.apps) {
    for (const transport of appDef.transports) {
      for (const boardDef of catalog.boards) {
        const w = resolveWiring(boardDef, appDef, transport.id);
        if (!w) continue;
        const svg = renderWiringSvg(w, boardDef, appDef);
        assert.ok(!svg.includes('NaN'), `${appDef.id}/${boardDef.id}/${transport.id}: NaN in SVG`);
        assert.ok(!svg.includes('undefined'), `${appDef.id}/${boardDef.id}/${transport.id}: undefined in SVG`);
        parseSvg(svg);
        checked++;
      }
    }
  }
  assert.ok(checked > 100, `expected to check many combinations, checked ${checked}`);
});

test('wiringToText contains every section of the guide', () => {
  const { b, a, wiring } = serialCase();
  const text = wiringToText(wiring, b, a);
  assert.ok(text.startsWith(`# ${wiring.title}`), 'starts with the recipe title');
  for (const heading of ['## Connections', '## Bill of materials', '## Steps', '## Warnings', '## Prerequisites']) {
    assert.ok(text.includes(heading), `guide must contain "${heading}"`);
  }
  assert.ok(text.includes(`Board: ${b.name} (${b.mcu})`));
  assert.ok(text.includes(`App: ${a.name} - transport: serial`));
  for (const link of wiring.links) {
    const suffix = link.required === false ? ' [optional]' : '';
    assert.ok(text.includes(`- ${link.signal}: ${link.board}  ->  ${link.printer}  (${link.cable})${suffix}`), `guide must list ${link.signal}`);
  }
  for (const cable of wiring.cables) assert.ok(text.includes(`- ${cable.qty || 1} x ${cable.item}`), `guide must list ${cable.item}`);
  wiring.steps.forEach((step, i) => assert.ok(text.includes(`${i + 1}. ${step}`), `guide must number step ${i + 1}`));
  for (const warning of wiring.warnings) assert.ok(text.includes(`- ${warning}`), `guide must list the warning "${warning}"`);
  for (const prereq of wiring.prerequisites) assert.ok(text.includes(`- ${prereq}`), `guide must list the prerequisite "${prereq}"`);
  // No unexpanded references or template placeholders may leak through.
  assert.ok(!text.includes('@uart'), 'roles must be resolved');
  assert.ok(!text.includes('undefined'));
});

test('wiringToText explains the wireless-only recipe and the missing recipe case', () => {
  const b = board('rpi-4b');
  const a = app('print-server-cups');
  const text = wiringToText(resolveWiring(b, a, 'network'), b, a);
  assert.ok(text.includes('## Connections'));
  assert.ok(text.includes('Ethernet: @spare1 (or on-board RJ45)  ->  Printer RJ45 / Wi-Fi  (Cat5e patch cable) [optional]'));
  assert.equal(wiringToText(null, b, a), 'No wiring recipe for this combination.');

  const noLinks = { ...resolveWiring(b, a, 'network'), links: [] };
  assert.ok(wiringToText(noLinks, b, a).includes('- Wireless only, no physical wiring required.'));
});

test('signalKind and signalColor classify every documented signal', () => {
  assert.equal(signalKind('TX'), 'data');
  assert.equal(signalKind('RX'), 'data');
  assert.equal(signalKind('DTR/CTS'), 'data');
  assert.equal(signalKind('GND'), 'gnd');
  assert.equal(signalKind('Ground'), 'gnd');
  assert.equal(signalKind('5V'), 'power');
  assert.equal(signalKind('VCC'), 'power');
  assert.equal(signalKind('3V3'), 'power');
  assert.equal(signalKind('USB D+'), 'usb');
  assert.equal(signalKind('Ethernet'), 'net');
  assert.equal(signalKind('CLK'), 'clock');
  assert.equal(signalKind('something else'), 'other');
  assert.equal(signalKind(undefined), 'other');
  assert.equal(signalColor('TX'), '#3b82f6');
  assert.equal(signalColor('GND'), '#111111');
  assert.equal(signalColor('5V'), '#e5484d');
  assert.equal(signalColor('USB D+'), '#0ea5e9');
  assert.equal(signalColor('Ethernet'), '#16a34a');
  assert.equal(signalColor('nonsense'), '#64748b');
  // The colour of an optional link must be reflected in the diagram.
  const { b, a, wiring } = serialCase();
  const svg = renderWiringSvg(wiring, b, a);
  for (const link of wiring.links.filter((l) => !l.unresolved)) {
    assert.ok(svg.includes(signalColor(link.signal)), `${link.signal}: uses its signal colour`);
  }
  const withOptional = {
    ...wiring,
    links: [{ signal: 'DTR', board: 'GPIO 4', printer: 'Printer BUSY', cable: 'Jumper wire', required: false }]
  };
  assert.ok(renderWiringSvg(withOptional, b, a).includes('stroke-dasharray="6 5"'), 'optional links are dashed');
});

test('renderWiringSvg draws the wireless placeholder when nothing must be wired', () => {
  const b = board('rpi-4b');
  const a = app('print-server-cups');
  const wiring = resolveWiring(b, a, 'network');
  assert.equal(wiring.links.filter((l) => !l.unresolved).length, 1, 'the network recipe has one optional link');
  const svg = renderWiringSvg(wiring, b, a);
  const doc = parseSvg(svg);
  assert.ok(doc.documentElement.textContent.includes('transport: network'));

  const wireless = { ...wiring, links: [] };
  const empty = renderWiringSvg(wireless, b, a);
  const emptyDoc = parseSvg(empty);
  assert.ok(emptyDoc.documentElement.textContent.includes('No wires - wireless link'));
  assert.ok(!empty.includes('NaN'));
  // No resolved links means no wire paths at all (the placeholder uses q-curves).
  const wires = [...emptyDoc.documentElement.querySelectorAll('path')].filter((p) => /^M \d+ \d+ C /.test(p.getAttribute('d') || ''));
  assert.equal(wires.length, 0);
});

test('the diagram layout stays readable: labels stay inside the boxes and rows never overlap', () => {
  const catalog2 = catalog;
  let checked = 0;
  for (const b of catalog2.boards) {
    for (const a of catalog2.apps) {
      for (const transport of a.transports) {
        const wiring = resolveWiring(b, a, transport.id);
        if (!wiring || !wiring.links.filter((l) => !l.unresolved).length) continue;
        const svg = renderWiringSvg(wiring, b, a);
        const dom = new JSDOM(svg, { contentType: 'image/svg+xml' });
        const root = dom.window.document.documentElement;
        const nodes = [...root.querySelectorAll('text')].map((n) => ({
          text: n.textContent,
          x: Number(n.getAttribute('x')),
          y: Number(n.getAttribute('y')),
          size: Number(n.getAttribute('font-size') || 12),
          anchor: n.getAttribute('text-anchor') || 'start'
        }));
        // Every wire row owns exactly one signal chip; chips must not overlap.
        const chips = nodes.filter((n) => n.anchor === 'middle' && n.text.includes('\u00b7'));
        const rows = chips.map((c) => c.y).sort((p, q) => p - q);
        for (let i = 1; i < rows.length; i++) {
          assert.ok(rows[i] - rows[i - 1] >= 24, `${b.id}/${a.id}/${transport.id}: wire rows overlap`);
        }
        // Pin labels are anchored against the box edges and must fit inside them.
        const boardLabels = nodes.filter((n) => n.anchor === 'end' && Math.abs(n.x - 278) < 1);
        for (const label of boardLabels) {
          const width = label.text.length * label.size * 0.58;
          assert.ok(label.x - width >= 24, `${b.id}: "${label.text}" overflows the board box`);
        }
        const printerLabels = nodes.filter((n) => n.anchor === 'start' && Math.abs(n.x - 682) < 1);
        for (const label of printerLabels) {
          const width = label.text.length * label.size * 0.58;
          assert.ok(label.x + width <= 936, `${b.id}: "${label.text}" overflows the printer box`);
        }
        // Each wire keeps the full sentence as an accessible <title>.
        const titles = [...root.querySelectorAll('title')].map((n) => n.textContent);
        assert.equal(titles.length, wiring.links.filter((l) => !l.unresolved).length, 'one title per wire');
        for (const link of wiring.links.filter((l) => !l.unresolved)) {
          assert.ok(titles.includes(`${link.signal}: ${link.board} -> ${link.printer}`), 'the full label is preserved');
        }
        checked += 1;
      }
    }
  }
  assert.ok(checked > 20, `the layout was checked for ${checked} recipes`);
});

test('renderWiringSvg tolerates a missing wiring recipe', () => {
  const b = board('esp32-devkit-v1');
  const a = app('print-server-wifi');
  const svg = renderWiringSvg(null, b, a);
  parseSvg(svg);
  assert.ok(svg.includes('Wiring'));
  assert.ok(svg.includes('No wires - wireless link'));
  assert.ok(!svg.includes('NaN'));
});
