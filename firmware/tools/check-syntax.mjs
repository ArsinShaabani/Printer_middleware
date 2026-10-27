#!/usr/bin/env node
/**
 * Arsin Print Server - firmware syntax check.
 *
 * `check-sources.mjs` can only see balanced braces and resolvable includes; it
 * cannot see a C++ type error. That gap is how three real compile errors
 * (`add(int)` ambiguity, a missing include and a uint16_t/uint32_t reference
 * mismatch) reached CI with every local check green.
 *
 * This script compiles the *core-independent* translation units - the ones that
 * only need <Arduino.h> - with the local C++ compiler against a tiny Arduino
 * stub. Files that need a real core header (WiFi.h, WebServer.h, USB, FS, ...)
 * are skipped, because only the Arduino toolchain can resolve those.
 *
 * Usage: node firmware/tools/check-syntax.mjs [--verbose]
 */
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const firmwareRoot = join(here, '..');
const verbose = process.argv.includes('--verbose');

/** Headers a plain host compiler can provide (or that the stub provides). */
const HOST_HEADERS = new Set([
  'Arduino.h', 'stdio.h', 'stdlib.h', 'string.h', 'strings.h', 'stdint.h', 'stddef.h',
  'stdbool.h', 'stdarg.h', 'math.h', 'ctype.h', 'time.h', 'limits.h', 'inttypes.h',
  'new', 'algorithm', 'vector'
]);

/** A tiny Arduino.h so the pure logic files can be parsed without a core. */
const ARDUINO_STUB = `#pragma once
/* Minimal Arduino.h stub for host-side syntax checking only. */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
typedef uint8_t byte;
typedef bool boolean;
static inline unsigned long millis() { return 0; }
static inline unsigned long micros() { return 0; }
static inline void delay(unsigned long) {}
static inline void yield() {}
static inline void pinMode(int, int) {}
static inline void digitalWrite(int, int) {}
#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define INPUT 0
#define PROGMEM

/* Enough of the serial API for the log/console sources to type-check. */
class ArsinStubSerial {
 public:
  void begin(unsigned long) {}
  void begin(unsigned long, int) {}
  int available() { return 0; }
  int read() { return -1; }
  size_t write(uint8_t) { return 1; }
  size_t write(const uint8_t*, size_t n) { return n; }
  void flush() {}
  void print(const char*) {}
  void print(int) {}
  void print(unsigned int) {}
  void println(const char*) {}
  void println() {}
  void println(int) {}
  void printf(const char*, ...) {}
};
static ArsinStubSerial Serial;
`;

function compiler() {
  for (const candidate of [process.env.CXX, 'g++', 'clang++', 'c++']) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function walkFiles(dir, pattern) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'build') continue;
      out.push(...walkFiles(full, pattern));
    } else if (pattern.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function sources(dir) {
  return walkFiles(dir, /\.(cpp|cc|cxx)$/);
}

/** True when every angle-bracket include of a file can be resolved on the host. */
function isCoreIndependent(text) {
  for (const m of text.matchAll(/^\s*#\s*include\s+<([^>]+)>/gm)) {
    if (!HOST_HEADERS.has(m[1])) return false;
  }
  return true;
}

const cxx = compiler();
if (!cxx) {
  console.log('note: no C++ compiler available, skipping the firmware syntax check');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'arsin-syntax-'));
writeFileSync(join(work, 'Arduino.h'), ARDUINO_STUB);

const sketches = readdirSync(firmwareRoot)
  .map((entry) => join(firmwareRoot, entry))
  .filter((full) => statSync(full).isDirectory() && !/^\.|tools$|raspberrypi$/.test(full.split('/').pop()));

const problems = [];
let checked = 0;
let skipped = 0;

for (const sketch of sketches) {
  for (const file of sources(sketch)) {
    const text = readFileSync(file, 'utf8');
    const label = relative(firmwareRoot, file);
    if (!isCoreIndependent(text)) {
      skipped += 1;
      if (verbose) console.log(`skip ${label} (needs a core header)`);
      continue;
    }
    try {
      execFileSync(cxx, ['-std=c++17', '-fsyntax-only', '-Wall', '-fpermissive', '-I', work, '-I', sketch, file], { stdio: 'pipe' });
      checked += 1;
      if (verbose) console.log(`ok   ${label}`);
    } catch (e) {
      const output = String(e.stderr || e.stdout || e.message || '')
        .split('\n')
        .filter((line) => /error:/.test(line))
        .slice(0, 6)
        .join('\n');
      problems.push(`${label}:\n${output || '(no error text)'}`);
    }
  }
}

/* ------------------------------------------------------- arity checking */

/**
 * Parse the parameter list of every function the sketch declares itself, then
 * count the arguments at every call site. A missing argument (for example a
 * forgotten `sizeof(note)`) is a hard compile error that no brace checker can
 * see, and it only shows up in CI.
 */
function declaredArities(sketch) {
  const arities = new Map();
  for (const file of walkFiles(sketch, /\.h$/)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^[A-Za-z_][\w:<>\s*&]*\b(arsin\w+)\s*\(([^;{)]*)\)\s*;/gm)) {
      const params = m[2].trim();
      if (params === 'void' || params === '') {
        arities.set(m[1], 0);
        continue;
      }
      arities.set(m[1], splitArgs(params).length);
    }
  }
  return arities;
}

/** Split an argument list on top-level commas (ignores nesting and strings). */
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === '\\') {
        current += text[++i] || '';
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function checkArities(sketch) {
  const arities = declaredArities(sketch);
  const problems = [];
  for (const file of sources(sketch)) {
    if (file.endsWith('.h')) continue;
    const text = readFileSync(file, 'utf8');
    for (const [name, expected] of arities) {
      const re = new RegExp(`(?<![\\w.>])${name}\\s*\\(`, 'g');
      for (const m of text.matchAll(re)) {
        // Skip the definition itself (`... name(...) {`).
        const from = m.index + m[0].length;
        let depth = 1;
        let i = from;
        let quote = null;
        for (; i < text.length && depth > 0; i++) {
          const c = text[i];
          if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
          }
          if (c === '"' || c === "'") quote = c;
          else if (c === '(') depth++;
          else if (c === ')') depth--;
        }
        if (depth !== 0) continue; // unbalanced - do not guess
        const args = text.slice(from, i - 1);
        const after = text.slice(i, i + 40);
        if (/^\s*\{/.test(after)) continue; // this is the definition
        const count = args.trim() === '' ? 0 : splitArgs(args).length;
        if (count !== expected) {
          const line = text.slice(0, m.index).split('\n').length;
          problems.push(`${relative(firmwareRoot, file)}:${line}: ${name}() takes ${expected} argument(s) but is called with ${count}`);
        }
      }
    }
  }
  return problems;
}

for (const sketch of sketches) {
  const arityProblems = checkArities(sketch);
  for (const problem of arityProblems) problems.push(problem);
}

for (const problem of problems) console.log(`error: ${problem}`);
if (problems.length) {
  console.log(`FAILED: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`OK: ${checked} core-independent firmware file(s) compile (${skipped} need the Arduino core, skipped)`);
