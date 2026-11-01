/**
 * Landing page controller - English only.
 *
 * Renders the catalog statistics, the firmware variant cards and the board table,
 * and wires the board filter. The page is intentionally monolingual: the shared
 * shell hides the language switch here (see shell.js), while the designer, the
 * maintenance console and the docs stay bilingual.
 */
import { initShell, loadCatalog, $, el, esc, toast, copyText, onChange } from './shell.js';
import { groupByFamily, compatibility } from '../core/catalog.js';
import { LANGUAGES, DEVICE_PROFILES } from '../core/commands.js';
import { SYMBOLOGIES } from '../core/barcode.js';

initShell();

// English only, whatever language was stored for the rest of the site.
document.documentElement.lang = 'en';
document.documentElement.dir = 'ltr';

const state = { catalog: null, family: 'all', query: '' };

/** Small inline icons so the cards read as a product page, not a text dump. */
const APP_ICONS = {
  'print-server-wifi': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 8.8a15 15 0 0 1 20 0M5.5 12.4a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/></svg>',
  'print-server-bt-spp': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10-5 4V3l5 4L7 17"/></svg>',
  'print-server-ble': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l8 8-4 3V5l4 3-8 8"/></svg>',
  'print-server-usbhost': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 21V5M12 5l-3 3M12 5l3 3"/><rect x="9" y="17" width="6" height="4" rx="1"/></svg>',
  'print-server-serial': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h2M7 14h6"/></svg>',
  'print-server-hybrid': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>',
  'print-server-cups': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="7" rx="2"/><path d="M6 11v7h12v-7M9 15h6"/></svg>'
};

function stat(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

function renderApps() {
  const host = document.getElementById('app-cards');
  if (!host) return;
  host.innerHTML = '';
  for (const app of state.catalog.apps) {
    const card = el('div', { class: 'card app-card' }, [
      el('div', { class: 'app-head' }, [
        el('span', { class: 'app-icon', html: APP_ICONS[app.id] || '' }),
        el('div', {}, [
          el('h3', { class: 'mb0', text: app.name }),
          el('div', { class: 'small muted', text: app.transports.length === 1 ? '1 transport' : app.transports.length + ' transports' })
        ])
      ]),
      el('p', { class: 'small', text: app.tagline }),
      el('div', { class: 'pill-list mb2' }, app.transports.map((tr) => el('span', { class: 'badge', text: tr.name }))),
      el('div', { class: 'pill-list' }, app.capabilities.slice(0, 5).map((c) => el('span', { class: 'badge info', text: c }))),
      el('div', { class: 'row mt2' }, [
        el('a', { class: 'btn small primary', href: 'install.html?app=' + encodeURIComponent(app.id), text: 'Flash this variant' }),
        el('button', { class: 'btn small ghost', text: 'Details', onclick: () => showApp(app) })
      ])
    ]);
    host.append(card);
  }
}

function showApp(app) {
  const host = document.createElement('div');
  host.append(el('p', { class: 'small', text: app.summary }));
  host.append(el('h4', { text: 'Features' }));
  const ul = el('ul', { class: 'small' });
  for (const f of app.features) ul.append(el('li', { text: f }));
  host.append(ul);
  host.append(el('h4', { text: 'Requirements' }));
  const req = el('ul', { class: 'small' });
  for (const r of app.requirements) req.append(el('li', { text: r }));
  host.append(req);
  import('./shell.js').then(({ openModal }) => openModal({ title: app.name, body: host }));
}

function renderFamilies() {
  const select = document.getElementById('board-family');
  if (!select) return;
  select.innerHTML = '';
  select.append(el('option', { value: 'all', text: 'All families' }));
  for (const g of groupByFamily(state.catalog.boards)) {
    select.append(el('option', { value: g.family, text: g.family.toUpperCase() + ' (' + g.items.length + ')' }));
  }
  select.addEventListener('change', () => {
    state.family = select.value;
    renderBoards();
  });
}

function renderBoards() {
  const host = document.getElementById('board-table');
  if (!host) return;
  const q = state.query.toLowerCase();
  const rows = [];
  for (const board of state.catalog.boards) {
    if (state.family !== 'all' && board.family !== state.family) continue;
    if (q && !(`${board.name} ${board.mcu} ${board.vendor} ${board.tags.join(' ')}`.toLowerCase().includes(q))) continue;
    const apps = state.catalog.apps.filter((a) => compatibility(board, a).ok);
    const radios = Object.entries(board.radios).filter(([, v]) => v).map(([k]) => k).join(', ');
    rows.push(
      el('tr', {}, [
        el('td', {}, [el('strong', { text: board.name }), el('div', { class: 'small', text: board.vendor + ' \u00b7 ' + board.family.toUpperCase() })]),
        el('td', { class: 'small', text: board.mcu }),
        el('td', { class: 'small', text: radios }),
        el('td', { class: 'small', text: board.power.input + ' \u00b7 ~' + board.power.typicalMa + ' mA' }),
        el('td', {}, [el('span', { class: 'badge ok', text: String(apps.length) + ' variants' })]),
        el('td', {}, [el('a', { class: 'btn small', href: 'install.html?board=' + encodeURIComponent(board.id), text: 'Install' })])
      ])
    );
  }
  if (!rows.length) {
    host.innerHTML = '<div class="callout">Nothing matches that filter.</div>';
    return;
  }
  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Board', 'MCU', 'Radios', 'Power', 'Firmware', ''].map((h) => el('th', { text: h })))]),
    el('tbody', {}, rows)
  ]);
  host.innerHTML = '';
  host.append(el('div', { class: 'table-wrap' }, [table]));
}

function wireFilter() {
  const input = document.getElementById('board-filter');
  if (input) {
    input.addEventListener('input', () => {
      state.query = input.value.trim();
      renderBoards();
    });
  }
  const copy = document.getElementById('copy-pi');
  const cmd = document.getElementById('pi-cmd');
  if (copy && cmd) {
    copy.addEventListener('click', () => {
      copyText(cmd.textContent.trim()).then(() => toast('Command copied', 'ok', 1800));
    });
  }
}

(async function boot() {
  try {
    state.catalog = await loadCatalog();
    stat('stat-boards', state.catalog.boards.length);
    stat('stat-apps', state.catalog.apps.length);
    stat('stat-langs', LANGUAGES.length);
    stat('stat-symbologies', SYMBOLOGIES.length);
    stat('stat-profiles', DEVICE_PROFILES.length);
    renderApps();
    renderFamilies();
    renderBoards();
    wireFilter();
    onChange(() => {
      renderApps();
      renderBoards();
    });
  } catch (e) {
    const host = document.getElementById('app-cards');
    if (host) host.innerHTML = '<div class="callout danger">Could not load the catalog: ' + esc(e.message) + '</div>';
  }
})();

