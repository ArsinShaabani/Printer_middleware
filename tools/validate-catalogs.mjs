#!/usr/bin/env node
/**
 * Arsin Print Server - standalone catalog validator.
 *
 * Validates data/boards.json and data/apps.json against the schema the rest of
 * the project relies on, checks that every wiring reference resolves, that every
 * application can actually be built on at least one board, and (when the
 * manifests exist) that they match the catalogs.
 *
 * Usage: node tools/validate-catalogs.mjs [--json]
 * Exit code: 0 when the catalogs are valid, 1 when there is at least one error.
 *
 * manifests/index.json is optional: a fresh clone that has not run
 * `npm run build` yet must still validate cleanly.
 */
import { readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_SCHEMA, BOARD_ROLES, normalizeCatalog, mergeCatalogs, compatibility, resolveWiring, resolveRef, manifestPath
} from '../assets/js/core/catalog.js';
import { LANGUAGES } from '../assets/js/core/commands.js';

const ROOT = process.env.ARSIN_CATALOG_ROOT
  ? resolve(process.env.ARSIN_CATALOG_ROOT)
  : join(dirname(fileURLToPath(import.meta.url)), '..');
const RADIOS = ['wifi', 'ble', 'btClassic', 'usbHost', 'ethernet', 'thread'];
const ESP_FAMILIES = ['esp32', 'esp8266'];
const LANGUAGE_IDS = new Set(LANGUAGES.map((l) => l.id));
/**
 * Transport "languages" that are not printer command languages: the Raspberry Pi
 * CUPS bridge also offers the CUPS/PPD driver path, which the firmware drives
 * through cupsd instead of emitting ESC/POS or ZPL bytes.
 */
const EXTRA_TRANSPORT_LANGS = new Set(['cups']);

const report = { errors: [], warnings: [], notes: [], stats: {} };
const error = (message) => report.errors.push(message);
const warn = (message) => report.warnings.push(message);
const note = (message) => report.notes.push(message);

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (e) {
    return false;
  }
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/* ------------------------------------------------------------- schema checks */

function checkFamilies(families) {
  const ids = families.map((f) => f.id);
  if (new Set(ids).size !== ids.length) error('duplicate family ids');
  for (const family of families) {
    if (!isNonEmptyString(family.id) || !isNonEmptyString(family.name)) error(`family "${family.id}": needs an id and a name`);
    if (!isNonEmptyString(family.toolchain)) error(`family "${family.id}": needs a toolchain`);
    if (!isNonEmptyString(family.flash)) error(`family "${family.id}": needs a flash strategy`);
  }
  return ids;
}

