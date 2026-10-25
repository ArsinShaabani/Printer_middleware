/**
 * Catalog schema + compatibility sanity for data/boards.json and data/apps.json.
 *
 * The catalogs drive the installer, the wiring diagrams and the firmware build
 * matrix, so a typo here breaks the whole product: these tests treat the JSON
 * files as the contract and validate them through the pure catalog core.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CATALOG_SCHEMA, BOARD_ROLES, normalizeBoard, normalizeApp, normalizeCatalog, mergeCatalogs,
  compatibility, resolveWiring, resolveRef, manifestPath, flashKind, boardsForApp, appsForBoard,
  boardById, appById, groupByFamily
} from '../assets/js/core/catalog.js';

const boardsJson = JSON.parse(readFileSync(new URL('../data/boards.json', import.meta.url), 'utf8'));
const appsJson = JSON.parse(readFileSync(new URL('../data/apps.json', import.meta.url), 'utf8'));
const catalog = mergeCatalogs(boardsJson, appsJson);

const board = (id) => boardById(catalog, id);
const app = (id) => appById(catalog, id);
const appCompat = (boardId, appId, transportId) => compatibility(board(boardId), app(appId), transportId);
const roleRefs = () => {
  const refs = new Set();
  for (const a of appsJson.apps) {
    for (const recipe of Object.values(a.wiring || {})) {
      for (const link of recipe.links || []) {
        const m = /^@([A-Za-z0-9_]+)$/.exec(String(link.board || '').trim());
        if (m) refs.add(m[1]);
      }
    }
  }
  return [...refs].sort();
};

test('both catalogs declare the expected schema version and contents', () => {
  assert.equal(boardsJson.schema, CATALOG_SCHEMA);
  assert.equal(appsJson.schema, CATALOG_SCHEMA);
  assert.ok(boardsJson.version && appsJson.version);
  assert.ok(Array.isArray(boardsJson.families) && boardsJson.families.length >= 3);
  assert.equal(boardsJson.boards.length, 15);
  assert.equal(appsJson.apps.length, 7);
  assert.equal(catalog.boards.length, 15);
  assert.equal(catalog.apps.length, 7);
});

test('board ids, app ids and family ids are unique', () => {
  for (const [label, list] of [['boards', boardsJson.boards], ['apps', appsJson.apps], ['families', boardsJson.families]]) {
    const ids = list.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `${label}: duplicate ids in ${JSON.stringify(ids)}`);
    assert.ok(ids.every((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id)), `${label}: ids must be lowercase slugs`);
  }
});


test('every board declares family, MCU, tool, pins and radios', () => {
  const families = boardsJson.families.map((f) => f.id);
  for (const b of catalog.boards) {
    assert.ok(families.includes(b.family), `${b.id}: unknown family "${b.family}"`);
    assert.equal(typeof b.mcu, 'string');
    assert.ok(b.mcu.length > 5, `${b.id}: MCU description`);
    assert.ok(b.name.length > 2, `${b.id}: name`);
    assert.ok(b.vendor && b.vendor.length > 1, `${b.id}: vendor`);
    assert.ok(Array.isArray(b.tags) && b.tags.length > 0, `${b.id}: tags`);
    assert.ok(b.notes.length > 0, `${b.id}: notes`);

    assert.ok(b.tool && typeof b.tool === 'object', `${b.id}: tool`);
    assert.ok(['esp-web-tools', 'sd-card', 'any'].includes(b.tool.kind), `${b.id}: tool.kind`);
    if (b.family === 'esp32' || b.family === 'esp8266') {
      assert.match(b.tool.fqbn, /^(esp32|esp8266):(esp32|esp8266):[a-z0-9_]+$/, `${b.id}: FQBN`);
      assert.ok(['ESP32', 'ESP32-S2', 'ESP32-S3', 'ESP32-C3', 'ESP32-C6', 'ESP8266'].includes(b.tool.chipFamily), `${b.id}: chipFamily`);
    }
    if (b.family === 'rpi') {
      assert.ok(b.tool.image, `${b.id}: SD card image`);
      assert.ok(b.tool.installer, `${b.id}: installer script`);
    }

    assert.ok(Object.keys(b.pins).length >= 3, `${b.id}: pins`);
    for (const key of Object.keys(b.pins)) {
      assert.ok(BOARD_ROLES.includes(key), `${b.id}: pin role "${key}" is not a BOARD_ROLE`);
      assert.ok(String(b.pins[key]).length > 0, `${b.id}: pin "${key}" is empty`);
    }
    for (const role of ['uartTx', 'uartRx', 'gnd']) {
      assert.ok(b.pins[role], `${b.id}: missing required pin role "${role}"`);
    }

    assert.deepEqual(Object.keys(b.radios).sort(), ['ble', 'btClassic', 'ethernet', 'thread', 'usbHost', 'wifi'], `${b.id}: radio flags`);
    assert.equal(b.radios.wifi, true, `${b.id}: every board must have Wi-Fi`);
    assert.ok(b.io.logicVoltage, `${b.id}: logic voltage`);
    assert.ok(b.power.input && b.power.typicalMa > 0 && b.power.maxMa >= b.power.typicalMa, `${b.id}: power budget`);
    assert.ok(b.usb.port && b.usb.chip, `${b.id}: usb metadata`);
  }
});

test('every app declares firmware, requires and a wiring recipe per transport', () => {
  for (const a of catalog.apps) {
    assert.ok(a.name && a.tagline && a.summary, `${a.id}: copy`);
    assert.ok(a.capabilities.length > 0, `${a.id}: capabilities`);
    assert.ok(a.features.length > 0, `${a.id}: features`);
    assert.ok(a.requirements.length > 0, `${a.id}: requirements`);
    assert.ok(a.transports.length > 0, `${a.id}: transports`);
    assert.ok(['esp32', 'esp8266', 'rpi'].includes(a.firmware.env), `${a.id}: firmware env`);
    assert.ok(a.firmware.variant, `${a.id}: firmware variant`);
    assert.ok(a.requires.families.length > 0, `${a.id}: requires.families`);
    const radios = ['wifi', 'ble', 'btClassic', 'usbHost', 'ethernet', 'thread'];
    assert.ok(a.requires.radios.every((r) => radios.includes(r)), `${a.id}: requires.radios`);
    assert.ok(a.transports.filter((t) => t.default).length <= 1, `${a.id}: at most one default transport`);
    for (const t of a.transports) {
      assert.ok(t.id && t.name && t.description, `${a.id}/${t.id}: transport copy`);
      assert.ok(Array.isArray(t.langs) && t.langs.length > 0, `${a.id}/${t.id}: printer languages`);
      assert.ok(a.wiring[t.id], `${a.id}/${t.id}: transport has no wiring recipe`);
      const recipe = a.wiring[t.id];
      assert.ok(recipe.title && recipe.summary, `${a.id}/${t.id}: recipe copy`);
      assert.ok(Array.isArray(recipe.links), `${a.id}/${t.id}: recipe links`);
      assert.ok(Array.isArray(recipe.steps) && recipe.steps.length > 0, `${a.id}/${t.id}: recipe steps`);
      assert.ok(Array.isArray(recipe.cables), `${a.id}/${t.id}: recipe cables`);
      assert.ok(Array.isArray(recipe.warnings), `${a.id}/${t.id}: recipe warnings`);
      assert.ok(Array.isArray(recipe.prerequisites), `${a.id}/${t.id}: recipe prerequisites`);
      for (const link of recipe.links) {
        assert.ok(link.signal, `${a.id}/${t.id}: link signal`);
        assert.ok(link.board, `${a.id}/${t.id}: link board`);
        assert.ok(link.printer, `${a.id}/${t.id}: link printer`);
      }
    }
  }
});

test('every @role referenced by a wiring recipe resolves on at least one board', () => {
  const refs = roleRefs();
  assert.ok(refs.length > 0, 'the catalogs must reference at least one pin role');
  for (const role of refs) {
    assert.ok(BOARD_ROLES.includes(role), `@${role} is not a declared BOARD_ROLE`);
    const resolvable = catalog.boards.filter((b) => resolveRef(`@${role}`, b).ok);
    assert.ok(resolvable.length > 0, `@${role} resolves on no board at all`);
  }
  // Every app must be buildable on at least one board for each of its transports.
  for (const a of catalog.apps) {
    for (const t of a.transports) {
      const buildable = catalog.boards.filter((b) => {
        const w = resolveWiring(b, a, t.id);
        return w && w.missing.length === 0;
      });
      assert.ok(buildable.length > 0, `${a.id}/${t.id}: no board can satisfy the wiring recipe`);
    }
  }
});

test('compatibility sanity: ESP8266 has no BT Classic / USB host app, S3 has USB host, Pi has CUPS', () => {
  const esp8266 = 'esp8266-nodemcu-v3';
  for (const appId of ['print-server-bt-spp', 'print-server-usbhost']) {
    const result = appCompat(esp8266, appId);
    assert.equal(result.ok, false, `${appId} must not be offered on ESP8266`);
    assert.ok(result.blockers.length > 0, `${appId}: blockers must explain why`);
  }
  assert.equal(appCompat(esp8266, 'print-server-wifi').ok, true, 'the Wi-Fi bridge runs on ESP8266');
  assert.equal(appCompat('esp32-devkit-v1', 'print-server-bt-spp').ok, true, 'ESP32 runs the BT SPP bridge');

  const s3 = appCompat('esp32-s3-devkitc-1', 'print-server-usbhost');
  assert.equal(s3.ok, true, 'ESP32-S3 must be offered the USB host build');
  assert.equal(appCompat('esp32-devkit-v1', 'print-server-usbhost').ok, false, 'plain ESP32 has no USB host');
  assert.equal(appCompat('esp32-c6-devkitc-1', 'print-server-wifi').ok, true, 'ESP32-C6 runs the Wi-Fi bridge');

  for (const pi of ['rpi-4b', 'rpi-5', 'rpi-zero-w', 'rpi-zero-2-w']) {
    assert.equal(appCompat(pi, 'print-server-cups').ok, true, `${pi} must be offered the CUPS bridge`);
  }
  assert.equal(appCompat('esp32-devkit-v1', 'print-server-cups').ok, false, 'CUPS is Raspberry Pi only');
  assert.equal(appCompat('rpi-4b', 'print-server-wifi').ok, true, 'the Pi can also run the Wi-Fi bridge');
});

test('compatibility reports the transports an app supports', () => {
  const wifi = appCompat('esp32-devkit-v1', 'print-server-wifi');
  assert.deepEqual(wifi.transports, ['serial', 'usbhost', 'parallel']);
  assert.equal(wifi.ok, true);
  const cups = appCompat('rpi-4b', 'print-server-cups');
  assert.deepEqual(cups.transports, ['usbhost', 'network', 'serial']);
  assert.equal(cups.ok, true);
  // An unknown board/app simply yields no results instead of throwing.
  assert.deepEqual(appsForBoard(catalog, 'nope'), []);
  assert.deepEqual(boardsForApp(catalog, 'nope'), []);
});

test('resolveWiring resolves the pin roles of a real board/app/transport', () => {
  const wifi = resolveWiring(board('esp32-devkit-v1'), app('print-server-wifi'), 'serial');
  assert.ok(wifi, 'the Wi-Fi bridge has a serial recipe');
  assert.equal(wifi.transportId, 'serial');
  assert.equal(wifi.missing.length, 0, 'no required link may be missing');
  assert.equal(wifi.title, 'TTL serial wiring (board UART -> printer serial port)');
  const signals = wifi.links.map((l) => l.signal);
  assert.deepEqual(signals, ['TX', 'RX', 'GND', 'DTR/CTS']);
  const tx = wifi.links[0];
  assert.equal(tx.board, 'GPIO 17 (TX2)');
  assert.equal(tx.boardRole, 'uartTx');
  assert.equal(tx.required, true);
  assert.match(tx.printer, /Printer RX/);
  const gnd = wifi.links.find((l) => l.signal === 'GND');
  assert.equal(gnd.boardRole, 'gnd');
  assert.ok(wifi.cables.length >= 3, 'bill of materials');
  assert.ok(wifi.steps.length >= 5, 'step by step guide');
  assert.ok(wifi.prerequisites.length >= 1);
  assert.ok(wifi.power.length > 0);
  // The optional DTR/CTS link points at a role this board does not expose.
  const dtr = wifi.links.find((l) => l.signal === 'DTR/CTS');
  assert.equal(dtr.required, false);
  assert.equal(dtr.unresolved, true);
  assert.match(dtr.reason, /no pin mapped for role "spare1"/);
  assert.ok(wifi.warnings.some((w) => w.includes('spare1')), 'optional gaps are reported as warnings');
});

test('resolveWiring flags every missing required role for an unsupported transport', () => {
  const usb = resolveWiring(board('esp32-devkit-v1'), app('print-server-wifi'), 'usbhost');
  assert.ok(usb);
  assert.ok(usb.missing.length >= 4, `expected the USB roles to be missing, got ${JSON.stringify(usb.missing)}`);
  for (const role of ['usb5v', 'usbDm', 'usbDp', 'usbGnd']) {
    assert.ok(usb.missing.some((m) => m.includes(`"${role}"`)), `missing role ${role}`);
  }
  assert.equal(compatibility(board('esp32-devkit-v1'), app('print-server-wifi'), 'usbhost').ok, false);
});

test('resolveWiring works for the Raspberry Pi header and the wireless recipe', () => {
  const serial = resolveWiring(board('rpi-4b'), app('print-server-cups'), 'serial');
  assert.equal(serial.missing.length, 0);
  assert.equal(serial.links.find((l) => l.signal === 'TX').board, 'GPIO 14 (pin 8)');
  assert.equal(serial.links.find((l) => l.signal === 'RX').board, 'GPIO 15 (pin 10)');
  assert.equal(serial.links.find((l) => l.signal === 'GND').board, 'GND (pin 6)');

  const network = resolveWiring(board('rpi-4b'), app('print-server-cups'), 'network');
  assert.equal(network.missing.length, 0, 'the network recipe has no required wiring');
  assert.equal(network.links.length, 1);
  assert.equal(network.links[0].required, false);
  assert.equal(network.links[0].signal, 'Ethernet');

  // An unknown transport id falls back to the app's default recipe.
  assert.match(resolveWiring(board('rpi-4b'), app('print-server-wifi'), 'nope').title, /TTL serial wiring/);
});

test('resolveRef handles roles, literals and unknown roles', () => {
  const b = board('esp32-devkit-v1');
  assert.deepEqual(resolveRef('@uartTx', b), { ok: true, value: 'GPIO 17 (TX2)', role: 'uartTx', literal: false });
  assert.deepEqual(resolveRef('  @gnd  ', b), { ok: true, value: 'GND', role: 'gnd', literal: false });
  assert.equal(resolveRef('@bogus', b).ok, false);
  assert.match(resolveRef('@bogus', b).reason, /has no pin mapped for role "bogus"/);
  assert.deepEqual(resolveRef('GPIO 4', b), { ok: true, value: 'GPIO 4', role: null, literal: true });
  assert.deepEqual(resolveRef('@spare1 (or on-board RJ45)', b), { ok: true, value: '@spare1 (or on-board RJ45)', role: null, literal: true });
  assert.equal(resolveRef(42, b).ok, false);
});

test('helpers: manifestPath, flashKind, grouping and lookups', () => {
  assert.equal(manifestPath(app('print-server-wifi'), board('esp32-devkit-v1')), 'manifests/print-server-wifi/esp32-devkit-v1.json');
  assert.equal(manifestPath(app('print-server-cups'), board('rpi-4b')), 'manifests/print-server-cups/rpi-4b.json');
  assert.equal(flashKind(board('esp32-devkit-v1')), 'esp-web-tools');
  assert.equal(flashKind(board('rpi-4b')), 'sd-card');
  assert.equal(boardById(catalog, 'nope'), null);
  assert.equal(appById(catalog, 'nope'), null);

  const groups = groupByFamily(catalog.boards);
  assert.deepEqual(groups.map((g) => g.family), ['esp32', 'esp8266', 'rpi']);
  assert.deepEqual(groups.map((g) => g.items.length), [8, 3, 4]);
  for (const g of groups) {
    const names = g.items.map((i) => i.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), `${g.family}: boards are sorted by name`);
  }

  const wifiBoards = boardsForApp(catalog, 'print-server-wifi');
  assert.equal(wifiBoards.length, 15);
  assert.ok(wifiBoards.every((x) => x.compat.ok), 'every board can run the Wi-Fi bridge');
  const esp32Apps = appsForBoard(catalog, 'esp32-devkit-v1').map((x) => x.app.id);
  assert.deepEqual(esp32Apps, ['print-server-ble', 'print-server-bt-spp', 'print-server-serial', 'print-server-wifi']);
  const s3Apps = appsForBoard(catalog, 'esp32-s3-devkitc-1').map((x) => x.app.id);
  assert.ok(s3Apps.includes('print-server-usbhost'), 'S3 gets the USB host build');
  assert.ok(s3Apps.includes('print-server-hybrid'), 'S3 gets the hybrid build');
});

test('normalisation fills safe defaults and merging lets extra catalogs win', () => {
  const minimalBoard = normalizeBoard({ id: 'my-board' });
  assert.equal(minimalBoard.family, 'custom');
  assert.equal(minimalBoard.vendor, 'Unknown');
  assert.deepEqual(minimalBoard.radios, { wifi: false, ble: false, btClassic: false, usbHost: false, ethernet: false, thread: false });
  assert.deepEqual(minimalBoard.pins, {});
  assert.equal(minimalBoard.io.logicVoltage, '3.3V');
  assert.equal(minimalBoard.power.typicalMa, 250);
  assert.equal(minimalBoard.tool.kind, 'esp-web-tools');
  assert.equal(minimalBoard.source, 'builtin');
  assert.throws(() => normalizeBoard({ name: 'no id' }), /board\.id is required/);

  const minimalApp = normalizeApp({ id: 'my-app' });
  assert.equal(minimalApp.category, 'printer-bridge');
  assert.deepEqual(minimalApp.requires, { families: [], radios: [], excludeBoards: [], excludeApp: [] });
  assert.equal(minimalApp.firmware.env, 'my-app');
  assert.equal(minimalApp.transports.length, 1, 'a default transport is synthesised');
  assert.throws(() => normalizeApp({ name: 'no id' }), /app\.id is required/);

  const normalised = normalizeCatalog({ boards: [{ id: 'x' }] });
  assert.equal(normalised.schema, CATALOG_SCHEMA);
  assert.equal(normalised.boards.length, 1);
  assert.deepEqual(normalised.apps, []);
  assert.deepEqual(normalizeCatalog(null).boards, []);

  const merged = mergeCatalogs(boardsJson, appsJson, {
    boards: [{ id: 'esp32-devkit-v1', name: 'Overridden name', source: 'custom' }],
    apps: [{ id: 'print-server-wifi', tagline: 'Overridden tagline' }]
  });
  assert.equal(merged.boards.length, 15, 'overriding must not duplicate the board');
  const overridden = boardById(merged, 'esp32-devkit-v1');
  assert.equal(overridden.name, 'Overridden name');
  assert.equal(overridden.source, 'custom');
  // mergeCatalogs() upserts whole normalised records, so a partial override wins
  // field by field and unspecified fields fall back to the normaliser defaults.
  assert.equal(overridden.mcu, 'Unknown MCU');
  assert.equal(overridden.family, 'custom');
  assert.deepEqual(overridden.pins, {});
  assert.equal(appById(merged, 'print-server-wifi').tagline, 'Overridden tagline');
  assert.equal(appById(merged, 'print-server-wifi').transports.length, 1, 'a partial app override is normalised on its own');
  assert.equal(boardById(merged, 'rpi-4b').mcu, board('rpi-4b').mcu, 'untouched boards are preserved');
});

