#!/usr/bin/env node
/**
 * Arsin Print Server - /api/print streaming checker.
 *
 * Companion to check-sources.mjs.  It proves the properties the streaming
 * upload fix has to keep, in both Arduino sketches, and prints the line numbers
 * of the code path so the trace can be reviewed without a compiler:
 *
 *   1. POST /api/print never buffers the whole body
 *        - handlePrint() streams from WebServer::client() via streamPrintBody()
 *        - the only body()/bodyLen() use inside handlePrint() sits in the
 *          `hasArg("plain")` fallback block, which the core only fills for a
 *          body it was allowed to buffer
 *        - nothing is ever sized from Content-Length
 *        - on arduino-esp32 core 3.x the raw-body handler - the only way to stop
 *          the core from buffering - is registered for /api/print before any
 *          other /api/print route and only claims bodies above kBodyMax
 *   2. the streaming path stays bounded: kStreamChunk <= 1024 bytes (512 on the
 *      ESP8266), the repeat spool is allocated only for copies > 1, and the raw
 *      path forwards the core's HTTP_RAW_BUFLEN slices
 *
 * Usage: node firmware/tools/check-print-streaming.mjs [--verbose]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const firmwareRoot = join(here, '..');
const verbose = process.argv.includes('--verbose');

const ESP32 = join(firmwareRoot, 'arsin_print_server', 'arsin_web.cpp');
const ESP8266 = join(firmwareRoot, 'arsin_print_server_esp8266', 'arsin_web.cpp');

const problems = [];
const trace = [];

/** Strip comments, strings and char literals, keeping every newline in place. */
function stripLiterals(text) {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inString = false;
  let inChar = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\n') inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (inString || inChar) {
      if (c === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if ((inString && c === '"') || (inChar && c === "'")) {
        inString = false;
        inChar = false;
        out += ' ';
        i++;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += ' ';
      i++;
      continue;
    }
    if (c === "'") {
      inChar = true;
      out += ' ';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** Body of the first `signature`, found with a brace scan over code whose
 *  literals and comments are blanked out (braces in strings cannot confuse it). */
function functionBody(code, stripped, signature) {
  const start = stripped.indexOf(signature);
  if (start < 0) return null;
  let depth = 0;
  let seen = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '{') {
      depth++;
      seen = true;
    } else if (c === '}') {
      depth--;
      if (seen && depth === 0) {
        return {
          start,
          end: i,
          line: lineAt(code, start),
          endLine: lineAt(code, i),
          body: code.slice(start, i + 1),
        };
      }
    }
  }
  return null;
}

function check(label, ok, detail) {
  if (!ok) problems.push(`${label}: ${detail}`);
  return ok;
}

/* --------------------------------------------------------------- shared file */

const esp32Text = readFileSync(ESP32, 'utf8');
const esp8266Text = readFileSync(ESP8266, 'utf8');
check('shared arsin_web.cpp', esp32Text === esp8266Text, 'the ESP32 and ESP8266 copies differ');

const code = stripLiterals(esp32Text);

/* -------------------------------------------------------- handlePrint() path */

const handlePrint = functionBody(esp32Text, code, 'void handlePrint() {');
if (check('handlePrint()', handlePrint !== null, 'function not found')) {
  trace.push(`arsin_web.cpp:${handlePrint.line}  handlePrint()             /api/print entry point`);

  check(
    'handlePrint() streaming',
    /g_server\.client\(\)/.test(handlePrint.body) && /streamPrintBody\(/.test(handlePrint.body),
    'handlePrint() does not read the socket through streamPrintBody()',
  );

  /* body()/bodyLen() may only be used inside the buffered fallback block.
   * The signature is matched against the stripped code, so it must not contain
   * a string literal (those are blanked out). */
  const fallback = functionBody(
    handlePrint.body,
    stripLiterals(handlePrint.body),
    'if (g_server.hasArg(',
  );
  const bodyUses = [...handlePrint.body.matchAll(/\b(body|bodyLen)\(\)/g)].map((m) => m.index);
  const outside = bodyUses.filter((i) => !fallback || i < fallback.start || i > fallback.end);
  check(
    'handlePrint() buffering',
    outside.length === 0,
    `body() is used outside the hasArg("plain") fallback (offset ${outside[0]})`,
  );
  if (fallback) {
    trace.push(`arsin_web.cpp:${handlePrint.line + fallback.line - 1}  hasArg("plain")           documented buffered fallback`);
  }

  check(
    'bounded allocation',
    !/(malloc|calloc|realloc)\s*\(\s*contentLength/.test(code) && !/\[\s*contentLength\s*\]/.test(code),
    'something is sized from contentLength',
  );
}

/* ---------------------------------------------------- streaming primitives */

const streamPrintBody = functionBody(esp32Text, code, 'bool streamPrintBody(');
if (check('streamPrintBody()', streamPrintBody !== null, 'function not found')) {
  trace.push(`arsin_web.cpp:${streamPrintBody.line}  streamPrintBody()         chunked / Content-Length / until-close loop`);
  check(
    'streamPrintBody()',
    /streamReadChunk\(client/.test(streamPrintBody.body) && /printJobPush\(/.test(streamPrintBody.body),
    'the body is not forwarded chunk by chunk',
  );
}

const printJobPush = functionBody(esp32Text, code, 'bool printJobPush(');
if (check('printJobPush()', printJobPush !== null, 'function not found')) {
  trace.push(`arsin_web.cpp:${printJobPush.line}  printJobPush()            printerWriteAll() back-pressure per chunk`);
  check(
    'printJobPush()',
    /printerWriteAll\(data, len, kPrintWriteMs\)/.test(printJobPush.body),
    'the printer queue is not driven through printerWriteAll()',
  );
}

const streamReadChunk = functionBody(esp32Text, code, 'size_t streamReadChunk(');
if (check('streamReadChunk()', streamReadChunk !== null, 'function not found')) {
  trace.push(`arsin_web.cpp:${streamReadChunk.line}  streamReadChunk()         bounded socket read (kStreamChunk)`);
  check(
    'streamReadChunk()',
    /printerLoop\(\)/.test(streamReadChunk.body) && /yield\(\)/.test(streamReadChunk.body),
    'printerLoop()/yield() are not called while waiting for the socket',
  );
}

const streamChunked = functionBody(esp32Text, code, 'bool streamChunkedBody(');
if (check('streamChunkedBody()', streamChunked !== null, 'function not found')) {
  trace.push(`arsin_web.cpp:${streamChunked.line}  streamChunkedBody()       decodes Transfer-Encoding: chunked`);
}

/* -------------------------------------------------------------- size limits */

const chunkEsp32 = /const size_t kStreamChunk = (\d+);/.exec(code);
check('kStreamChunk (ESP32)', chunkEsp32 && Number(chunkEsp32[1]) <= 1024,
  'the ESP32 socket window is not <= 1024 bytes');
const chunkEsp8266 = /ARDUINO_ARCH_ESP8266[\s\S]{0,200}?kStreamChunk = (\d+)/.exec(code);
check('kStreamChunk (ESP8266)', chunkEsp8266 && Number(chunkEsp8266[1]) === 512,
  'the ESP8266 socket window is not 512 bytes');

check(
  'repeat spool',
  /if \(g_job\.copies > 1\) \{[\s\S]{0,600}?g_job\.spool = \(uint8_t\*\)malloc\(kSpoolMax\)/.test(code),
  'the copies > 1 spool is not allocated from the bounded kSpoolMax',
);

/* -------------------------------------------------- ESP32 raw-body handler */

const rawHandler = functionBody(esp32Text, code, 'class ArsinPrintRawHandler');
if (check('ArsinPrintRawHandler', rawHandler !== null, 'handler not found')) {
  trace.push(`arsin_web.cpp:${rawHandler.line}  ArsinPrintRawHandler      keeps WebServer from buffering the body`);
  check('canRaw() gate', /requestContentLength\(server\) > \(size_t\)kBodyMax/.test(rawHandler.body),
    'canRaw() does not gate on kBodyMax');
  check(
    'canHandle() overloads',
    /canHandle\(WebServer& server, HTTPMethod method, const String& uri\) override/.test(rawHandler.body),
    'the arduino-esp32 core 3.x canHandle(WebServer&, ..) overload is missing',
  );
}

const rawBody = functionBody(esp32Text, code, 'void printRawBody(');
if (check('printRawBody()', rawBody !== null, 'function not found')) {
  trace.push(`arsin_web.cpp:${rawBody.line}  printRawBody()            forwards the core's HTTP_RAW_BUFLEN slices`);
  check('printRawBody()', /printJobPush\(raw\.buf, raw\.currentSize\)/.test(rawBody.body),
    'the raw slices are not forwarded to the printer queue');
  check('printRawBody()', /RAW_ABORTED/.test(rawBody.body), 'RAW_ABORTED is not handled');
}

/* -------------------------------------------------------------- route wiring */

const setupRoutes = functionBody(esp32Text, code, 'void setupRoutes() {');
if (check('setupRoutes()', setupRoutes !== null, 'function not found')) {
  const addIndex = setupRoutes.body.indexOf('addHandler(new ArsinPrintRawHandler())');
  const onIndex = setupRoutes.body.indexOf('on("/api/print", HTTP_POST, handlePrint)');
  check('route order', addIndex >= 0, 'ArsinPrintRawHandler is not registered');
  check('route order', onIndex < 0 || onIndex > addIndex,
    'the buffered /api/print route is registered before the raw-body handler');
  check('collected headers', /"Transfer-Encoding"/.test(setupRoutes.body),
    'Transfer-Encoding is not collected, so chunked bodies cannot be detected');
}

/* -------------------------------------------------------------------- output */

for (const line of trace) console.log(line);
console.log(`checked ${ESP32.split('/').pop()} + ${ESP8266.split('/').pop()} (${esp32Text.split('\n').length} lines each)`);
for (const p of problems) console.log(`error: ${p}`);
if (problems.length) {
  console.log(`FAILED: ${problems.length} problem(s)`);
  process.exit(1);
}
if (verbose) console.log('all /api/print streaming invariants hold');
console.log('OK: /api/print streams, no per-job buffering');