function checkBoards(boardsJson, familyIds) {
  const ids = boardsJson.boards.map((b) => b.id);
  if (new Set(ids).size !== ids.length) error(`duplicate board ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);

  for (const raw of boardsJson.boards) {
    const id = raw.id;
    if (!isNonEmptyString(id)) {
      error('a board has no id');
      continue;
    }
    for (const field of ['name', 'vendor', 'family', 'mcu', 'arch']) {
      if (!isNonEmptyString(raw[field])) error(`board "${id}": missing ${field}`);
    }
    if (!familyIds.includes(raw.family)) error(`board "${id}": unknown family "${raw.family}"`);
    if (!Array.isArray(raw.tags) || !raw.tags.length) error(`board "${id}": needs at least one tag`);
    if (!Array.isArray(raw.notes) || !raw.notes.length) error(`board "${id}": needs at least one note`);

    const tool = raw.tool;
    if (!isPlainObject(tool)) error(`board "${id}": missing tool metadata`);
    else {
      if (!isNonEmptyString(tool.kind)) error(`board "${id}": tool.kind is required`);
      if (ESP_FAMILIES.includes(raw.family)) {
        if (!/^(esp32|esp8266):(esp32|esp8266):[a-z0-9_]+$/.test(String(tool.fqbn || ''))) error(`board "${id}": invalid FQBN "${tool.fqbn}"`);
        if (!isNonEmptyString(tool.chipFamily)) error(`board "${id}": chipFamily is required for ${raw.family}`);
      }
      if (raw.family === 'rpi') {
        if (!isNonEmptyString(tool.image)) error(`board "${id}": Raspberry Pi boards need an SD-card image`);
        if (!isNonEmptyString(tool.installer)) error(`board "${id}": Raspberry Pi boards need an installer path`);
      }
    }

    if (!isPlainObject(raw.pins) || !Object.keys(raw.pins).length) error(`board "${id}": pins are required`);
    else {
      for (const [role, value] of Object.entries(raw.pins)) {
        if (!BOARD_ROLES.includes(role)) error(`board "${id}": pin role "${role}" is not one of ${BOARD_ROLES.join(', ')}`);
        if (!isNonEmptyString(value)) error(`board "${id}": pin "${role}" is empty`);
      }
      for (const role of ['uartTx', 'uartRx', 'gnd']) {
        if (!raw.pins[role]) error(`board "${id}": missing required pin role "${role}"`);
      }
    }

    if (!isPlainObject(raw.radios)) error(`board "${id}": radios are required`);
    else {
      for (const radio of RADIOS) {
        if (typeof raw.radios[radio] !== 'boolean') error(`board "${id}": radios.${radio} must be a boolean`);
      }
      if (raw.radios.wifi !== true) error(`board "${id}": every supported board needs Wi-Fi`);
      for (const key of Object.keys(raw.radios)) {
        if (!RADIOS.includes(key)) warn(`board "${id}": unknown radio flag "${key}"`);
      }
    }

    if (!isPlainObject(raw.io) || !isNonEmptyString(raw.io.logicVoltage)) error(`board "${id}": io.logicVoltage is required`);
    if (!isPlainObject(raw.power)) error(`board "${id}": power budget is required`);
    else {
      if (!isNonEmptyString(raw.power.input)) error(`board "${id}": power.input is required`);
      if (!(Number(raw.power.typicalMa) > 0)) error(`board "${id}": power.typicalMa must be positive`);
      if (!(Number(raw.power.maxMa) >= Number(raw.power.typicalMa))) error(`board "${id}": power.maxMa must be >= typicalMa`);
    }
    if (!isPlainObject(raw.usb) || !isNonEmptyString(raw.usb.port)) error(`board "${id}": usb.port is required`);
  }
}


function checkApps(appsJson) {
  const ids = appsJson.apps.map((a) => a.id);
  if (new Set(ids).size !== ids.length) error(`duplicate app ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);

  for (const raw of appsJson.apps) {
    const id = raw.id;
    if (!isNonEmptyString(id)) {
      error('an app has no id');
      continue;
    }
    for (const field of ['name', 'tagline', 'summary', 'category']) {
      if (!isNonEmptyString(raw[field])) error(`app "${id}": missing ${field}`);
    }
    for (const list of ['capabilities', 'features', 'requirements']) {
      if (!Array.isArray(raw[list]) || !raw[list].length) error(`app "${id}": ${list} must be a non-empty array`);
    }
    if (!isPlainObject(raw.firmware)) error(`app "${id}": firmware metadata is required`);
    else {
      if (!['esp32', 'esp8266', 'rpi'].includes(raw.firmware.env)) error(`app "${id}": firmware.env "${raw.firmware.env}" is not supported`);
      if (!isNonEmptyString(raw.firmware.variant)) error(`app "${id}": firmware.variant is required`);
    }
    if (!isPlainObject(raw.requires)) error(`app "${id}": requires is required`);
    else {
      if (!Array.isArray(raw.requires.families) || !raw.requires.families.length) error(`app "${id}": requires.families must list at least one family`);
      for (const radio of raw.requires.radios || []) {
        if (!RADIOS.includes(radio)) error(`app "${id}": unknown required radio "${radio}"`);
      }
    }

    if (!Array.isArray(raw.transports) || !raw.transports.length) {
      error(`app "${id}": at least one transport is required`);
      continue;
    }
    if (raw.transports.filter((t) => t.default).length > 1) error(`app "${id}": only one transport may be the default`);
    for (const transport of raw.transports) {
      if (!isNonEmptyString(transport.id)) {
        error(`app "${id}": a transport has no id`);
        continue;
      }
      for (const field of ['name', 'description']) {
        if (!isNonEmptyString(transport[field])) error(`app "${id}/${transport.id}": missing ${field}`);
      }
      if (!Array.isArray(transport.langs) || !transport.langs.length) error(`app "${id}/${transport.id}": langs must be a non-empty array`);
      for (const lang of transport.langs || []) {
        if (!LANGUAGE_IDS.has(lang) && !EXTRA_TRANSPORT_LANGS.has(lang)) warn(`app "${id}/${transport.id}": unknown printer language "${lang}"`);
      }
      const recipe = (raw.wiring || {})[transport.id];
      if (!isPlainObject(recipe)) {
        error(`app "${id}/${transport.id}": no wiring recipe`);
        continue;
      }
      for (const field of ['title', 'summary']) {
        if (!isNonEmptyString(recipe[field])) error(`app "${id}/${transport.id}": recipe needs ${field}`);
      }
      for (const list of ['links', 'cables', 'steps', 'warnings', 'prerequisites']) {
        if (!Array.isArray(recipe[list])) error(`app "${id}/${transport.id}": recipe.${list} must be an array`);
      }
      if (!Array.isArray(recipe.steps) || !recipe.steps.length) error(`app "${id}/${transport.id}": the recipe needs at least one step`);
      for (const link of recipe.links || []) {
        if (!isNonEmptyString(link.signal)) error(`app "${id}/${transport.id}": a wiring link has no signal`);
        if (!isNonEmptyString(link.board)) error(`app "${id}/${transport.id}": a wiring link has no board reference`);
        if (!isNonEmptyString(link.printer)) error(`app "${id}/${transport.id}": a wiring link has no printer reference`);
      }
    }
    // Recipes for transports the app does not declare are dead weight.
    for (const key of Object.keys(raw.wiring || {})) {
      if (!raw.transports.some((t) => t.id === key)) warn(`app "${id}": wiring recipe "${key}" has no matching transport`);
    }
  }
}


