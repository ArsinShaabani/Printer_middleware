import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const ROOT = new URL('..', import.meta.url).pathname;

async function boot(page, query = '') {
  const html = readFileSync(ROOT + page, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' + page + query });
  const { window } = dom;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  for (const k of ['window','document','localStorage','Image','HTMLElement','Element','Node','Event','CustomEvent','getComputedStyle','requestAnimationFrame','DOMParser','XMLSerializer','NodeFilter','history']) { try { globalThis[k] = window[k]; } catch (e) {} }
  globalThis.window = window; globalThis.location = window.location;
  Element.prototype.scrollIntoView = function () {};
  globalThis.fetch = async (u) => { const p = String(u).replace(/^https?:\/\/[^/]+\//, ''); return { ok: true, status: 200, async json() { return JSON.parse(readFileSync(ROOT + p, 'utf8')); } }; };
  const controller = { 'index.html':'home.js','install.html':'install.js','designer.html':'designer.js','troubleshoot.html':'troubleshoot.js','docs.html':'docs.js' }[page];
  await import(pathToFileURL(ROOT + 'assets/js/ui/' + controller).href + '?t=' + Date.now());
  await new Promise(r => setTimeout(r, 80));
  return { dom, window, doc: window.document };
}

// install
{
  const { doc } = await boot('install.html', '?app=print-server-wifi&board=esp32-devkit-v1');
  console.log('install app cards', doc.querySelectorAll('#app-list .card').length);
  console.log('install transport cards', doc.querySelectorAll('#transport-list .card').length);
  console.log('install board cards', doc.querySelectorAll('#board-list .card').length);
  const svg = doc.querySelector('#wiring-diagram svg');
  console.log('install wiring svg', !!svg, svg ? svg.getAttribute('viewBox') : '');
  console.log('install wiring title', doc.getElementById('wiring-title').textContent.slice(0,40));
  console.log('install table rows', doc.querySelectorAll('#wiring-table tr').length);
  console.log('install steps', doc.querySelectorAll('#wiring-steps li').length);
  console.log('install bom', doc.querySelectorAll('#wiring-bom li, #wiring-bom tr').length);
  console.log('crumb app', doc.getElementById('crumb-app').textContent);
}
// designer
{
  const { doc } = await boot('designer.html');
  console.log('designer preview svg', !!doc.querySelector('#preview svg'));
  console.log('designer el list', doc.querySelectorAll('#el-list .el-item').length, 'count', doc.getElementById('el-count').textContent);
  console.log('designer out-cmd', doc.getElementById('out-cmd').textContent.slice(0,20));
  console.log('designer presets', doc.querySelectorAll('#preset option').length, 'langs', doc.querySelectorAll('#language option').length);
  console.log('designer props fields', doc.querySelectorAll('#props .field').length, 'doc props', doc.querySelectorAll('#doc-props .field').length);
}
// troubleshoot
{
  const realSetInterval = globalThis.setInterval; const realClear = globalThis.clearInterval;
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  const { doc } = await boot('troubleshoot.html');
  globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClear;
  console.log('ts maint lang options', doc.querySelectorAll('#maint-lang option').length);
  console.log('ts maint cards', doc.querySelectorAll('#maint-grid .card').length);
  console.log('ts maint count', doc.getElementById('maint-count').textContent);
  console.log('ts dash status dt', doc.querySelectorAll('#dash-status dt').length);
  console.log('ts dev-state', doc.getElementById('dev-state').textContent);
}
// docs
{
  const { doc } = await boot('docs.html');
  console.log('docs wiring app options', doc.querySelectorAll('#wiring-app option').length, 'board options', doc.querySelectorAll('#wiring-board option').length);
  console.log('docs wiring doc cards', doc.querySelectorAll('#wiring-doc .card').length);
  console.log('docs languages doc children', doc.getElementById('languages-doc').children.length);
  console.log('docs api doc children', doc.getElementById('api-doc').children.length);
  console.log('docs faq details', doc.querySelectorAll('#faq-doc details').length);
  console.log('docs wiring svg', !!doc.querySelector('#wiring-doc svg'));
}
process.exit(0);
