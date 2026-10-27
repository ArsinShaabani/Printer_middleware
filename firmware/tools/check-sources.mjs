#!/usr/bin/env node
/**
 * Arsin Print Server - firmware source sanity checker.
 *
 * There is no C++ compiler in the review environment, so this script performs
 * the structural checks that catch the mistakes a brace checker can see:
 *
 *   1. balanced (), {}, [] per file (strings, char literals and comments are
 *      skipped, so '{' inside a string never confuses the count)
 *   2. balanced #if / #ifdef / #ifndef ... #endif and no stray #else / #elif
 *   3. every `#include "local.h"` resolves inside the same sketch folder
 *   4. duplicate file scope definitions of the same function inside one sketch
 *      (a guaranteed link error on Arduino)
 *   5. the files that must stay identical between the ESP32 and the ESP8266
 *      sketch (see firmware/README.md) really are identical
 *   6. every local header is included by at least one translation unit
 *
 * Usage: node firmware/tools/check-sources.mjs [--verbose]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const firmwareRoot = join(here, '..');
const verbose = process.argv.includes('--verbose');

/** Files that are shared verbatim between the two Arduino sketches. */
const SHARED_FILES = [
  'arsin_assets.cpp',
  'arsin_assets.h',
  'arsin_bt.cpp',
  'arsin_bt.h',
  'arsin_commands.cpp',
  'arsin_commands.h',
  'arsin_config.cpp',
  'arsin_config.h',
  'arsin_json.cpp',
  'arsin_json.h',
  'arsin_log.cpp',
  'arsin_log.h',
  'arsin_net.cpp',
  'arsin_net.h',
  'arsin_printer.cpp',
  'arsin_printer.h',
  'arsin_store.cpp',
  'arsin_store.h',
  'arsin_version.h',
  'arsin_web.cpp',
  'arsin_web.h',
  'web_assets_builtin.h',
];

const SOURCE_EXT = /\.(ino|cpp|h|hpp|cc)$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'build' || entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

/** Strip comments, string literals and char literals, keeping line structure. */
function stripLiterals(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let inLine = false;
  let inBlock = false;
  let inString = false;
  let inChar = false;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += '\n';
      } else {
        out += ' ';
      }
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

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

const problems = [];
const warnings = [];
const stats = { files: 0, lines: 0 };

function report(kind, file, line, message) {
  const entry = `${relative(firmwareRoot, file)}:${line}: ${message}`;
  if (kind === 'error') problems.push(entry);
  else warnings.push(entry);
}

const PAIRS = { '(': ')', '{': '}', '[': ']' };
const CLOSERS = { ')': '(', '}': '{', ']': '[' };

function checkBalance(file, code) {
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (PAIRS[c]) {
      stack.push({ c, line: lineOf(code, i) });
    } else if (CLOSERS[c]) {
      const top = stack.pop();
      if (!top) {
        report('error', file, lineOf(code, i), `unbalanced '${c}'`);
        return false;
      }
      if (top.c !== CLOSERS[c]) {
        report('error', file, lineOf(code, i), `'${c}' closes '${top.c}' opened on line ${top.line}`);
        return false;
      }
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    report('error', file, top.line, `unclosed '${top.c}'`);
    return false;
  }
  return true;
}

function checkPreprocessor(file, original) {
  const lines = original.split('\n');
  let depth = 0;
  let ok = true;
  lines.forEach((line, index) => {
    const m = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b/.exec(line);
    if (!m) return;
    const directive = m[1];
    if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') depth++;
    if (directive === 'elif' || directive === 'else') {
      if (depth === 0) {
        report('error', file, index + 1, `#${directive} without #if`);
        ok = false;
      }
    }
    if (directive === 'endif') {
      depth--;
      if (depth < 0) {
        report('error', file, index + 1, '#endif without #if');
        depth = 0;
        ok = false;
      }
    }
  });
  if (depth !== 0) {
    report('error', file, lines.length, `${depth} unterminated #if block(s)`);
    ok = false;
  }
  return ok;
}

function checkIncludes(file, original, filesInDir) {
  const lines = original.split('\n');
  lines.forEach((line, index) => {
    const m = /^\s*#\s*include\s+"([^"]+)"/.exec(line);
    if (!m) return;
    const target = m[1];
    if (target.includes('/')) return; /* toolchain header quoted by mistake? not our file */
    if (filesInDir.has(target)) return;
    if (target.startsWith('web_assets')) {
      /* generated at build time - the fallback header must be present instead */
      if (filesInDir.has('web_assets_builtin.h')) return;
    }
    report('error', file, index + 1, `#include "${target}" does not exist in this sketch folder`);
  });
}

const DEFINITION_RE = /^([A-Za-z_][\w:<>,\s\*&]*?)\b([A-Za-z_]\w*)\s*\(([^;{]*)\)\s*\{/;
const NOT_A_DEFINITION = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'defined']);

