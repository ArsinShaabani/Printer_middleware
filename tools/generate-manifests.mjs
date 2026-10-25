/**
 * Generate the esp-web-tools manifests (and manifests/index.json) for every
 * compatible (app, board) pair, so the browser installer knows what exists.
 *
 * Firmware binaries are produced by the GitHub Actions build; this script
 * writes the manifest files and an index used by the web app to decide whether
 * a combination can be flashed from the browser.
 *
 * Usage: node tools/generate-manifests.mjs [--check]
 */
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCatalogs, compatibility, manifestPath } from '../assets/js/core/catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** ESP32/ESP8266 flash offsets used by esp-web-tools manifests. */
function partsFor(board, variant) {
  // Manifests live in manifests/<app>/<board>.json, so two levels up is the site root.
  const base = `../../firmware-bin/${board.id}/${variant}`;
  const parts = [
    { path: `${base}/bootloader.bin`, offset: 0x0 },
    { path: `${base}/partitions.bin`, offset: 0x8000 },
    { path: `${base}/boot_app0.bin`, offset: 0xe000 },
    { path: `${base}/firmware.bin`, offset: 0x10000 }
  ];
  if (board.family === 'esp8266') {
    // ESP8266 does not use a separate boot_app0 image.
    return { parts: parts.filter((p) => !p.path.endsWith('boot_app0.bin')) };
  }
  return { parts };
}

export async function buildMatrix() {
  const boardsJson = JSON.parse(await readFile(join(ROOT, 'data/boards.json'), 'utf8'));
  const appsJson = JSON.parse(await readFile(join(ROOT, 'data/apps.json'), 'utf8'));
  const catalog = mergeCatalogs(boardsJson, appsJson);
  const builds = [];
  for (const app of catalog.apps) {
    for (const board of catalog.boards) {
      if (board.family === 'rpi') continue; // Raspberry Pi uses the SD-card installer
      const compat = compatibility(board, app);
      if (!compat.ok) continue;
      builds.push({
        app: app.id,
        board: board.id,
        family: board.family,
        chipFamily: board.tool.chipFamily,
        fqbn: board.tool.fqbn,
        variant: app.firmware.variant,
        env: app.firmware.env,
        manifest: manifestPath(app, board),
        parts: partsFor(board, app.firmware.variant).parts,
        name: `${app.name} - ${board.name}`
      });
    }
  }
  return { catalog, builds };
}

/** True when the compiled binaries for a build are present on disk. */
async function hasBinaries(build) {
  try {
    await readdir(join(ROOT, 'firmware-bin', build.board, build.variant));
    return true;
  } catch (e) {
    return false;
  }
}

export async function generate({ write = true, onlyAvailable = false } = {}) {
  const { catalog, builds } = await buildMatrix();
  const manifestDir = join(ROOT, 'manifests');
  const index = { generated: new Date().toISOString(), version: 1, builds: [], boards: catalog.boards.map((b) => b.id), apps: catalog.apps.map((a) => a.id) };
  if (write) await rm(manifestDir, { recursive: true, force: true });
  for (const build of builds) {
    const available = await hasBinaries(build);
    const manifest = {
      name: build.name,
      version: '1.0.0',
      new_install_prompt_erase: true,
      builds: [{ chipFamily: build.chipFamily, parts: build.parts.map((p) => ({ path: p.path, offset: p.offset })) }]
    };
    index.builds.push({
      app: build.app,
      board: build.board,
      family: build.family,
      chipFamily: build.chipFamily,
      fqbn: build.fqbn,
      variant: build.variant,
      manifest: build.manifest,
      available
    });
    if (write && (!onlyAvailable || available)) {
      const file = join(ROOT, build.manifest);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
    }
  }
  if (write) {
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  }
  return index;
}

async function main() {
  const check = process.argv.includes('--check');
  const index = await generate({ write: !check });
  const available = index.builds.filter((b) => b.available).length;
  console.log(`manifests: ${index.builds.length} compatible builds (${available} with binaries present)`);
  for (const b of index.builds) console.log(`  ${b.app.padEnd(24)} ${b.board.padEnd(24)} ${b.chipFamily.padEnd(10)} ${b.available ? 'binary ready' : 'needs build'}`);
  if (check) console.log('check mode: nothing written');
  else console.log('wrote manifests/index.json and one manifest per build');
  return index;
}

if (process.argv[1] && process.argv[1].endsWith('generate-manifests.mjs')) {
  main().catch((e) => {
    console.error('generate-manifests failed:', e.message);
    process.exit(1);
  });
}
