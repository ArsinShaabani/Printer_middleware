/**
 * Arsin Print Server - shared UI shell: theme, navigation, toasts, modals,
 * small DOM helpers, browser storage and catalog loading.
 */
import { initI18n, setLanguage, getLanguage, t, onChange, applyTranslations } from './i18n.js';
import { normalizeCatalog, mergeCatalogs } from '../core/catalog.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
export const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} kB`;
  return `${(v / 1048576).toFixed(2)} MB`;
};
export const fmtUptime = (ms) => {
  const s = Math.floor((Number(ms) || 0) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
};
export const uid = () => Math.random().toString(36).slice(2, 9);

export function debounce(fn, ms = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ store */

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`arsin.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`arsin.${key}`, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(`arsin.${key}`);
    } catch (e) {
      /* ignore */
    }
  }
};

/* ------------------------------------------------------------------ toast */

function toastHost() {
  let host = $('.toast-host');
  if (!host) {
    host = el('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

export function toast(message, kind = 'info', ms = 4200) {
  const node = el('div', { class: `toast ${kind}` }, [el('div', { text: message })]);
  toastHost().append(node);
  setTimeout(() => node.remove(), ms);
  return node;
}

/* ------------------------------------------------------------------ modal */

export function openModal({ title, body, actions = [], width }) {
  const host = el('div', { class: 'modal-host', role: 'dialog', 'aria-modal': 'true' });
  const close = () => host.remove();
  const box = el('div', { class: 'modal' }, []);
  if (width) box.style.width = width;
  box.append(el('div', { class: 'spread' }, [el('h3', { text: title || '' }), el('button', { class: 'small ghost', text: '✕', onclick: close, 'aria-label': 'Close' })]));
  box.append(typeof body === 'string' ? el('div', { html: body }) : body);
  if (actions.length) {
    const row = el('div', { class: 'row mt2' });
    for (const a of actions) {
      row.append(el('button', { class: a.class || '', text: a.label, onclick: () => a.onClick ? a.onClick(close, box) : close() }));
    }
    box.append(row);
  }
  host.append(box);
  host.addEventListener('click', (e) => {
    if (e.target === host) close();
  });
  document.body.append(host);
  return { host, box, close };
}

export function confirmDialog(message, onOk, okLabel) {
  openModal({
    title: t('action.apply'),
    body: el('p', { text: message }),
    actions: [
      { label: t('action.cancel'), class: 'ghost' },
      { label: okLabel || t('action.apply'), class: 'primary', onClick: (close) => { close(); onOk(); } }
    ]
  });
}

/* ------------------------------------------------------------------- tabs */

export function initTabs(root = document) {
  for (const bar of $$('.tabs', root)) {
    const group = bar.dataset.group || 'default';
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      for (const b of $$('button[data-tab]', bar)) b.classList.toggle('active', b === btn);
      const target = btn.dataset.tab;
      for (const panel of $$(`[data-tabpanel][data-group="${group}"]`, root)) {
        panel.hidden = panel.dataset.tabpanel !== target;
      }
      if (typeof bar.onTabChange === 'function') bar.onTabChange(target);
    });
  }
}

export function selectTab(group, tab, root = document) {
  const bar = $(`.tabs[data-group="${group}"]`, root);
  if (!bar) return;
  const btn = $(`button[data-tab="${tab}"]`, bar);
  if (btn) btn.click();
}

/* -------------------------------------------------------------- downloads */

export function download(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('action.copied'), 'ok', 1800);
    return true;
  } catch (e) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(t('action.copied'), 'ok', 1800);
    return true;
  }
}

/* ------------------------------------------------------------------ theme */

export function initTheme() {
  const saved = store.get('theme', null);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('theme', theme);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1120' : '#4f46e5');
}

export function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

/* --------------------------------------------------------------- catalogs */

const CATALOG_URLS = { boards: 'data/boards.json', apps: 'data/apps.json' };
let catalogCache = null;

/** Load the built-in catalogs and merge any user-added boards from storage. */
export async function loadCatalog(force = false) {
  if (catalogCache && !force) return catalogCache;
  const [boardsJson, appsJson] = await Promise.all([
    fetch(CATALOG_URLS.boards, { cache: force ? 'reload' : 'default' }).then((r) => r.json()),
    fetch(CATALOG_URLS.apps, { cache: force ? 'reload' : 'default' }).then((r) => r.json())
  ]);
  const builtin = mergeCatalogs(boardsJson, appsJson);
  const custom = store.get('customBoards', []);
  catalogCache = mergeCatalogs(builtin, { boards: custom });
  return catalogCache;
}

