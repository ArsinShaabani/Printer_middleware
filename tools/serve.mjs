#!/usr/bin/env node
/**
 * Arsin Print Server - dependency-free static preview server.
 *
 * Serves the repository root over HTTP so the pages can be opened locally
 * (`npm run serve`, then http://localhost:8080). Only node:http, node:fs and
 * node:path are used - no third-party packages.
 *
 * Usage: node tools/serve.mjs [--port 8080] [--root .] [--host 127.0.0.1]
 * The PORT environment variable is used when --port is not given.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = '0.0.0.0';
export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Content types for every file type the preview site uses. */
export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm'
};

/** MIME type for a file name (defaults to a binary stream). */
export function mimeType(filePath) {
  return MIME_TYPES[extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

/**
 * Map a request URL onto a file inside `root`.
 * Returns { path, size, mtime } for a servable file, { redirect } for a
 * directory that needs a trailing slash, or { status, reason } when the request
 * must be refused. Paths outside `root` are always refused.
 */
export async function resolveRequestPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch (e) {
    return { status: 400, reason: 'Malformed URL' };
  }
  const relative = normalize(pathname).replace(/^([/\\])+/, '');
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    return { status: 403, reason: 'Path outside the served root' };
  }
  let info;
  try {
    info = await stat(target);
  } catch (e) {
    return { status: 404, reason: 'Not found' };
  }
  if (info.isDirectory()) {
    if (!pathname.endsWith('/')) return { redirect: pathname + '/' };
    const index = join(target, 'index.html');
    try {
      const indexInfo = await stat(index);
      if (indexInfo.isFile()) return { path: index, size: indexInfo.size, mtime: indexInfo.mtime };
    } catch (e) {
      /* no index.html - fall through to 404 */
    }
    return { status: 404, reason: 'No index.html in this directory' };
  }
  if (!info.isFile()) return { status: 404, reason: 'Not a file' };
  return { path: target, size: info.size, mtime: info.mtime };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

/** Build the static file server. Exported so tests can listen on port 0. */
export function createStaticServer({ root = REPO_ROOT, log = () => {} } = {}) {
  const servedRoot = resolve(root);
  return createServer(async (req, res) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    let result;
    try {
      result = await resolveRequestPath(servedRoot, req.url || '/');
    } catch (e) {
      send(res, 500, `500 ${e.message}\n`);
      return;
    }
    if (result.redirect) {
      res.writeHead(301, { Location: result.redirect, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (result.status) {
      log(`${method} ${req.url} -> ${result.status} ${result.reason}`);
      send(res, result.status, `${result.status} ${result.reason}\n`);
      return;
    }
    log(`${method} ${req.url} -> 200 ${mimeType(result.path)}`);
    res.writeHead(200, {
      'Content-Type': mimeType(result.path),
      'Content-Length': result.size,
      'Last-Modified': new Date(result.mtime).toUTCString(),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(result.path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

/** Start the server on the given port/host and resolve once it is listening. */
export function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, root = REPO_ROOT, log } = {}) {
  const server = createStaticServer({ root, log });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--port' || value === '-p') args.port = Number(argv[++i]);
    else if (value === '--host') args.host = argv[++i];
    else if (value === '--root') args.root = argv[++i];
    else if (value.startsWith('--port=')) args.port = Number(value.slice(7));
    else if (value.startsWith('--host=')) args.host = value.slice(7);
    else if (value.startsWith('--root=')) args.root = value.slice(7);
  }
  return args;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('serve.mjs');
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.PORT || DEFAULT_PORT);
  const host = args.host || process.env.HOST || DEFAULT_HOST;
  const root = args.root || REPO_ROOT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Invalid port: ${args.port || process.env.PORT}`);
    process.exit(1);
  }
  const server = await startServer({ port, host, root, log: (line) => console.log(line) });
  console.log('Arsin Print Server preview');
  console.log(`  root:  ${resolve(root)}`);
  console.log(`  url:   http://localhost:${server.address().port}/`);
  console.log('  pages: index.html  install.html  designer.html  troubleshoot.html  docs.html');
  console.log('Press Ctrl+C to stop.');
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