/* ------------------------------------------------------ cross-catalog checks */

function checkReferences(catalog) {
  const roles = new Set();
  for (const app of catalog.apps) {
    for (const recipe of Object.values(app.wiring)) {
      for (const link of recipe.links || []) {
        const match = /^@([A-Za-z0-9_]+)$/.exec(String(link.board || '').trim());
        if (match) roles.add(match[1]);
      }
    }
  }
  for (const role of [...roles].sort()) {
    if (!BOARD_ROLES.includes(role)) error(`wiring reference @${role} is not a declared board role`);
    if (!catalog.boards.some((b) => resolveRef(`@${role}`, b).ok)) error(`wiring reference @${role} resolves on no board`);
  }

  for (const app of catalog.apps) {
    for (const transport of app.transports) {
      const buildable = catalog.boards.filter((board) => {
        const wiring = resolveWiring(board, app, transport.id);
        return wiring && wiring.missing.length === 0;
      });
      if (!buildable.length) error(`app "${app.id}"/${transport.id}: no board can satisfy the wiring recipe`);
    }
    if (!catalog.boards.some((board) => compatibility(board, app).ok)) error(`app "${app.id}": no board is compatible`);
  }

  for (const board of catalog.boards) {
    if (!catalog.apps.some((app) => compatibility(board, app).ok)) error(`board "${board.id}": no application is compatible`);
  }
}

function checkCompatibilitySanity(catalog) {
  const byId = (id) => catalog.boards.find((b) => b.id === id);
  const appById = (id) => catalog.apps.find((a) => a.id === id);
  const expect = (boardId, appId, ok) => {
    const board = byId(boardId);
    const app = appById(appId);
    if (!board || !app) return;
    const result = compatibility(board, app);
    if (result.ok !== ok) {
      error(`compatibility sanity: ${boardId} vs ${appId} should be ${ok ? 'compatible' : 'incompatible'} (got ${result.ok}: ${result.blockers.join('; ') || 'no blockers'})`);
    }
  };
  for (const board of catalog.boards.filter((b) => b.family === 'esp8266')) {
    for (const appId of ['print-server-bt-spp', 'print-server-usbhost']) {
      if (appById(appId)) expect(board.id, appId, false);
    }
  }
  for (const board of catalog.boards.filter((b) => b.radios.usbHost)) expect(board.id, 'print-server-usbhost', true);
  for (const board of catalog.boards.filter((b) => b.family === 'rpi')) expect(board.id, 'print-server-cups', true);
  for (const board of catalog.boards) expect(board.id, 'print-server-wifi', board.radios.wifi === true);
}

/* ----------------------------------------------------------- manifest checks */

async function checkManifests(catalog) {
  const indexPath = join(ROOT, 'manifests/index.json');
  if (!(await exists(indexPath))) {
    note('manifests/index.json is not present - run `npm run build` to generate the installer manifests (not an error).');
    return;
  }
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch (e) {
    error(`manifests/index.json is not valid JSON: ${e.message}`);
    return;
  }
  if (!Array.isArray(index.builds)) {
    error('manifests/index.json: builds must be an array');
    return;
  }
  const expected = new Set();
  for (const app of catalog.apps) {
    for (const board of catalog.boards) {
      if (board.family === 'rpi') continue; // Raspberry Pi uses the SD-card installer
      if (!compatibility(board, app).ok) continue;
      expected.add(`${app.id}|${board.id}`);
    }
  }
  const seen = new Set();
  for (const build of index.builds) {
    const key = `${build.app}|${build.board}`;
    seen.add(key);
    if (!expected.has(key)) error(`manifests/index.json lists an unexpected build ${key}`);
    const board = catalog.boards.find((b) => b.id === build.board);
    const app = catalog.apps.find((a) => a.id === build.app);
    if (board && app) {
      if (build.manifest !== manifestPath(app, board)) error(`manifests/index.json: ${key} points at "${build.manifest}" instead of "${manifestPath(app, board)}"`);
      if (build.fqbn !== board.tool.fqbn) error(`manifests/index.json: ${key} records FQBN "${build.fqbn}" instead of "${board.tool.fqbn}"`);
      if (build.variant !== app.firmware.variant) error(`manifests/index.json: ${key} records variant "${build.variant}" instead of "${app.firmware.variant}"`);
    }
    if (build.available && !(await exists(join(ROOT, 'firmware-bin', build.board, build.variant)))) {
      warn(`manifests/index.json marks ${key} available but firmware-bin/${build.board}/${build.variant} does not exist`);
    }
    if (!(await exists(join(ROOT, build.manifest || '')))) error(`manifests/index.json references a missing manifest file: ${build.manifest}`);
  }
  for (const key of expected) {
    if (!seen.has(key)) error(`manifests/index.json is missing the build ${key} (re-run \`npm run build\`)`);
  }
  const available = index.builds.filter((b) => b.available).length;
  note(`manifests/index.json: ${index.builds.length} builds, ${available} with binaries present.`);
}

