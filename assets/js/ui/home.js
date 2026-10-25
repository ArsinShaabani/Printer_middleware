/** Home page controller: catalog statistics, app cards and the board table. */
import { initShell, loadCatalog, $, el, esc, t, onChange } from './shell.js';
import { groupByFamily, compatibility } from '../core/catalog.js';
import { LANGUAGES, DEVICE_PROFILES } from '../core/commands.js';
import { SYMBOLOGIES } from '../core/barcode.js';

initShell();

const state = { catalog: null, family: 'all', query: '' };

function stat(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

function renderApps() {
  const host = document.getElementById('app-cards');
  if (!host) return;
  host.innerHTML = '';
  for (const app of state.catalog.apps) {
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'spread' }, [el('h3', { text: app.name }), el('span', { class: 'badge brand', text: app.transports.length + ' transport' + (app.transports.length > 1 ? 's' : '') })]),
      el('p', { class: 'small', text: app.tagline }),
      el('div', { class: 'pill-list mb2' }, app.transports.map((tr) => el('span', { class: 'badge', text: tr.name }))),
      el('div', { class: 'pill-list' }, app.capabilities.slice(0, 6).map((c) => el('span', { class: 'badge info', text: c }))),
      el('div', { class: 'row mt2' }, [
        el('a', { class: 'btn small primary', href: 'install.html?app=' + encodeURIComponent(app.id), text: t('nav.install') }),
        el('button', { class: 'btn small ghost', text: t('designer.output'), onclick: () => showApp(app) })
      ])
    ]);
    host.append(card);
  }
}

function showApp(app) {
  const host = document.createElement('div');
  host.append(el('p', { class: 'small', text: app.summary }));
  host.append(el('h4', { text: t('common.features') }));
  const ul = el('ul', { class: 'small' });
  for (const f of app.features) ul.append(el('li', { text: f }));
  host.append(ul);
  host.append(el('h4', { text: t('wizard.requirements') }));
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
        el('td', {}, [el('a', { class: 'btn small', href: 'install.html?board=' + encodeURIComponent(board.id), text: t('nav.install') })])
      ])
    );
  }
  if (!rows.length) {
    host.innerHTML = '<div class="callout">' + esc(t('common.noresults')) + '</div>';
    return;
  }
  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, [t('common.board'), t('common.mcu'), t('common.radios'), t('common.power'), 'Firmware', ''].map((h) => el('th', { text: h })))]),
    el('tbody', {}, rows)
  ]);
  host.innerHTML = '';
  host.append(el('div', { class: 'table-wrap' }, [table]));
}

function wireFilter() {
  const input = document.getElementById('board-filter');
  if (!input) return;
  input.addEventListener('input', () => {
    state.query = input.value.trim();
    renderBoards();
  });
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
      renderFamilies();
      renderBoards();
    });
  } catch (e) {
    const host = document.getElementById('app-cards');
    if (host) host.innerHTML = '<div class="callout danger">Could not load the catalog: ' + esc(e.message) + '</div>';
  }
})();
