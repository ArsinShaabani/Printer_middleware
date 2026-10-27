/**
 * i18n coverage: every key referenced by a page or a controller must exist in
 * both dictionaries, and the two dictionaries must define the same keys. This is
 * what keeps the Persian UI from showing raw "designer.presets" style keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES = ['index.html', 'install.html', 'designer.html', 'troubleshoot.html', 'docs.html'];

/** Parse the DICT literal of assets/js/ui/i18n.js into { en: Set, fa: Set }. */
function dictionary() {
  const text = readFileSync(join(ROOT, 'assets/js/ui/i18n.js'), 'utf8');
  const enAt = text.indexOf('  en: {');
  const faAt = text.indexOf('  fa: {');
  assert.ok(enAt > 0 && faAt > enAt, 'the dictionary must define an en and a fa block');
  const keysIn = (from, to) => {
    const block = text.slice(from, to);
    return new Set([...block.matchAll(/^\s{4}'([^']+)':/gm)].map((m) => m[1]));
  };
  return { en: keysIn(enAt, faAt), fa: keysIn(faAt, text.indexOf('\n};', faAt)) };
}

/** Keys referenced from the HTML pages. */
function htmlKeys() {
  const keys = new Map();
  for (const page of PAGES) {
    const text = readFileSync(join(ROOT, page), 'utf8');
    for (const m of text.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) {
      if (!keys.has(m[1])) keys.set(m[1], page);
    }
    for (const m of text.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(';')) {
        const key = pair.split('=')[1];
        if (key && !keys.has(key.trim())) keys.set(key.trim(), page);
      }
    }
  }
  return keys;
}

/** Literal t('key') calls in the controllers (fallback strings are allowed). */
function scriptKeys() {
  const dir = join(ROOT, 'assets/js/ui');
  const keys = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    for (const m of text.matchAll(/\bt\('([a-z0-9.]+)'\s*,/g)) {
      if (!keys.has(m[1])) keys.set(m[1], `assets/js/ui/${file}`);
    }
  }
  return keys;
}

test('the English and Persian dictionaries define exactly the same keys', () => {
  const { en, fa } = dictionary();
  const missingInFa = [...en].filter((k) => !fa.has(k));
  const missingInEn = [...fa].filter((k) => !en.has(k));
  assert.deepEqual(missingInFa, [], 'keys present in en but missing in fa');
  assert.deepEqual(missingInEn, [], 'keys present in fa but missing in en');
  assert.ok(en.size > 200, `the dictionary should be substantial (got ${en.size} keys)`);
});

test('every key used by a page exists in both dictionaries', () => {
  const { en, fa } = dictionary();
  const missing = [];
  for (const [key, where] of [...htmlKeys(), ...scriptKeys()]) {
    if (!en.has(key) || !fa.has(key)) missing.push(`${key} (used in ${where})`);
  }
  assert.deepEqual(missing, [], 'untranslated keys');
});

test('every maintenance action and group has a translation in both languages', async () => {
  const { en, fa } = dictionary();
  const { ACTIONS, LANGUAGES, actionsForLanguage } = await import('../assets/js/core/commands.js');
  const missing = [];
  for (const action of ACTIONS) {
    for (const key of [`maint.action.${action.id}`, `maint.action.${action.id}.desc`]) {
      if (!en.has(key)) missing.push(`${key} (en)`);
      if (!fa.has(key)) missing.push(`${key} (fa)`);
    }
  }
  for (const group of [...new Set(ACTIONS.map((a) => a.group))]) {
    const key = `maint.group.${group}`;
    if (!en.has(key)) missing.push(`${key} (en)`);
    if (!fa.has(key)) missing.push(`${key} (fa)`);
  }
  // The confidence badge is rendered from the per-language action list.
  const confidences = new Set();
  for (const lang of LANGUAGES) for (const action of actionsForLanguage(lang.id)) if (action.confidence) confidences.add(action.confidence);
  assert.ok(confidences.size >= 2, 'the language definitions report a confidence level');
  for (const confidence of confidences) {
    const key = `common.confidence.${confidence}`;
    if (!en.has(key) || !fa.has(key)) missing.push(`${key}`);
  }
  assert.deepEqual(missing, [], 'untranslated maintenance strings');
});

test('the pages declare a Persian-capable font stack and RTL-safe layout', () => {
  const css = readFileSync(join(ROOT, 'assets/css/app.css'), 'utf8');
  assert.match(css, /--sans:[^;]*Vazirmatn/, 'the sans stack prefers Vazirmatn');
  for (const page of PAGES) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    assert.match(html, /fonts\.googleapis\.com[^"]*Vazirmatn/, `${page} loads the Vazirmatn webfont`);
  }
});
