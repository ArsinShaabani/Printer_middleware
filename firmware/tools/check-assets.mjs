#!/usr/bin/env node
/**
 * Arsin Print Server - static web-asset table check.
 *
 * The sketches embed the whole control panel as a generated C header
 * (web_assets.h) and fall back to web_assets_builtin.h when that header has not
 * been generated yet. Both tables must agree with the `WebAsset` struct and with
 * the aggregate initialiser in arsin_assets.cpp, otherwise a bare
 * `arduino-cli compile` of this repository fails - which is exactly the failure
 * mode that keeps a release without firmware binaries.
 *
 * When a C++ compiler is available the table is compiled for real (both the
 * generated and the fallback configuration, for both sketches). Without a
 * compiler the structural facts are still asserted.
 *
 * Usage: node firmware/tools/check-assets.mjs
 */
import { mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const firmwareRoot = join(here, '..');
const SKETCHES = ['arsin_print_server', 'arsin_print_server_esp8266'];
const problems = [];
const notes = [];

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

const cxx = compiler();

for (const sketch of SKETCHES) {
  const dir = join(firmwareRoot, sketch);
  const builtin = join(dir, 'web_assets_builtin.h');
  const assetsCpp = join(dir, 'arsin_assets.cpp');
  const generated = join(dir, 'web_assets.h');

  if (!existsSync(builtin)) problems.push(`${sketch}: web_assets_builtin.h is missing (a bare compile cannot fall back)`);
  if (!existsSync(assetsCpp)) {
    problems.push(`${sketch}: arsin_assets.cpp is missing`);
    continue;
  }
  if (!existsSync(builtin)) continue;

  const builtinText = readFileSync(builtin, 'utf8');
  const cppText = readFileSync(assetsCpp, 'utf8');
  for (const field of ['path', 'mime', 'data', 'len', 'originalLen', 'gz']) {
    if (!builtinText.includes(field)) problems.push(`${sketch}/web_assets_builtin.h: the WebAsset struct has no "${field}" member`);
  }
  const initialisers = (cppText.match(/\{"[^"]*", "[^"]*",[^}]*\}/g) || []).length;
  if (!initialisers) problems.push(`${sketch}/arsin_assets.cpp: no fallback asset initialiser found`);

  if (!cxx) {
    notes.push(`${sketch}: no C++ compiler available, skipped the compile check`);
    continue;
  }

  const work = mkdtempSync(join(tmpdir(), 'arsin-assets-'));
  try {
    for (const [label, withGenerated] of [['fallback', false], ['generated', true]]) {
      const target = join(work, `${sketch}-${label}`);
      writeFileSync(join(work, '.keep'), '');
      execFileSync('mkdir', ['-p', target]);
      copyFileSync(join(dir, 'arsin_assets.h'), join(target, 'arsin_assets.h'));
      copyFileSync(assetsCpp, join(target, 'arsin_assets.cpp'));
      if (withGenerated) {
        if (!existsSync(generated)) continue;
        copyFileSync(generated, join(target, 'web_assets.h'));
      } else {
        copyFileSync(builtin, join(target, 'web_assets_builtin.h'));
      }
      try {
        execFileSync(cxx, ['-std=c++17', '-Wall', '-Werror', '-c', 'arsin_assets.cpp', '-o', join(target, 'assets.o')], {
          cwd: target,
          stdio: 'pipe'
        });
      } catch (e) {
        const out = String((e.stderr || e.stdout || e.message) || '').split('\n').slice(0, 8).join('\n');
        problems.push(`${sketch} (${label} asset table) does not compile:\n${out}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

for (const note of notes) console.log(`note: ${note}`);
for (const problem of problems) console.log(`error: ${problem}`);
if (problems.length) {
  console.log(`FAILED: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`OK: the embedded asset tables are consistent (${cxx ? `compiled with ${cxx}` : 'structure only'})`);