/* ---------------------------------------------------------------------- main */

export async function validateCatalogs() {
  report.errors = [];
  report.warnings = [];
  report.notes = [];
  report.stats = {};

  let boardsJson;
  let appsJson;
  try {
    boardsJson = JSON.parse(await readFile(join(ROOT, 'data/boards.json'), 'utf8'));
  } catch (e) {
    error(`data/boards.json could not be read: ${e.message}`);
    return report;
  }
  try {
    appsJson = JSON.parse(await readFile(join(ROOT, 'data/apps.json'), 'utf8'));
  } catch (e) {
    error(`data/apps.json could not be read: ${e.message}`);
    return report;
  }

  if (boardsJson.schema !== CATALOG_SCHEMA) error(`data/boards.json: schema should be ${CATALOG_SCHEMA}`);
  if (appsJson.schema !== CATALOG_SCHEMA) error(`data/apps.json: schema should be ${CATALOG_SCHEMA}`);
  if (!Array.isArray(boardsJson.boards) || !boardsJson.boards.length) error('data/boards.json: boards must be a non-empty array');
  if (!Array.isArray(boardsJson.families) || !boardsJson.families.length) error('data/boards.json: families must be a non-empty array');
  if (!Array.isArray(appsJson.apps) || !appsJson.apps.length) error('data/apps.json: apps must be a non-empty array');

  if (!report.errors.length) {
    const familyIds = checkFamilies(boardsJson.families);
    checkBoards(boardsJson, familyIds);
    checkApps(appsJson);
  }

  let catalog = null;
  if (!report.errors.length) {
    try {
      catalog = mergeCatalogs(boardsJson, appsJson);
      normalizeCatalog(catalog); // throws when a record is unusable
    } catch (e) {
      error(`normalising the catalogs failed: ${e.message}`);
    }
  }
  if (catalog && !report.errors.length) {
    checkReferences(catalog);
    checkCompatibilitySanity(catalog);
    await checkManifests(catalog);
    const pairs = catalog.apps.reduce((sum, app) => sum + catalog.boards.filter((b) => compatibility(b, app).ok).length, 0);
    report.stats = {
      boards: catalog.boards.length,
      apps: catalog.apps.length,
      families: new Set(catalog.boards.map((b) => b.family)).size,
      languages: LANGUAGE_IDS.size,
      compatiblePairs: pairs
    };
  }
  return report;
}

export function formatReport(result) {
  const line = '-'.repeat(72);
  const lines = [`Arsin Print Server - catalog validation`, line];
  if (result.stats.boards) {
    lines.push(
      `boards: ${result.stats.boards}  apps: ${result.stats.apps}  families: ${result.stats.families}  ` +
        `languages: ${result.stats.languages}  compatible (app, board) pairs: ${result.stats.compatiblePairs}`
    );
  }
  for (const message of result.notes) lines.push(`note:  ${message}`);
  for (const message of result.warnings) lines.push(`warn:  ${message}`);
  for (const message of result.errors) lines.push(`error: ${message}`);
  lines.push(line);
  lines.push(`${result.errors.length} error(s), ${result.warnings.length} warning(s), ${result.notes.length} note(s)`);
  lines.push(result.errors.length ? 'CATALOGS INVALID' : 'CATALOGS OK');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('validate-catalogs.mjs');
if (invokedDirectly) {
  const result = await validateCatalogs();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...result, ok: result.errors.length === 0 }, null, 2));
  } else {
    console.log(formatReport(result));
  }
  process.exit(result.errors.length ? 1 : 0);
}


