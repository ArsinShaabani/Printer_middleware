import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const ROOT = new URL('..', import.meta.url).pathname;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 3000) { const t0 = Date.now(); for (;;) { let v; try { v = fn(); } catch (e) { v = false; } if (v) return v; if (Date.now() - t0 > timeout) return false; await sleep(20); } }
async function boot(page, query = '', settle) {
  const html = readFileSync(ROOT + page, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' + page + query });
  const { window } = dom;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  for (const k of ['window','document','localStorage','Image','HTMLElement','Element','Node','Event','CustomEvent','getComputedStyle','requestAnimationFrame','DOMParser','XMLSerializer','NodeFilter','history']) { try { globalThis[k] = window[k]; } catch (e) {} }
  globalThis.window = window; globalThis.location = window.location;
  Element.prototype.scrollIntoView = function () {};
  globalThis.fetch = async (u) => { const p = String(u).replace(/^https?:\/\/[^/]+\//, ''); return { ok: true, status: 200, async json() { return JSON.parse(readFileSync(ROOT + p, 'utf8')); } }; };
  const controller = { 'index.html':'home.js','install.html':'install.js','designer.html':'designer.js','troubleshoot.html':'troubleshoot.js','docs.html':'docs.js' }[page];
  await import(pathToFileURL(ROOT + 'assets/js/ui/' + controller).href + '?t=' + Date.now() + Math.random());
  if (settle) { const ok = await waitFor(() => settle(window.document)); await sleep(500); if (!ok) console.log('  (settle timeout for', page + ')'); }
  return { dom, window, doc: window.document };
}
{
  const realSetInterval = globalThis.setInterval; globalThis.setInterval = () => 0;
  const { doc } = await boot('troubleshoot.html', '', (d) => d.querySelectorAll('#dash-status dt').length > 0 && d.querySelectorAll('#cfg-form .field').length > 0);
  globalThis.setInterval = realSetInterval;
  console.log('ts dash dt', doc.querySelectorAll('#dash-status dt').length, 'cfg fields', doc.querySelectorAll('#cfg-form .field').length);
  console.log('ts dev-state', doc.getElementById('dev-state').textContent, '| last', doc.getElementById('dev-last').textContent.slice(0,10));
  console.log('ts counters dd', doc.querySelectorAll('#dash-counters dd').length, 'wifi dd', doc.querySelectorAll('#dash-wifi dd').length);
  console.log('ts logs', doc.getElementById('logs-out').textContent.length);
}
{
  const { doc } = await boot('docs.html', '', (d) => d.querySelectorAll('#wiring-doc .card').length > 0);
  console.log('docs app options', doc.querySelectorAll('#wiring-app option').length, 'boards', doc.querySelectorAll('#wiring-board option').length);
  console.log('docs wiring cards', doc.querySelectorAll('#wiring-doc .card').length, 'svg', !!doc.querySelector('#wiring-doc svg'));
  console.log('docs languages children', doc.getElementById('languages-doc').children.length);
  console.log('docs api children', doc.getElementById('api-doc').children.length);
  console.log('docs boards children', doc.getElementById('boards-doc').children.length);
  console.log('docs build children', doc.getElementById('build-doc').children.length);
  console.log('docs faq details', doc.querySelectorAll('#faq-doc details').length);
}
{
  const { doc } = await boot('install.html', '?app=print-server-usbhost&board=esp32-s3-devkitc-1', (d) => !!d.querySelector('#wiring-diagram svg'));
  console.log('install usbhost wiring svg', !!doc.querySelector('#wiring-diagram svg'));
  console.log('install flash panel children', doc.getElementById('flash-panel').children.length);
  console.log('install configure panel children', doc.getElementById('configure-panel').children.length);
}
process.exit(0);