export function getCustomBoards() {
  return store.get('customBoards', []);
}

export function saveCustomBoard(board) {
  const list = getCustomBoards().filter((b) => b.id !== board.id);
  board.source = 'custom';
  list.push(board);
  store.set('customBoards', list);
  catalogCache = null;
  return list;
}

export function removeCustomBoard(id) {
  store.set('customBoards', getCustomBoards().filter((b) => b.id !== id));
  catalogCache = null;
}

/** Validate a user supplied board JSON (used by the Add-board dialog). */
export function parseCustomBoard(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }
  const raw = json.board || json;
  if (!raw.id) throw new Error('The board needs an id field, for example my-board-01.');
  if (!raw.name) throw new Error('The board needs a name field.');
  const board = { ...raw };
  board.source = 'custom';
  if (!board.family) board.family = 'custom';
  if (!board.tool) board.tool = { kind: 'esp-web-tools', chipFamily: board.family === 'esp8266' ? 'ESP8266' : 'ESP32' };
  if (!board.pins || !Object.keys(board.pins).length) {
    board.pins = { uartTx: 'TX pin', uartRx: 'RX pin', v5: '5V', v3v3: '3V3', gnd: 'GND' };
  }
  if (!board.radios) board.radios = { wifi: true };
  return board;
}

/* ------------------------------------------------------------ nav & shell */

const NAV = [
  { href: 'index.html', key: 'nav.home' },
  { href: 'install.html', key: 'nav.install' },
  { href: 'designer.html', key: 'nav.designer' },
  { href: 'troubleshoot.html', key: 'nav.troubleshoot' },
  { href: 'docs.html', key: 'nav.docs' }
];

function currentPage() {
  const file = location.pathname.split('/').pop();
  return file ? file : 'index.html';
}

/** Render the site header + footer into the page. */
export function renderShell() {
  const page = currentPage();
  // Replace any previously rendered shell (language/theme re-render).
  for (const old of $$('.site-header, .footer')) old.remove();
  const header = el('header', { class: 'site-header' });
  const bar = el('div', { class: 'bar' });
  const brand = el('a', { class: 'brand', href: 'index.html' }, [
    el('span', { class: 'logo', text: '\u2b1a' }),
    el('span', {}, [el('span', { text: t('app.name') }), el('span', { class: 'sub', text: 'arsin_print_server' })])
  ]);
  const nav = el('nav', { class: 'main', 'aria-label': 'Main' });
  for (const item of NAV) {
    nav.append(el('a', { href: item.href, text: t(item.key), class: item.href === page ? 'active' : '' }));
  }
  const tools = el('div', { class: 'header-tools' }, [
    el('button', {
      class: 'icon-btn small ghost',
      title: t('action.language'),
      text: getLanguage() === 'fa' ? 'EN' : '\u0641\u0627',
      onclick: () => setLanguage(getLanguage() === 'fa' ? 'en' : 'fa')
    }),
    el('button', { class: 'icon-btn small ghost', title: t('action.theme'), text: '\u25d0', onclick: toggleTheme }),
    el('a', { class: 'btn small primary', href: 'install.html', text: t('nav.install') })
  ]);
  bar.append(brand, nav, tools);
  header.append(bar);
  const headerHost = $('#app-header');
  if (headerHost) headerHost.replaceWith(header);
  else document.body.prepend(header);

  const footer = el('footer', { class: 'footer' }, [
    el('div', { class: 'bar' }, [
      el('div', { text: t('app.name') + ' \u00b7 ' + t('footer.rights') }),
      el('div', { class: 'row tight' }, [
        el('a', { href: 'docs.html', text: t('nav.docs') }),
        el('a', { href: 'https://github.com/ArsinShaabani/Printer_middleware', target: '_blank', rel: 'noopener', text: 'GitHub' })
      ])
    ])
  ]);
  const footerHost = $('#app-footer');
  if (footerHost) footerHost.replaceWith(footer);
  else document.body.append(footer);
}

/** Wire up everything a page needs; call once from each page controller. */
export function initShell() {
  initTheme();
  initI18n();
  renderShell();
  initTabs(document);
  onChange(() => renderShell());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = $('.modal-host');
      if (modal) modal.remove();
    }
  });
}

export { t, setLanguage, getLanguage, applyTranslations, onChange };
