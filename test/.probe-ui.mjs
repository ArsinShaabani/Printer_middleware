import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const html = readFileSync(ROOT + 'index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/index.html' });
const { window } = dom;

try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true }); console.log('navigator defined'); } catch (e) { console.log('navigator fail', e.message); }
for (const k of ['window','document','location','localStorage','Image','HTMLElement','Element','Node','Event','CustomEvent','getComputedStyle','requestAnimationFrame','DOMParser','XMLSerializer','NodeFilter','history','matchMedia']) {
  try { globalThis[k] = window[k]; } catch (e) { console.log('set fail', k, e.message); }
}
globalThis.window = window;
globalThis.location = window.location;
Element.prototype.scrollIntoView = function () {};
globalThis.fetch = async (u) => {
  const p = String(u).replace(/^https?:\/\/[^/]+\//, '');
  return { ok: true, status: 200, async json() { return JSON.parse(readFileSync(ROOT + p, 'utf8')); } };
};
await import(pathToFileURL(ROOT + 'assets/js/ui/home.js').href + '?t=' + Date.now());
await new Promise(r => setTimeout(r, 60));
const doc = window.document;
console.log('app cards', doc.querySelectorAll('#app-cards .card').length);
console.log('board rows', doc.querySelectorAll('#board-table tbody tr').length);
console.log('stat boards', doc.getElementById('stat-boards').textContent);
console.log('stat apps', doc.getElementById('stat-apps').textContent);
console.log('stat langs', doc.getElementById('stat-langs').textContent);
console.log('family options', doc.querySelectorAll('#board-family option').length);
console.log('header', !!doc.querySelector('.site-header'), 'footer', !!doc.querySelector('.footer'));
console.log('title text', doc.querySelector('h1').textContent.slice(0,40));
