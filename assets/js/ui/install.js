/**
 * Installer wizard: application -> transport -> board -> wiring -> flash ->
 * configure. Everything is driven by data/boards.json + data/apps.json, so new
 * boards and apps show up here without touching this file.
 */
import {
  initShell, loadCatalog, $, el, esc, t, toast, openModal, download, copyText, store,
  parseCustomBoard, saveCustomBoard, getCustomBoards, removeCustomBoard, clamp
} from './shell.js';
import {
  compatibility, resolveWiring, manifestPath, boardsForApp, flashKind, groupByFamily, appById, boardById
} from '../core/catalog.js';
import { renderWiringSvg, wiringToText } from '../core/wiring.js';
import { LANGUAGES } from '../core/commands.js';
import { Device, normalizeBase } from './device.js';

initShell();

const state = {
  catalog: null,
  app: null,
  transport: null,
  board: null,
  wiring: null,
  onlyCompatible: true,
  search: '',
  manifestIndex: null,
  device: null,
  info: null
};

/* ----------------------------------------------------------------- helpers */

const section = (id) => document.getElementById(id);

function show(id, on = true) {
  const node = section(id);
  if (node) node.hidden = !on;
}

/** Scroll a section into view (guarded so headless test environments work). */
function scrollTo(node) {
  if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setCrumbs() {
  $('#crumb-app').textContent = state.app ? state.app.name : '-';
  $('#crumb-transport').textContent = state.transport ? transportName(state.transport) : '-';
  $('#crumb-board').textContent = state.board ? state.board.name : '-';
}

function transportName(id) {
  const tr = state.app && state.app.transports.find((x) => x.id === id);
  return tr ? tr.name : id;
}

function selectedApp() {
  return state.app;
}

/* -------------------------------------------------------------- step 1: app */

function renderApps() {
  const host = $('#app-list');
  host.innerHTML = '';
  for (const app of state.catalog.apps) {
    const card = el('div', {
      class: 'card selectable' + (state.app && state.app.id === app.id ? ' selected' : ''),
      onclick: () => chooseApp(app.id)
    }, [
      el('h3', { text: app.name }),
      el('p', { class: 'small', text: app.tagline }),
      el('div', { class: 'pill-list mb2' }, app.transports.map((tr) => el('span', { class: 'badge', text: tr.name }))),
      el('p', { class: 'small muted', text: app.summary.slice(0, 150) + (app.summary.length > 150 ? '...' : '') })
    ]);
    host.append(card);
  }
}

function chooseApp(appId) {
  state.app = appById(state.catalog, appId);
  const def = state.app.transports.find((x) => x.default) || state.app.transports[0];
  state.transport = def ? def.id : null;
  state.board = null;
  state.wiring = null;
  renderApps();
  renderTransports();
  show('section-transport', true);
  show('section-board', false);
  show('section-wiring', false);
  show('section-flash', false);
  show('section-configure', false);
  setCrumbs();
  scrollTo(section('section-transport'));
}

/* -------------------------------------------------------- step 2: transport */

function renderTransports() {
  const host = $('#transport-list');
  host.innerHTML = '';
  if (!state.app) return;
  for (const tr of state.app.transports) {
    const langs = tr.langs.map((l) => (LANGUAGES.find((x) => x.id === l) || { name: l }).name);
    host.append(
      el('div', {
        class: 'card selectable' + (state.transport === tr.id ? ' selected' : ''),
        onclick: () => chooseTransport(tr.id)
      }, [
        el('h3', { text: tr.name }),
        el('p', { class: 'small', text: tr.description }),
        el('div', { class: 'pill-list' }, langs.map((l) => el('span', { class: 'badge info', text: l })))
      ])
    );
  }
}

function chooseTransport(id) {
  state.transport = id;
  state.board = null;
  state.wiring = null;
  renderTransports();
  renderBoards();
  show('section-board', true);
  show('section-wiring', false);
  show('section-flash', false);
  show('section-configure', false);
  setCrumbs();
  scrollTo(section('section-board'));
}

/* ------------------------------------------------------------- step 3: board */

function renderBoards() {
  const host = $('#board-list');
  host.innerHTML = '';
  if (!state.app) return;
  const q = state.search.toLowerCase();
  const entries = boardsForApp(state.catalog, state.app.id).filter(({ board }) => {
    if (state.onlyCompatible && !compatibility(board, state.app, state.transport).ok) return false;
    if (q && !(`${board.name} ${board.mcu} ${board.vendor} ${board.tags.join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
  if (!entries.length) {
    host.innerHTML = '<div class="callout warn">' + esc(t('common.noresults')) + '</div>';
    return;
  }
  for (const { board, compat } of entries) {
    const apps = state.catalog.apps.filter((a) => compatibility(board, a, a.id === state.app.id ? state.transport : null).ok);
    const card = el('div', {
      class: 'card selectable' + (state.board && state.board.id === board.id ? ' selected' : '') + (compat.ok ? '' : ' disabled'),
      onclick: () => chooseBoard(board.id)
    }, [
      el('div', { class: 'spread' }, [
        el('h3', { text: board.name }),
        compat.ok
          ? el('span', { class: 'badge ok', text: board.family.toUpperCase() })
          : el('span', { class: 'badge danger', text: t('install.incompatible') })
      ]),
      el('p', { class: 'small', text: board.mcu }),
      el('div', { class: 'pill-list mb2' }, [
        board.radios.wifi ? el('span', { class: 'badge', text: 'Wi-Fi' }) : null,
        board.radios.btClassic ? el('span', { class: 'badge', text: 'BT Classic' }) : null,
        board.radios.ble ? el('span', { class: 'badge', text: 'BLE' }) : null,
        board.radios.usbHost ? el('span', { class: 'badge', text: 'USB host' }) : null,
        board.radios.ethernet ? el('span', { class: 'badge', text: 'Ethernet' }) : null
      ].filter(Boolean)),
      el('p', { class: 'small muted', text: board.power.input }),
      !compat.ok && compat.blockers.length
        ? el('div', { class: 'callout warn small', html: '<strong>' + esc(t('install.why.incompatible')) + '</strong><ul>' + compat.blockers.map((b) => '<li>' + esc(b) + '</li>').join('') + '</ul>' })
        : null
    ]);
    host.append(card);
  }
}

function chooseBoard(id) {
  state.board = boardById(state.catalog, id);
  const compat = compatibility(state.board, state.app, state.transport);
  if (!compat.ok) {
    toast(compat.blockers[0] || 'Board not compatible', 'warn', 6000);
  }
  state.wiring = resolveWiring(state.board, state.app, state.transport);
  renderBoards();
  renderWiring();
  show('section-wiring', true);
  show('section-flash', true);
  show('section-configure', true);
  setCrumbs();
  renderFlash();
  renderConfigure();
  scrollTo(section('section-wiring'));
  store.set('lastSelection', { app: state.app.id, transport: state.transport, board: state.board.id });
}

/* ------------------------------------------------------------ step 4: wiring */

function renderWiring() {
  const w = state.wiring;
  if (!w) return;
  $('#wiring-title').textContent = w.title;
  $('#wiring-diagram').innerHTML = renderWiringSvg(w, state.board, state.app, { width: 960 });
  $('#wiring-summary').innerHTML =
    '<strong>' + esc(transportName(w.transportId)) + '</strong><p class="small mb0">' + esc(w.summary || '') + '</p>' +
    (w.power ? '<p class="small mb0"><strong>' + esc(t('common.power')) + ':</strong> ' + esc(w.power) + '</p>' : '');

  const table = el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [t('common.signal'), t('common.boardSide'), t('common.printerSide'), 'Cable', ''])]),
      el('tbody', {}, w.links.map((l) => el('tr', {}, [
        el('td', {}, [el('strong', { text: l.signal }), l.note ? el('div', { class: 'small muted', text: l.note }) : null]),
        el('td', { class: 'mono', text: l.board }),
        el('td', { class: 'mono', text: l.printer }),
        el('td', { class: 'small', text: l.cable }),
        el('td', {}, [el('span', { class: 'badge ' + (l.required === false ? 'warn' : 'ok'), text: l.required === false ? t('common.optional') : t('common.required') })])
      ])))
    ])
  ]);
  const tableHost = $('#wiring-table');
  tableHost.innerHTML = '';
  tableHost.append(table);

  const bom = $('#wiring-bom');
  bom.innerHTML = '';
  if (w.cables.length) {
    bom.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Qty', 'Item', 'Note'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, w.cables.map((c) => el('tr', {}, [el('td', { text: String(c.qty || 1) }), el('td', { text: c.item }), el('td', { class: 'small muted', text: c.note || '' })])))
    ])]));
  } else {
    bom.innerHTML = '<div class="callout">No extra parts beyond the board, the printer and its cable.</div>';
  }

  const steps = $('#wiring-steps');
  steps.innerHTML = '';
  for (const s of w.steps) steps.append(el('li', { text: s }));
  if (!w.steps.length) steps.append(el('li', { text: 'Wire the connections listed above, then power the board.' }));

  const req = $('#wiring-requirements');
  req.innerHTML = '';
  const reqList = el('ul');
  for (const r of [...state.app.requirements, ...w.prerequisites]) reqList.append(el('li', { text: r }));
  req.append(el('div', { class: 'callout ok' }, [el('strong', { text: t('wizard.requirements') }), reqList]));
  req.append(el('h4', { text: t('common.board') }));
  req.append(boardFacts(state.board));

  const warn = $('#wiring-warnings');
  warn.innerHTML = '';
  const all = [...w.warnings, ...(state.board.notes || []).map((n) => 'Board note: ' + n)];
  if (all.length) {
    warn.append(el('div', { class: 'callout warn' }, [
      el('strong', { text: t('install.wiring.warnings') }),
      el('ul', {}, all.map((x) => el('li', { text: x })))
    ]));
  } else {
    warn.innerHTML = '<div class="callout ok">No special warnings for this combination.</div>';
  }
}

function boardFacts(board) {
  const rows = [
    [t('common.vendor'), board.vendor],
    [t('common.mcu'), board.mcu],
    [t('common.family'), board.family],
    [t('common.radios'), Object.entries(board.radios).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'],
    [t('common.power'), board.power.input + ' (~' + board.power.typicalMa + ' mA typical, ' + board.power.maxMa + ' mA peak)'],
    ['Logic level', board.io.logicVoltage + (board.io.input5vTolerant ? ' (5V tolerant inputs)' : ' - not 5V tolerant')],
    ['USB', board.usb.port + ' - ' + board.usb.chip],
    ['Flashing', flashKind(board) === 'esp-web-tools' ? 'Web Serial (browser) or esptool' : 'SD card image + installer script']
  ];
  const dl = el('dl', { class: 'kv' });
  for (const [k, v] of rows) {
    dl.append(el('dt', { text: k }), el('dd', { text: v }));
  }
  const wrap = el('div', {});
  wrap.append(dl);
  const pins = el('div', { class: 'table-wrap mt2' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Role', 'Pin'] .map((h) => el('th', { text: h })))]),
    el('tbody', {}, Object.entries(board.pins).map(([k, v]) => el('tr', {}, [el('td', { class: 'mono', text: '@' + k }), el('td', { class: 'mono', text: v })])))
  ])]);
  wrap.append(pins);
  return wrap;
}

function wiringGuideText() {
  if (!state.wiring) return '';
  return wiringToText(state.wiring, state.board, state.app);
}

function wireWiringButtons() {
  $('#download-guide').addEventListener('click', () => {
    download(`arsin-wiring-${state.app.id}-${state.board.id}.md`, wiringGuideText(), 'text/markdown');
  });
  $('#copy-guide').addEventListener('click', () => copyText(wiringGuideText()));
  $('#print-guide').addEventListener('click', () => window.print());
}

/* ------------------------------------------------------------- step 5: flash */

async function loadManifestIndex() {
  if (state.manifestIndex) return state.manifestIndex;
  try {
    const res = await fetch('manifests/index.json', { cache: 'no-store' });
    state.manifestIndex = res.ok ? await res.json() : { builds: [] };
  } catch (e) {
    state.manifestIndex = { builds: [] };
  }
  return state.manifestIndex;
}

/**
 * A build can only be flashed when its compiled binaries are reachable.
 * The manifest files themselves are committed, so their existence is NOT a
 * signal - the index tells us whether the CI built the binaries, and as a
 * fallback we probe the first part of the manifest.
 */
async function manifestAvailable(path) {
  const index = await loadManifestIndex();
  if (Array.isArray(index.builds) && index.builds.length) {
    const entry = index.builds.find((b) => b.manifest === path);
    if (entry) return entry.available === true;
  }
  try {
    const res = await fetch(path, { method: 'GET', cache: 'no-store' });
    if (!res.ok) return false;
    const manifest = await res.json();
    const first = manifest && manifest.builds && manifest.builds[0] && manifest.builds[0].parts && manifest.builds[0].parts[0];
    if (!first || !first.path) return false;
    const url = new URL(first.path, new URL(path, location.href)).toString();
    const probe = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return probe.ok;
  } catch (e) {
    return false;
  }
}

async function renderFlash() {
  const host = $('#flash-panel');
  host.innerHTML = '';
  if (!state.board || !state.app) return;
  const kind = flashKind(state.board);
  const path = manifestPath(state.app, state.board);

  if (kind === 'sd-card') {
    host.append(piInstructions());
    return;
  }

  const available = await manifestAvailable(path);
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'spread' }, [
      el('h3', { text: t('install.flash.browser') }),
      el('span', { class: 'badge ' + (available ? 'ok' : 'warn'), text: available ? 'firmware ready' : 'build required' })
    ]),
    el('p', { class: 'small', text: t('install.flash.hint') })
  ]);

  if (available) {
    const button = document.createElement('esp-web-install-button');
    button.setAttribute('manifest', path);
    const inner = el('button', { class: 'primary', slot: 'activate', text: t('nav.install') + ' - ' + state.board.name });
    const unsupported = el('div', { slot: 'unsupported', class: 'callout warn', html: 'This browser has no Web Serial support. Use Chrome/Edge on desktop, or build and flash manually below.' });
    button.append(inner, unsupported);
    card.append(el('div', { class: 'row mt2' }, [button]));
    card.append(el('p', { class: 'small muted', text: 'Hold BOOT, tap RESET, release BOOT if the port does not appear.' }));
  } else {
    card.append(el('div', { class: 'callout warn' }, [
      el('strong', { text: t('install.flash.notbuilt') }),
      el('p', { class: 'small mb0', text: 'Manifest: ' + path })
    ]));
  }
  card.append(buildInstructions());
  host.append(card);

  const after = el('div', { class: 'card mt2' }, [
    el('h3', { text: 'After flashing' }),
    el('ol', { class: 'steps-list' }, [
      el('li', { text: 'Disconnect the board from the computer and power it from a 5V supply.' }),
      el('li', { text: 'Join the Wi-Fi network arsin_print_server (password arsin1234) - a setup wizard opens automatically.' }),
      el('li', { text: 'Pick your office Wi-Fi, set the printer language and press Save; the bridge reconnects by itself forever.' }),
      el('li', { text: 'Open http://arsin_print_server.local any time from the same network.' })
    ])
  ]);
  host.append(after);
}

function buildInstructions() {
  const board = state.board;
  const env = state.app.firmware.env || 'esp32';
  const variant = state.app.firmware.variant || 'wifi';
  const lines = [];
  if (board.family === 'esp8266') {
    lines.push('arduino-cli core install esp8266:esp8266');
    lines.push(`arduino-cli compile -b ${board.tool.fqbn} -e firmware/arsin_print_server_esp8266 \\`);
    lines.push(`  --build-property build.extra_flags="-DARSIN_VARIANT_WIFI"`);
    lines.push(`arduino-cli upload -p /dev/ttyUSB0 -b ${board.tool.fqbn} firmware/arsin_print_server_esp8266`);
  } else if (env === 'rpi') {
    lines.push('curl -fsSL https://raw.githubusercontent.com/ArsinShaabani/Printer_middleware/main/firmware/raspberrypi/install.sh | sudo bash');
  } else {
    lines.push('arduino-cli core install esp32:esp32');
    lines.push(`arduino-cli compile -b ${board.tool.fqbn} -e firmware/arsin_print_server \\`);
    lines.push(`  --build-property build.extra_flags="-DARSIN_VARIANT_${variant.toUpperCase()}"`);
    lines.push(`arduino-cli upload -p /dev/ttyACM0 -b ${board.tool.fqbn} firmware/arsin_print_server`);
  }
  return el('details', { class: 'mt2' }, [
    el('summary', { text: t('install.flash.manual') }),
    el('pre', { text: lines.join('\n') }),
    el('p', { class: 'small muted', text: 'The GitHub Actions workflow builds every board/variant pair and publishes the manifests used by this page.' })
  ]);
}

function piInstructions() {
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'spread' }, [el('h3', { text: t('install.flash.sdcard') }), el('span', { class: 'badge brand', text: state.board.name })]),
    el('ol', { class: 'steps-list' }, [
      el('li', { html: 'Flash <strong>' + esc(state.board.tool.image) + '</strong> with Raspberry Pi Imager. In the advanced options set the hostname, Wi-Fi and SSH.' }),
      el('li', { text: 'Boot the Pi and connect over SSH (or a monitor + keyboard).' }),
      el('li', { html: 'Run the installer: <code>curl -fsSL https://raw.githubusercontent.com/ArsinShaabani/Printer_middleware/main/firmware/raspberrypi/install.sh | sudo bash</code>' }),
      el('li', { text: 'Open http://arsin_print_server.local and follow the first-run wizard (printer detection, drivers, sharing).' })
    ])
  ]);
  card.append(el('div', { class: 'callout info' }, [
    el('strong', { text: 'Why the Pi?' }),
    el('p', { class: 'small mb0', text: 'Printers that need a real driver (inkjets, lasers, GDI units) work through CUPS. The Arsin web app, label designer and maintenance console are installed on top.' })
  ]));
  card.append(buildInstructions());
  return card;
}

/* --------------------------------------------------------- step 6: configure */

function renderConfigure() {
  const host = $('#configure-panel');
  host.innerHTML = '';
  const saved = store.get('session', {}) || {};

  const card = el('div', { class: 'card' }, [
    el('div', { class: 'spread' }, [
      el('h3', { text: t('install.config.title') }),
      el('span', { class: 'badge', id: 'conn-state', text: t('device.offline') })
    ]),
    el('p', { class: 'small', text: t('install.config.hint') })
  ]);

  const hostInput = el('input', { type: 'text', value: saved.host || 'arsin_print_server.local', placeholder: 'arsin_print_server.local', spellcheck: 'false' });
  const keyInput = el('input', { type: 'password', value: saved.apiKey || '', placeholder: t('device.apikey'), autocomplete: 'off' });
  const stateBadge = () => $('#conn-state');

  card.append(el('div', { class: 'grid cols-2' }, [
    el('div', { class: 'field' }, [el('label', { text: t('device.host') }), hostInput, el('div', { class: 'hint', text: t('device.host.hint') })]),
    el('div', { class: 'field' }, [el('label', { text: t('device.apikey') }), keyInput])
  ]));

  const testBtn = el('button', { class: 'primary', text: t('action.test') });
  const dashBtn = el('a', { class: 'btn', href: 'troubleshoot.html', text: t('nav.troubleshoot') });
  card.append(el('div', { class: 'row mt1' }, [testBtn, dashBtn]));

  const detail = el('div', { class: 'mt2' });
  card.append(detail);

  testBtn.addEventListener('click', async () => {
    const host2 = normalizeBase(hostInput.value);
    store.set('session', { host: host2, apiKey: keyInput.value });
    state.device = new Device(host2, keyInput.value);
    testBtn.disabled = true;
    stateBadge().textContent = '...';
    try {
      await state.device.health();
      state.info = await state.device.info();
      stateBadge().textContent = t('device.online');
      stateBadge().className = 'badge ok';
      toast(t('device.online') + ': ' + (state.info.device || 'device'), 'ok');
      detail.innerHTML = '';
      detail.append(el('dl', { class: 'kv' }, [
        el('dt', { text: 'Device' }), el('dd', { text: state.info.device || '' }),
        el('dt', { text: 'Application' }), el('dd', { text: state.info.app || '' }),
        el('dt', { text: 'Board' }), el('dd', { text: state.info.board || '' }),
        el('dt', { text: 'Version' }), el('dd', { text: (state.info.version || '') + ' (' + (state.info.build || '') + ')' }),
        el('dt', { text: 'Address' }), el('dd', { text: (state.info.ip || '') + ' / ' + (state.info.mdns || '') }),
        el('dt', { text: 'Transport' }), el('dd', { text: state.info.transport || '' })
      ]));
      detail.append(quickConfig());
    } catch (e) {
      stateBadge().textContent = t('device.offline');
      stateBadge().className = 'badge danger';
      detail.innerHTML = '';
      detail.append(el('div', { class: 'callout danger', html: '<strong>Could not reach the device.</strong><p class="small mb0">' + esc(e.message) + '</p><p class="small mb0">Check that you joined the arsin_print_server Wi-Fi or that the board is on your network, and that the address is right.</p>' }));
    } finally {
      testBtn.disabled = false;
    }
  });

  host.append(card);
}

function quickConfig() {
  const wrap = el('div', { class: 'mt2' });
  const ssidInput = el('input', { type: 'text', placeholder: 'Office Wi-Fi name' });
  const passInput = el('input', { type: 'password', placeholder: 'Wi-Fi password', autocomplete: 'off' });
  const langSelect = el('select');
  for (const l of LANGUAGES) langSelect.append(el('option', { value: l.id, text: l.name + ' - ' + l.vendor }));
  const testPrintBtn = el('button', { class: 'primary', text: t('action.print') });
  const saveWifiBtn = el('button', { text: t('action.save') });

  const grid = el('div', { class: 'grid cols-2' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Join a Wi-Fi network (keeps reconnecting forever)' }), ssidInput]),
    el('div', { class: 'field' }, [el('label', { text: 'Wi-Fi password' }), passInput]),
    el('div', { class: 'field' }, [el('label', { text: t('designer.language') }), langSelect]),
    el('div', { class: 'field' }, [el('label', { text: 'Test' }), el('div', { class: 'row tight' }, [testPrintBtn])])
  ]);
  wrap.append(el('h4', { text: 'Quick setup' }), grid, el('div', { class: 'row mt1' }, [saveWifiBtn]));

  saveWifiBtn.addEventListener('click', async () => {
    if (!state.device) return;
    try {
      saveWifiBtn.disabled = true;
      await state.device.joinWifi(ssidInput.value.trim(), passInput.value, true);
      const cfg = await state.device.getConfig();
      cfg.printer.language = langSelect.value;
      cfg.sta.ssid = ssidInput.value.trim();
      cfg.sta.enabled = true;
      await state.device.setConfig(cfg);
      toast('Wi-Fi saved - the bridge will reconnect automatically', 'ok');
    } catch (e) {
      toast('Save failed: ' + e.message, 'danger');
    } finally {
      saveWifiBtn.disabled = false;
    }
  });

  testPrintBtn.addEventListener('click', async () => {
    if (!state.device) return;
    try {
      testPrintBtn.disabled = true;
      await state.device.sendCommand(langSelect.value, 'selftest', {});
      toast('Self test sent to the printer', 'ok');
    } catch (e) {
      toast('Print failed: ' + e.message, 'danger');
    } finally {
      testPrintBtn.disabled = false;
    }
  });
  return wrap;
}

/* ------------------------------------------------------- custom board dialog */

function openAddBoard() {
  const ta = el('textarea', { rows: 14, spellcheck: 'false', placeholder: '{\n  "id": "my-board",\n  "name": "My board",\n  "family": "esp32",\n  "pins": { "uartTx": "GPIO 17", "uartRx": "GPIO 16", "gnd": "GND" },\n  "radios": { "wifi": true }\n}' });
  const file = el('input', { type: 'file', accept: '.json,application/json' });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (f) ta.value = await f.text();
  });
  const existing = el('div', { class: 'mt2' });
  const list = getCustomBoards();
  if (list.length) {
    existing.append(el('h4', { text: 'Your boards' }));
    for (const b of list) {
      existing.append(el('div', { class: 'row spread' }, [
        el('span', { text: b.name + ' (' + b.id + ')' }),
        el('button', { class: 'btn small danger', text: t('action.delete'), onclick: () => { removeCustomBoard(b.id); modal.close(); openAddBoard(); } })
      ]));
    }
  }
  const body = el('div', {}, [
    el('p', { class: 'small', text: t('custom.board.hint') }),
    ta, file, existing,
    el('p', { class: 'small muted', text: t('custom.board.saved') })
  ]);
  const modal = openModal({
    title: t('custom.board.add'),
    body,
    actions: [
      { label: t('action.cancel'), class: 'ghost' },
      {
        label: t('action.save'),
        class: 'primary',
        onClick: (close) => {
          try {
            const board = parseCustomBoard(ta.value);
            saveCustomBoard(board);
            close();
            toast('Board added: ' + board.name, 'ok');
            loadCatalog(true).then((c) => {
              state.catalog = c;
              renderBoards();
            });
          } catch (e) {
            toast(e.message, 'danger', 6000);
          }
        }
      }
    ]
  });
}

/* ------------------------------------------------------------------- boot */

function wireStaticUi() {
  wireWiringButtons();
  $('#board-search').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    renderBoards();
  });
  $('#only-compatible').addEventListener('change', (e) => {
    state.onlyCompatible = e.target.checked;
    renderBoards();
  });
  $('#add-board').addEventListener('click', openAddBoard);
}

(async function boot() {
  try {
    state.catalog = await loadCatalog();
    wireStaticUi();
    renderApps();
    const params = new URLSearchParams(location.search);
    const wantedApp = params.get('app');
    const wantedBoard = params.get('board');
    const last = store.get('lastSelection', null);
    const appId = (wantedApp && appById(state.catalog, wantedApp) ? wantedApp : null) || (last && appById(state.catalog, last.app) ? last.app : null);
    if (appId) {
      chooseApp(appId);
      if (last && last.transport && state.app.transports.some((x) => x.id === last.transport)) chooseTransport(last.transport);
      const boardId = wantedBoard || (last && boardById(state.catalog, last.board) ? last.board : null);
      if (boardId && boardById(state.catalog, boardId)) chooseBoard(boardId);
    }
  } catch (e) {
    document.getElementById('app-list').innerHTML = '<div class="callout danger">Could not load the catalog: ' + esc(e.message) + '</div>';
  }
})();
