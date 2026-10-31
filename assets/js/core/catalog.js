/**
 * Arsin Print Server - catalog core (pure, no DOM, no network).
 *
 * Loads and normalises the board / app catalogs, resolves wiring references
 * against a concrete board, and computes compatibility between a board and an
 * application. Everything here is side-effect free so it can be unit tested in
 * Node and reused by the build tooling.
 */

export const CATALOG_SCHEMA = 1;

/** Roles a wiring link may reference on the board side. */
export const BOARD_ROLES = [
  'uartTx', 'uartRx', 'uartTxAlt', 'uartRxAlt',
  'usbDp', 'usbDm', 'usb5v', 'usbGnd',
  'v5', 'v3v3', 'gnd', 'led', 'btn', 'spare1', 'spare2'
];

/** Reference syntax used inside wiring link definitions. */
const REF_RE = /^@([A-Za-z0-9_]+)$/;

/** Normalise a board record, filling optional fields with safe defaults. */
export function normalizeBoard(raw) {
  const b = { ...raw };
  b.id = String(b.id || '').trim();
  if (!b.id) throw new Error('board.id is required');
  b.name = b.name || b.id;
  b.vendor = b.vendor || 'Unknown';
  b.family = b.family || 'custom';
  b.mcu = b.mcu || 'Unknown MCU';
  b.arch = b.arch || '';
  b.tags = arr(b.tags);
  b.notes = arr(b.notes);
  b.roles = arr(b.roles);
  b.radios = { wifi: false, ble: false, btClassic: false, usbHost: false, ethernet: false, thread: false, ...(b.radios || {}) };
  b.pins = { ...(b.pins || {}) };
  b.io = { logicVoltage: '3.3V', ...(b.io || {}) };
  b.power = { input: 'USB 5V', typicalMa: 250, maxMa: 600, ...(b.power || {}) };
  b.usb = { port: 'USB', chip: 'on-board bridge', note: '', ...(b.usb || {}) };
  b.tool = b.tool || { kind: 'esp-web-tools', chipFamily: 'ESP32' };
  b.source = b.source || 'builtin';
  return b;
}

/** Normalise an application (firmware) record. */
export function normalizeApp(raw) {
  const a = { ...raw };
  a.id = String(a.id || '').trim();
  if (!a.id) throw new Error('app.id is required');
  a.name = a.name || a.id;
  a.tagline = a.tagline || '';
  a.summary = a.summary || '';
  a.category = a.category || 'printer-bridge';
  a.capabilities = arr(a.capabilities);
  a.features = arr(a.features);
  a.requirements = arr(a.requirements);
  a.ports = arr(a.ports);
  a.transports = arr(a.transports).map((t) => ({
    id: t.id,
    name: t.name || t.id,
    description: t.description || '',
    default: !!t.default,
    langs: arr(t.langs)
  }));
  if (!a.transports.length) {
    a.transports = [{ id: 'serial', name: 'UART / COM port', description: '', default: true, langs: [] }];
  }
  a.requires = { families: [], radios: [], excludeBoards: [], excludeApp: [], ...(a.requires || {}) };
  a.wiring = a.wiring || {};
  a.firmware = { env: a.id, variant: a.id, assets: 'web', ...(a.firmware || {}) };
  a.source = a.source || 'builtin';
  return a;
}

export function normalizeCatalog(json) {
  const boards = arr(json && json.boards).map(normalizeBoard);
  const apps = arr(json && json.apps).map(normalizeApp);
  return { schema: json && json.schema ? json.schema : CATALOG_SCHEMA, boards, apps };
}

/** Merge a user supplied catalog over the built-in one (custom boards win). */
export function mergeCatalogs(base, ...extra) {
  const out = normalizeCatalog(base || {});
  for (const e of extra) {
    if (!e) continue;
    const n = normalizeCatalog(e);
    for (const b of n.boards) upsert(out.boards, b);
    for (const a of n.apps) upsert(out.apps, a);
  }
  return out;
}

function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = { ...list[i], ...item };
  else list.push(item);
}

/** Resolve a wiring reference ("@uartTx", "@5V", "GPIO 4") against a board. */
export function resolveRef(ref, board) {
  if (typeof ref !== 'string') return { ok: false, value: '', reason: 'invalid reference' };
  const m = REF_RE.exec(ref.trim());
  if (!m) return { ok: true, value: ref, role: null, literal: true };
  const role = m[1];
  const value = board && board.pins ? board.pins[role] : undefined;
  if (!value) return { ok: false, value: '', role, reason: `board "${board && board.id}" has no pin mapped for role "${role}"` };
  return { ok: true, value, role, literal: false };
}

