/**
 * Tooling integration tests: the standalone catalog validator and the static
 * preview server are part of the deliverable, so they get tested too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createStaticServer, mimeType, resolveRequestPath, REPO_ROOT, DEFAULT_PORT } from '../tools/serve.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Run the validator and return { code, stdout, stderr }. */
async function validate(env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['tools/validate-catalogs.mjs'], { cwd: ROOT, env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('npm run validate passes on the committed catalogs and reports a summary', async () => {
  const result = await validate();
  assert.equal(result.code, 0, `validator exited ${result.code}: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /catalog validation/);
  assert.match(result.stdout, /boards: 15 {2}apps: 7/);
  assert.match(result.stdout, /0 error\(s\)/);
  assert.match(result.stdout, /CATALOGS OK/);
  assert.ok(!/CATALOGS INVALID/.test(result.stdout));
});

test('the validator also runs in --json mode', async () => {
  const { stdout } = await run(process.execPath, ['tools/validate-catalogs.mjs', '--json'], { cwd: ROOT });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.stats.boards, 15);
  assert.equal(parsed.stats.apps, 7);
  assert.ok(parsed.stats.compatiblePairs > 0);
});

test('a fresh clone without manifests/index.json still validates cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arsin-validate-'));
  try {
    await mkdir(join(dir, 'data'), { recursive: true });
    await copyFile(join(ROOT, 'data/boards.json'), join(dir, 'data/boards.json'));
    await copyFile(join(ROOT, 'data/apps.json'), join(dir, 'data/apps.json'));
    const result = await validate({ ARSIN_CATALOG_ROOT: dir });
    assert.equal(result.code, 0, `validator exited ${result.code}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /manifests\/index\.json is not present/);
    assert.match(result.stdout, /CATALOGS OK/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the validator fails (exit 1) when a catalog is broken', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arsin-validate-bad-'));
  try {
    await mkdir(join(dir, 'data'), { recursive: true });
    const boards = JSON.parse(await readFile(join(ROOT, 'data/boards.json'), 'utf8'));
    boards.boards[0].pins.uartTx = '';
    boards.boards[0].radios.wifi = false;
    await writeFile(join(dir, 'data/boards.json'), JSON.stringify(boards));
    await copyFile(join(ROOT, 'data/apps.json'), join(dir, 'data/apps.json'));
    const result = await validate({ ARSIN_CATALOG_ROOT: dir });
    assert.equal(result.code, 1, 'a broken catalog must fail the validator');
    assert.match(result.stdout, /error: board "esp32-devkit-v1": pin "uartTx" is empty/);
    assert.match(result.stdout, /CATALOGS INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- firmware static checks ---- */

test('the firmware sources pass the structural checks', async () => {
  const { stdout } = await run(process.execPath, ['firmware/tools/check-sources.mjs'], { cwd: ROOT });
  assert.match(stdout, /OK: no structural problems/, stdout);
});

test('the embedded web-asset tables are consistent for both sketches', async () => {
  const { stdout } = await run(process.execPath, ['firmware/tools/check-assets.mjs'], { cwd: ROOT });
  assert.match(stdout, /OK: the embedded asset tables are consistent/, stdout);
});

test('the firmware streams large /api/print bodies instead of buffering them', async () => {
  const { stdout } = await run(process.execPath, ['firmware/tools/check-print-streaming.mjs'], { cwd: ROOT });
  assert.match(stdout, /OK: \/api\/print streams/, stdout);
});

test('the shipped web-asset bundle embeds the designer, the maintenance console and the docs', async () => {
  const { buildAssets } = await import('../tools/build-web-assets.mjs');
  const assets = await buildAssets();
  const paths = assets.map((a) => a.path);
  for (const needed of [
    '/index.html',
    '/install.html',
    '/designer.html',
    '/troubleshoot.html',
    '/docs.html',
    '/assets/js/ui/designer.js',
    '/assets/js/ui/troubleshoot.js',
    '/assets/js/ui/docs.js',
    '/assets/css/app.css',
    '/data/boards.json',
    '/data/apps.json'
  ]) {
    assert.ok(paths.includes(needed), `the device bundle must embed ${needed}`);
  }
  const mini = await buildAssets({ min: true });
  const miniPaths = mini.map((a) => a.path);
  for (const needed of ['/designer.html', '/assets/js/ui/designer.js', '/troubleshoot.html', '/assets/js/ui/troubleshoot.js']) {
    assert.ok(miniPaths.includes(needed), `the ESP8266 bundle must embed ${needed}`);
  }
});

test('every asset a device page references is embedded, so nothing 404s on the board', async () => {
  const { buildAssets } = await import('../tools/build-web-assets.mjs');
  const assets = await buildAssets();
  const paths = new Set(assets.map((a) => a.path));
  const missing = [];
  for (const asset of assets) {
    if (!asset.path.endsWith('.html')) continue;
    const html = readFileSync(join(ROOT, asset.path.replace(/^\//, '')), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:|data:|mailto:|#)/i.test(url)) continue;
      const clean = url.split(/[?#]/)[0].replace(/^\.\//, '');
      if (!clean || clean.endsWith('/')) continue;
      const target = '/' + clean;
      if (!paths.has(target)) missing.push(`${asset.path} -> ${url}`);
    }
  }
  assert.deepEqual(missing, [], 'pages reference assets that are not embedded in the firmware');
});

test('the CI workflows stay valid and keep the ESP board-manager URLs', async () => {
  const dir = join(ROOT, 'ci/github-workflows');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
  assert.ok(files.length >= 3, 'the canonical workflow set is present');
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.ok(!/\t/.test(text), `${file}: YAML must not contain tab characters`);
    assert.match(text, /^name:\s*\S/m, `${file}: needs a workflow name`);
    assert.match(text, /^on:\s*$/m, `${file}: needs a trigger block`);
    assert.match(text, /^jobs:\s*$/m, `${file}: needs a jobs block`);
  }

  // The firmware workflows must register the ESP board-manager URLs before any
  // core is installed - without it every compile is skipped and no firmware
  // binary is ever produced.
  for (const file of ['deploy-pages.yml', 'build-firmware.yml']) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.match(text, /board_manager\.additional_urls/, `${file}: must register the board-manager URLs`);
    assert.match(text, /espressif\.github\.io\/arduino-esp32\/package_esp32_index\.json/, `${file}: ESP32 index URL`);
    assert.match(text, /arduino\.esp8266\.com\/stable\/package_esp8266com_index\.json/, `${file}: ESP8266 index URL`);
    const addAt = text.indexOf('arduino-cli config add board_manager.additional_urls');
    const indexAt = text.indexOf('arduino-cli core update-index');
    const installAt = text.indexOf('arduino-cli core install');
    assert.ok(addAt > 0 && indexAt > addAt && installAt > indexAt, `${file}: order must be add URLs -> update-index -> core install`);
    assert.match(text, /continue-on-error: true/, `${file}: a failed compile must not block the site`);
    assert.match(text, /node tools\/build-web-assets\.mjs/, `${file}: the embedded web assets must be built before compiling`);
  }

  const tests = readFileSync(join(dir, 'test.yml'), 'utf8');
  assert.match(tests, /npm test/, 'test.yml runs the unit tests');
  assert.match(tests, /npm run validate/, 'test.yml validates the catalogs');
});

test('the shared fallback asset header is tracked, not git-ignored', () => {
  const target = 'firmware/arsin_print_server/web_assets_builtin.h';
  let inRepo = false;
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'pipe' });
    inRepo = true;
  } catch (e) {
    inRepo = false;
  }
  if (!inRepo) return; // no git checkout - nothing to assert
  let ignored = true;
  try {
    execFileSync('git', ['check-ignore', '-q', target], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    ignored = false; // exit code 1 means "not ignored"
  }
  assert.equal(ignored, false, `${target} must not be git-ignored - a fresh clone would fail to compile the ESP32 sketch`);
  const tracked = execFileSync('git', ['ls-files', target], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(tracked, target, `${target} must be committed`);
});

/* ------------------------------------------------------------ serve.mjs ---- */

test('serve.mjs maps the documented MIME types', () => {
  assert.equal(DEFAULT_PORT, 8080);
  assert.equal(mimeType('index.html'), 'text/html; charset=utf-8');
  assert.equal(mimeType('assets/js/core/barcode.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeType('data/boards.json'), 'application/json; charset=utf-8');
  assert.equal(mimeType('assets/css/app.css'), 'text/css; charset=utf-8');
  assert.equal(mimeType('logo.svg'), 'image/svg+xml');
  assert.equal(mimeType('firmware.bin'), 'application/octet-stream');
  assert.equal(mimeType('photo.PNG'), 'image/png');
  assert.equal(mimeType('no-extension'), 'application/octet-stream');
});

test('resolveRequestPath refuses to leave the served root', async () => {
  const result = await resolveRequestPath(REPO_ROOT, '/../../etc/passwd');
  assert.notEqual(result.status, undefined);
  assert.ok(result.status === 404 || result.status === 403, `expected 404/403, got ${JSON.stringify(result)}`);
  const bad = await resolveRequestPath(REPO_ROOT, '/%00bad');
  assert.ok(bad.status === 400 || bad.status === 404);
  const file = await resolveRequestPath(REPO_ROOT, '/index.html');
  assert.equal(file.path, join(REPO_ROOT, 'index.html'));
  assert.ok(file.size > 0);
  const missing = await resolveRequestPath(REPO_ROOT, '/does-not-exist.html');
  assert.equal(missing.status, 404);
  const directory = await resolveRequestPath(REPO_ROOT, '/assets');
  assert.equal(directory.redirect, '/assets/');
});

test('the preview server serves the site with correct headers', async () => {
  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(home.headers.get('cache-control'), 'no-store');
    assert.match(await home.text(), /<title>Arsin Print Server/);

    const explicit = await fetch(`${base}/index.html`);
    assert.equal(explicit.status, 200);

    const boards = await fetch(`${base}/data/boards.json`);
    assert.equal(boards.status, 200);
    assert.equal(boards.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal((await boards.json()).boards.length, 15);

    const module = await fetch(`${base}/assets/js/core/barcode.js`);
    assert.equal(module.status, 200);
    assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(await module.text(), /export function code128/);

    const css = await fetch(`${base}/assets/css/app.css`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');

    const manifest = await fetch(`${base}/manifests/index.json`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('content-type'), 'application/json; charset=utf-8');

    const missing = await fetch(`${base}/does-not-exist.html`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /404/);

    const directory = await fetch(`${base}/assets`, { redirect: 'manual' });
    assert.equal(directory.status, 301);
    assert.equal(directory.headers.get('location'), '/assets/');

    const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 0);
    assert.equal(await head.text(), '');

    const post = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('the preview server serves .bin files and directory indexes from any root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arsin-serve-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>root</title>');
    await writeFile(join(dir, 'logo.bin'), Buffer.from([0x1b, 0x40, 0x00, 0xff]));
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub/index.html'), '<!doctype html><title>sub</title>');

    const server = createStaticServer({ root: dir });
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const bin = await fetch(`${base}/logo.bin`);
      assert.equal(bin.status, 200);
      assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
      assert.deepEqual([...new Uint8Array(await bin.arrayBuffer())], [0x1b, 0x40, 0x00, 0xff]);

      const sub = await fetch(`${base}/sub/`);
      assert.equal(sub.status, 200);
      assert.match(await sub.text(), /<title>sub<\/title>/);

      const root = await fetch(`${base}/`);
      assert.match(await root.text(), /<title>root<\/title>/);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