function checkDuplicateDefinitions(file, original, seen) {
  const lines = original.split('\n');
  let conditional = 0; /* how many #if blocks are open at this point */
  lines.forEach((line, index) => {
    if (/^\s*#\s*(if|ifdef|ifndef)\b/.test(line)) conditional++;
    else if (/^\s*#\s*endif\b/.test(line)) conditional = Math.max(0, conditional - 1);
    if (/^\s/.test(line)) return; /* only file scope definitions (column 0) */
    const m = DEFINITION_RE.exec(line);
    if (!m) return;
    const name = m[2];
    if (NOT_A_DEFINITION.has(name)) return;
    const previous = seen.get(name);
    if (previous && previous.file !== file) {
      const message = `duplicate definition of '${name}' (already in ${relative(firmwareRoot, previous.file)}:${previous.line})`;
      if (conditional > 0 && previous.conditional > 0) {
        /* Both copies sit in #if blocks - usually complementary (a real
         * implementation vs. a stub) but the guards must be exact. */
        warnings.push(`${file}:${index + 1}: ${message} - both are inside #if blocks, verify the guards are mutually exclusive`);
      } else {
        report('error', file, index + 1, message);
      }
      return;
    }
    if (!previous) seen.set(name, { file, line: index + 1, conditional });
  });
}

const sketches = [];
for (const entry of readdirSync(firmwareRoot)) {
  const full = join(firmwareRoot, entry);
  if (!statSync(full).isDirectory()) continue;
  if (entry.startsWith('.') || entry === 'tools' || entry === 'raspberrypi') continue;
  sketches.push(full);
}
sketches.sort();

for (const sketch of sketches) {
  const files = walk(sketch);
  const inoFiles = files.filter((f) => f.endsWith('.ino'));
  if (inoFiles.length !== 1) {
    problems.push(`${relative(firmwareRoot, sketch)}: expected exactly one .ino, found ${inoFiles.length}`);
  }
  const namesInDir = new Set(files.map((f) => f.split('/').pop()));
  const definitions = new Map();
  const includedHeaders = new Set();

  for (const file of files) {
    const original = readFileSync(file, 'utf8');
    stats.files++;
    stats.lines += original.split('\n').length;
    checkBalance(file, stripLiterals(original));
    checkPreprocessor(file, original);
    checkIncludes(file, original, namesInDir);
    checkDuplicateDefinitions(file, original, definitions);
    for (const m of original.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) includedHeaders.add(m[1]);
  }

  /* A function the sketch declares in its own header but never defines is a
   * link error (undefined reference) - only the linker used to catch it. */
  const declared = new Map();
  const defined = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.h')) {
      for (const m of text.matchAll(/^\s*(?:extern\s+)?[A-Za-z_][\w:<>,\s\*&]*?\b(arsin\w+|config\w+|printer\w+|store\w+|web\w+|net\w+)\s*\(([^;{]*)\)\s*;/gm)) {
        declared.set(m[1], file);
      }
    } else {
      /* signatures may span several lines */
      for (const m of text.matchAll(/^([A-Za-z_][\w:<>,\s\*&]*?)\b([A-Za-z_]\w*)\s*\(([^;{)]*)\)\s*\{/gm)) {
        if (!NOT_A_DEFINITION.has(m[2])) defined.add(m[2]);
      }
    }
  }
  for (const [name, file] of declared) {
    if (!defined.has(name)) {
      problems.push(`${relative(firmwareRoot, file)}: '${name}' is declared but never defined (link error)`);
    }
  }

  for (const file of files) {
    const base = file.split('/').pop();
    if (!base.endsWith('.h')) continue;
    if (base === 'web_assets_builtin.h' || base === 'web_assets.h') continue; /* conditionally included */
    if (!includedHeaders.has(base)) {
      warnings.push(`${relative(firmwareRoot, sketch)}/${base}: header is never included`);
    }
  }

  if (verbose) console.log(`${relative(firmwareRoot, sketch)}: ${files.length} source file(s) checked`);
}

/* shared file sync between the two Arduino sketches */
if (sketches.length >= 2) {
  const [esp32Sketch, esp8266Sketch] = sketches;
  for (const name of SHARED_FILES) {
    let aText = null;
    let bText = null;
    try {
      aText = readFileSync(join(esp32Sketch, name), 'utf8');
    } catch {
      /* absent */
    }
    try {
      bText = readFileSync(join(esp8266Sketch, name), 'utf8');
    } catch {
      /* absent */
    }
    if (aText === null && bText === null) {
      warnings.push(`shared file ${name} is missing from both sketches`);
    } else if (aText === null || bText === null) {
      problems.push(`shared file ${name} exists in only one sketch`);
    } else if (aText !== bText) {
      problems.push(`shared file ${name} differs between the ESP32 and ESP8266 sketches`);
    }
  }
}

console.log(`checked ${stats.files} source file(s), ${stats.lines} line(s) in ${sketches.length} sketch folder(s)`);
for (const w of warnings) console.log(`warning: ${w}`);
for (const p of problems) console.log(`error: ${p}`);
if (problems.length) {
  console.log(`FAILED: ${problems.length} problem(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`OK: no structural problems (${warnings.length} warning(s))`);