/** Compute every wiring link for one (board, app, transport) combination. */
export function resolveWiring(board, app, transportId) {
  const recipe = pickRecipe(app, transportId);
  if (!recipe) return null;
  const links = [];
  const warnings = [];
  const missing = [];
  for (const raw of arr(recipe.links)) {
    const boardRef = resolveRef(raw.board, board);
    const printerRef = resolveRef(raw.printer, board);
    const link = {
      signal: raw.signal || '',
      board: boardRef.ok ? boardRef.value : raw.board,
      boardRole: boardRef.role || null,
      printer: printerRef.ok ? printerRef.value : raw.printer,
      cable: raw.cable || 'Jumper wire',
      required: raw.required !== false,
      note: raw.note || ''
    };
    if (!boardRef.ok) {
      link.unresolved = true;
      link.reason = boardRef.reason;
      if (link.required) missing.push(boardRef.reason);
      else warnings.push(`${link.signal}: ${boardRef.reason}`);
    }
    if (!printerRef.ok) {
      link.unresolvedPrinter = true;
      link.printer = raw.printer;
      warnings.push(`${link.signal}: ${printerRef.reason}`);
    }
    links.push(link);
  }
  return {
    transportId,
    title: recipe.title || `${app.name} - ${transportId}`,
    summary: recipe.summary || '',
    links,
    steps: arr(recipe.steps),
    warnings,
    missing,
    power: recipe.power || '',
    cables: arr(recipe.cables),
    diagram: recipe.diagram || null,
    prerequisites: arr(recipe.prerequisites)
  };
}

function pickRecipe(app, transportId) {
  const w = app.wiring || {};
  if (transportId && w[transportId]) return w[transportId];
  const t = app.transports.find((x) => x.default) || app.transports[0];
  if (t && w[t.id]) return w[t.id];
  const first = Object.keys(w)[0];
  return first ? w[first] : null;
}

/**
 * Compatibility between a board and an app.
 * @returns {{ok: boolean, blockers: string[], warnings: string[], transports: string[]}}
 */
export function compatibility(board, app, transportId) {
  const blockers = [];
  const warnings = [];
  const req = app.requires || {};
  if (arr(req.families).length && !req.families.includes(board.family)) {
    blockers.push(`App needs board family: ${req.families.join(' / ')} (this board is "${board.family}")`);
  }
  if (arr(req.excludeBoards).includes(board.id)) blockers.push(req.excludeReason || 'This board is explicitly excluded by the app.');
  if (arr(req.excludeApp).includes(app.id)) blockers.push('This app is not available for this board.');
  for (const radio of arr(req.radios)) {
    if (!board.radios[radio]) blockers.push(`Board has no ${radioLabel(radio)} radio.`);
  }
  for (const cap of arr(req.capabilities)) {
    if (!board.capabilities || !board.capabilities.includes(cap)) {
      warnings.push(`Board does not advertise capability "${cap}".`);
    }
  }
  const t = transportId || ((app.transports.find((x) => x.default) || app.transports[0]) || {}).id;
  const w = resolveWiring(board, app, t);
  if (w && w.missing.length) blockers.push(...w.missing);
  if (w && w.warnings.length) warnings.push(...w.warnings);
  if (w && !w.links.length) warnings.push('No wiring recipe defined for the selected transport.');
  return { ok: blockers.length === 0, blockers, warnings, transports: app.transports.map((x) => x.id) };
}

function radioLabel(r) {
  return { wifi: 'Wi-Fi', ble: 'Bluetooth LE', btClassic: 'Bluetooth Classic', usbHost: 'USB host', ethernet: 'Ethernet', thread: 'Thread' }[r] || r;
}

/** Apps available for a board (compatible first, then name). */
export function appsForBoard(catalog, boardId) {
  const board = catalog.boards.find((b) => b.id === boardId);
  if (!board) return [];
  return catalog.apps
    .map((app) => ({ app, compat: compatibility(board, app) }))
    .filter((x) => x.compat.ok)
    .sort((a, b) => a.app.name.localeCompare(b.app.name));
}

/** Boards available for an app (compatible first, then name). */
export function boardsForApp(catalog, appId) {
  const app = catalog.apps.find((a) => a.id === appId);
  if (!app) return [];
  return catalog.boards
    .map((board) => ({ board, compat: compatibility(board, app) }))
    .sort((a, b) => Number(b.compat.ok) - Number(a.compat.ok) || a.board.name.localeCompare(b.board.name));
}

/** Where the browser installer expects the firmware manifest of a build. */
export function manifestPath(app, board) {
  return `manifests/${app.id}/${board.id}.json`;
}

/** Which flashing strategy a board needs. */
export function flashKind(board) {
  return (board.tool && board.tool.kind) || 'esp-web-tools';
}

export function boardById(catalog, id) {
  return catalog.boards.find((b) => b.id === id) || null;
}

export function appById(catalog, id) {
  return catalog.apps.find((a) => a.id === id) || null;
}

/** Group a board list by family for rendering. */
export function groupByFamily(boards) {
  const order = ['esp32', 'esp8266', 'rpi', 'custom'];
  const map = new Map();
  for (const b of boards) {
    if (!map.has(b.family)) map.set(b.family, []);
    map.get(b.family).push(b);
  }
  return [...map.entries()]
    .sort((a, b) => idx(order, a[0]) - idx(order, b[0]))
    .map(([family, items]) => ({ family, items: items.sort((x, y) => x.name.localeCompare(y.name)) }));
}

function idx(list, v) {
  const i = list.indexOf(v);
  return i < 0 ? list.length : i;
}

export function arr(v) {
  return Array.isArray(v) ? v : [];
}
