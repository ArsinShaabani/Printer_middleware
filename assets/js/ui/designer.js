/**
 * Label / receipt designer.
 *
 * Pure rendering comes from assets/js/core/label.js (SVG preview + native
 * printer commands). This controller only manages the document, the element
 * list, the properties panel and the output panel.
 */
import {
  initShell, $, $$, el, esc, t, toast, openModal, download, copyText, store, uid, clamp, selectTab
} from './shell.js';
import {
  createLabelDoc, renderLabel, renderLabelSvg, renderLabelRaster, SIZE_PRESETS, mmToDots, substituteVars
} from '../core/label.js';
import { LANGUAGES, DEVICE_PROFILES } from '../core/commands.js';
import { SYMBOLOGIES, SYMBOLOGY_BY_ID } from '../core/barcode.js';
import { toMono, bitmapToAscii } from '../core/raster.js';
import { Device, normalizeBase } from './device.js';

initShell();

const state = {
  doc: createLabelDoc({ preset: 'label-50x30', name: 'Arsin label' }),
  selected: null,
  zoom: 1,
  grid: false,
  raster: null,
  output: null,
  device: null
};

/* ------------------------------------------------------------------- setup */

function fillSelects() {
  const preset = $('#preset');
  for (const p of SIZE_PRESETS) preset.append(el('option', { value: p.id, text: p.name }));
  preset.value = 'label-50x30';

  const lang = $('#language');
  for (const l of LANGUAGES) lang.append(el('option', { value: l.id, text: l.name + ' - ' + l.vendor }));
  lang.value = state.doc.language;

  preset.addEventListener('change', () => {
    const p = SIZE_PRESETS.find((x) => x.id === preset.value);
    if (!p) return;
    state.doc.width = p.width;
    state.doc.height = p.height;
    state.doc.gap = p.gap;
    state.doc.dpi = p.dpi;
    state.doc.profile = p.profile;
    renderAll();
  });
  lang.addEventListener('change', () => {
    state.doc.language = lang.value;
    renderAll();
  });
  $('#mode').addEventListener('change', () => renderOutput());
}

function currentMode() {
  return $('#mode').value;
}

/* ---------------------------------------------------------------- elements */

function defaultElement(type) {
  const base = { id: uid(), type, x: 4, y: 4, rotation: 0 };
  switch (type) {
    case 'text':
      return { ...base, text: 'ARSIN {{serial}}', fontSizeMm: 3.5, w: 40, align: 'left', bold: false };
    case 'barcode':
      return { ...base, symbology: 'code128', data: 'ARSIN-{{serial}}', heightMm: 10, narrowMm: 0.25, showText: true, w: 40 };
    case 'qrcode':
      return { ...base, data: 'https://github.com/ArsinShaabani/Printer_middleware', sizeMm: 16, ecc: 'M' };
    case 'image':
      return { ...base, src: '', w: 20, h: 20, dither: 'floyd', threshold: 128 };
    case 'line':
      return { ...base, w: 40, thicknessMm: 0.4 };
    case 'box':
      return { ...base, w: 42, h: 22, thicknessMm: 0.4, filled: false };
    default:
      return base;
  }
}

function addElement(type) {
  const element = defaultElement(type);
  state.doc.elements.push(element);
  state.selected = element.id;
  renderAll();
}

function selectedElement() {
  return state.doc.elements.find((e) => e.id === state.selected) || null;
}

function renderElementList() {
  const host = $('#el-list');
  host.innerHTML = '';
  $('#el-count').textContent = String(state.doc.elements.length);
  for (const element of state.doc.elements) {
    const label = element.type === 'text' ? element.text : element.type === 'barcode' || element.type === 'qrcode' ? element.data : element.type;
    host.append(
      el('div', {
        class: 'el-item' + (element.id === state.selected ? ' selected' : ''),
        onclick: () => {
          state.selected = element.id;
          renderAll();
        }
      }, [
        el('span', { class: 'type', text: element.type }),
        el('span', { class: 'grow', text: String(label || '').slice(0, 18) }),
        el('button', { class: 'icon-btn small ghost', text: '\u2191', title: 'Move up', onclick: (e) => { e.stopPropagation(); move(element, -1); } }),
        el('button', { class: 'icon-btn small ghost', text: '\u2193', title: 'Move down', onclick: (e) => { e.stopPropagation(); move(element, 1); } }),
        el('button', { class: 'icon-btn small ghost', text: '\u2715', title: t('action.delete'), onclick: (e) => { e.stopPropagation(); removeElement(element); } })
      ])
    );
  }
}

function move(element, delta) {
  const list = state.doc.elements;
  const i = list.indexOf(element);
  const j = clamp(i + delta, 0, list.length - 1);
  list.splice(i, 1);
  list.splice(j, 0, element);
  renderAll();
}

function removeElement(element) {
  state.doc.elements = state.doc.elements.filter((e) => e !== element);
  if (state.selected === element.id) state.selected = null;
  renderAll();
}

function field(labelText, input, hint) {
  const wrap = el('div', { class: 'field' }, [el('label', { text: labelText }), input]);
  if (hint) wrap.append(el('div', { class: 'hint', text: hint }));
  return wrap;
}

function numberInput(value, onChange, opts = {}) {
  const input = el('input', { type: 'number', value: String(value), step: opts.step || '0.5', min: opts.min, max: opts.max });
  input.addEventListener('input', () => onChange(Number(input.value)));
  return input;
}

function textInput(value, onChange) {
  const input = el('input', { type: 'text', value: value == null ? '' : String(value) });
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function checkInput(checked, onChange, labelText) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'checkline' }, [input, el('span', { text: labelText })]);
}

function selectInput(value, options, onChange) {
  const select = el('select');
  for (const o of options) select.append(el('option', { value: o.value, text: o.label }));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

/* -------------------------------------------------------------- properties */

function renderProps() {
  const host = $('#props');
  host.innerHTML = '';
  const element = selectedElement();
  if (!element) {
    host.append(el('p', { class: 'small muted', text: 'Select an element to edit it.' }));
    return;
  }
  host.append(field('Type', el('div', { class: 'badge brand', text: element.type })));
  const pos = el('div', { class: 'prop-grid' }, [
    field('X (mm)', numberInput(element.x, (v) => { element.x = clamp(v, 0, state.doc.width); renderAll(); }, { step: '0.5', min: 0 })),
    field('Y (mm)', numberInput(element.y, (v) => { element.y = clamp(v, 0, state.doc.height); renderAll(); }, { step: '0.5', min: 0 }))
  ]);
  host.append(pos);

  if (element.type === 'text') {
    const ta = el('textarea', { rows: 3 });
    ta.value = element.text || '';
    ta.addEventListener('input', () => { element.text = ta.value; renderPreview(); renderOutput(); });
    host.append(field('Text ({{var}} supported)', ta));
    host.append(el('div', { class: 'prop-grid' }, [
      field('Font size (mm)', numberInput(element.fontSizeMm || 3.5, (v) => { element.fontSizeMm = clamp(v, 1, 40); renderAll(); }, { step: '0.5', min: 1 })),
      field('Width (mm)', numberInput(element.w || 40, (v) => { element.w = clamp(v, 2, state.doc.width); renderAll(); }, { step: '1', min: 2 })),
      field('Align', selectInput(element.align || 'left', [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }], (v) => { element.align = v; renderAll(); })),
      field('Rotation', selectInput(String(element.rotation || 0), [{ value: '0', label: '0\u00b0' }, { value: '90', label: '90\u00b0' }, { value: '180', label: '180\u00b0' }, { value: '270', label: '270\u00b0' }], (v) => { element.rotation = Number(v); renderAll(); }))
    ]));
    host.append(checkInput(element.bold, (v) => { element.bold = v; renderAll(); }, 'Bold'));
    host.append(checkInput(element.reverse, (v) => { element.reverse = v; renderAll(); }, 'Inverse (white on black)'));
  }

  if (element.type === 'barcode') {
    host.append(field('Data', textInput(element.data, (v) => { element.data = v; renderAll(); })));
    host.append(field('Symbology', selectInput(element.symbology, SYMBOLOGIES.map((s) => ({ value: s.id, label: s.name + (s.kind === '2d' ? ' (2D)' : '') })), (v) => { element.symbology = v; renderAll(); })));
    const meta = SYMBOLOGY_BY_ID[element.symbology];
    if (meta) host.append(el('div', { class: 'hint', text: 'Allowed: ' + meta.chars }));
    host.append(el('div', { class: 'prop-grid' }, [
      field('Height (mm)', numberInput(element.heightMm || 10, (v) => { element.heightMm = clamp(v, 3, 80); renderAll(); }, { step: '1', min: 3 })),
      field('Narrow bar (mm)', numberInput(element.narrowMm || 0.25, (v) => { element.narrowMm = clamp(v, 0.1, 2); renderAll(); }, { step: '0.05', min: 0.1 })),
      field('Width (mm)', numberInput(element.w || 40, (v) => { element.w = clamp(v, 5, state.doc.width); renderAll(); }, { step: '1', min: 5 })),
      field('Rotation', selectInput(String(element.rotation || 0), [{ value: '0', label: '0\u00b0' }, { value: '90', label: '90\u00b0' }, { value: '180', label: '180\u00b0' }, { value: '270', label: '270\u00b0' }], (v) => { element.rotation = Number(v); renderAll(); }))
    ]));
    host.append(checkInput(element.showText, (v) => { element.showText = v; renderAll(); }, 'Show human readable text'));
  }

  if (element.type === 'qrcode') {
    host.append(field('Data', textInput(element.data, (v) => { element.data = v; renderAll(); })));
    host.append(el('div', { class: 'prop-grid' }, [
      field('Size (mm)', numberInput(element.sizeMm || 16, (v) => { element.sizeMm = clamp(v, 5, 100); renderAll(); }, { step: '1', min: 5 })),
      field('Error correction', selectInput(element.ecc || 'M', [{ value: 'L', label: 'L (7%)' }, { value: 'M', label: 'M (15%)' }, { value: 'Q', label: 'Q (25%)' }, { value: 'H', label: 'H (30%)' }], (v) => { element.ecc = v; renderAll(); }))
    ]));
  }

  if (element.type === 'image') {
    const file = el('input', { type: 'file', accept: 'image/*' });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(f);
      });
      element.src = dataUrl;
      renderAll();
    });
    host.append(field('Image file (PNG/JPG/SVG)', file));
    host.append(el('div', { class: 'prop-grid' }, [
      field('Width (mm)', numberInput(element.w || 20, (v) => { element.w = clamp(v, 2, state.doc.width); renderAll(); }, { step: '1', min: 2 })),
      field('Height (mm)', numberInput(element.h || 20, (v) => { element.h = clamp(v, 2, state.doc.height); renderAll(); }, { step: '1', min: 2 })),
      field('Dithering', selectInput(element.dither || 'floyd', [{ value: 'none', label: 'Threshold' }, { value: 'floyd', label: 'Floyd-Steinberg' }, { value: 'atkinson', label: 'Atkinson' }, { value: 'bayer', label: 'Bayer 8x8' }], (v) => { element.dither = v; renderAll(); })),
      field('Threshold', numberInput(element.threshold || 128, (v) => { element.threshold = clamp(v, 1, 254); renderAll(); }, { step: '4', min: 1, max: 254 }))
    ]));
    host.append(checkInput(element.invert, (v) => { element.invert = v; renderAll(); }, 'Invert (for white on black logos)'));
  }

  if (element.type === 'line' || element.type === 'box') {
    host.append(el('div', { class: 'prop-grid' }, [
      field('Width (mm)', numberInput(element.w || 20, (v) => { element.w = clamp(v, 0.2, state.doc.width); renderAll(); }, { step: '0.5', min: 0.2 })),
      field('Height (mm)', numberInput(element.h || 0.5, (v) => { element.h = clamp(v, 0.2, state.doc.height); renderAll(); }, { step: '0.5', min: 0.2 })),
      field('Thickness (mm)', numberInput(element.thicknessMm || 0.4, (v) => { element.thicknessMm = clamp(v, 0.1, 5); renderAll(); }, { step: '0.1', min: 0.1 }))
    ]));
    if (element.type === 'box') host.append(checkInput(element.filled, (v) => { element.filled = v; renderAll(); }, 'Filled'));
  }

  host.append(el('div', { class: 'row tight mt1' }, [
    el('button', { class: 'btn small', text: t('action.duplicate'), onclick: () => { const copy = { ...element, id: uid(), y: clamp((element.y || 0) + 3, 0, state.doc.height) }; state.doc.elements.push(copy); state.selected = copy.id; renderAll(); } }),
    el('button', { class: 'btn small danger', text: t('action.delete'), onclick: () => removeElement(element) })
  ]));
}

function renderDocProps() {
  const host = $('#doc-props');
  host.innerHTML = '';
  host.append(field('Name', textInput(state.doc.name, (v) => { state.doc.name = v; renderOutput(); })));
  host.append(el('div', { class: 'prop-grid' }, [
    field('Width (mm)', numberInput(state.doc.width, (v) => { state.doc.width = clamp(v, 5, 400); renderAll(); }, { step: '1', min: 5 })),
    field('Height (mm)', numberInput(state.doc.height, (v) => { state.doc.height = clamp(v, 5, 500); renderAll(); }, { step: '1', min: 5 })),
    field('Gap (mm)', numberInput(state.doc.gap, (v) => { state.doc.gap = clamp(v, 0, 20); renderAll(); }, { step: '0.5', min: 0 })),
    field('DPI', selectInput(String(state.doc.dpi), [{ value: '203', label: '203 dpi (8 dots/mm)' }, { value: '300', label: '300 dpi' }, { value: '600', label: '600 dpi' }, { value: '180', label: '180 dpi (impact)' }, { value: '360', label: '360 dpi (inkjet)' }], (v) => { state.doc.dpi = Number(v); renderAll(); })),
    field('Copies', numberInput(state.doc.copies, (v) => { state.doc.copies = clamp(v, 1, 99); renderOutput(); }, { step: '1', min: 1, max: 99 })),
    field('Media', selectInput(state.doc.mediaType, [{ value: 'gap', label: 'Gap / die-cut' }, { value: 'blackmark', label: 'Black mark' }, { value: 'continuous', label: 'Continuous' }], (v) => { state.doc.mediaType = v; renderOutput(); })),
    field('Darkness', numberInput(state.doc.darkness, (v) => { state.doc.darkness = clamp(v, 0, 15); renderOutput(); }, { step: '1', min: 0, max: 15 })),
    field('Speed (ips)', numberInput(state.doc.speed, (v) => { state.doc.speed = clamp(v, 1, 14); renderOutput(); }, { step: '1', min: 1, max: 14 }))
  ]));
  host.append(checkInput(state.doc.cut !== false, (v) => { state.doc.cut = v; renderOutput(); }, 'Cut after printing (receipt printers)'));
  host.append(field('Printer profile', selectInput(state.doc.profile, DEVICE_PROFILES.map((p) => ({ value: p.id, label: p.name })), (v) => { state.doc.profile = v; renderOutput(); })));
}

/* --------------------------------------------------------------- variables */

function renderVars() {
  const host = $('#var-list');
  host.innerHTML = '';
  const vars = state.doc.variables || {};
  const keys = Object.keys(vars);
  if (!keys.length) {
    host.append(el('p', { class: 'small muted', text: 'No variables yet. Use {{name}} in text and fill the value here.' }));
  }
  for (const key of keys) {
    const input = textInput(vars[key], (v) => { vars[key] = v; renderPreview(); renderOutput(); });
    host.append(el('div', { class: 'row tight' }, [
      el('span', { class: 'mono small', text: '{{' + key + '}}' }),
      input,
      el('button', { class: 'icon-btn small ghost', text: '\u2715', onclick: () => { delete vars[key]; renderVars(); renderAll(); } })
    ]));
  }
}

/* ----------------------------------------------------------- preview/output */

function renderPreview() {
  const host = $('#preview');
  const width = mmToDots(state.doc.width, state.doc.dpi) * state.zoom;
  host.innerHTML = renderLabelSvg(state.doc, { grid: state.grid, showBorder: true, displayWidth: Math.round(width) + 'px' });
  $('#size-label').textContent = `${state.doc.width} x ${state.doc.height} mm @ ${state.doc.dpi} dpi (${mmToDots(state.doc.width, state.doc.dpi)} x ${mmToDots(state.doc.height, state.doc.dpi)} dots)`;
  $('#zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  wirePreviewDrag();
}

/** Drag elements directly on the preview (millimetre precision). */
function wirePreviewDrag() {
  const svg = $('#preview svg');
  if (!svg) return;
  const scale = mmToDots(state.doc.width, state.doc.dpi) / svg.getBoundingClientRect().width;
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => {
    const element = selectedElement();
    if (!element) return;
    const rect = svg.getBoundingClientRect();
    drag = {
      startX: (ev.clientX - rect.left) * scale,
      startY: (ev.clientY - rect.top) * scale,
      originX: element.x,
      originY: element.y,
      element
    };
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    const dx = (ev.clientX - rect.left) * scale - drag.startX;
    const dy = (ev.clientY - rect.top) * scale - drag.startY;
    const mmPerDot = 25.4 / state.doc.dpi;
    drag.element.x = clamp(Math.round((drag.originX + dx * mmPerDot) * 2) / 2, 0, state.doc.width);
    drag.element.y = clamp(Math.round((drag.originY + dy * mmPerDot) * 2) / 2, 0, state.doc.height);
    renderPreview();
  });
  svg.addEventListener('pointerup', () => {
    if (drag) {
      drag = null;
      renderProps();
      renderOutput();
    }
  });
}

/** Rasterise the label once per document revision (canvas based). */
async function ensureRaster() {
  const signature = JSON.stringify(state.doc);
  if (state.raster && state.rasterSignature === signature) return state.raster;
  const mono = await rasterise();
  state.rasterSignature = signature;
  return mono;
}

async function renderOutput() {
  await prepareImages();
  const mode = currentMode();
  const lang = state.doc.language;
  const warnings = [];
  let result = null;
  try {
    if (mode === 'raster') {
      const mono = await ensureRaster();
      result = renderLabel(state.doc, { lang, mode: 'raster', raster: mono });
    } else {
      result = renderLabel(state.doc, { lang, mode: 'native' });
    }
  } catch (e) {
    warnings.push('Raster mode failed (' + e.message + ') - showing native printer commands instead.');
    try {
      result = renderLabel(state.doc, { lang, mode: 'native' });
    } catch (inner) {
      $('#out-cmd').textContent = 'Error: ' + inner.message;
    }
  }
  state.output = result;
  if (result) {
    $('#out-cmd').textContent = result.text || '(binary output - see the hex tab)';
    $('#out-hex').textContent = [...result.bytes].slice(0, 4096).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    warnings.push(...result.warnings);
  }
  $('#out-json').textContent = JSON.stringify(state.doc, null, 2);
  const warnHost = $('#warn-host');
  warnHost.innerHTML = '';
  if (warnings.length) {
    warnHost.append(el('div', { class: 'callout warn' }, [
      el('strong', { text: 'Notes for this output' }),
      el('ul', {}, [...new Set(warnings)].map((w) => el('li', { text: w })))
    ]));
  }
}

/** UTF-8 safe SVG -> data URL (labels may contain Persian or Arabic text). */
function svgToDataUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return 'data:image/svg+xml;base64,' + btoa(binary);
}

/** Render the label to a 1bpp bitmap through the browser canvas. */
async function rasterise() {
  const probe = document.createElement('canvas');
  if (!probe.getContext || !probe.getContext('2d')) throw new Error('this browser cannot rasterise (no canvas 2d context)');
  const svg = renderLabelSvg(state.doc, {});
  const url = svgToDataUrl(svg);
  const width = mmToDots(state.doc.width, state.doc.dpi);
  const height = mmToDots(state.doc.height, state.doc.dpi);
  const image = new Image();
  await Promise.race([
    new Promise((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('could not rasterise the label'));
      image.src = url;
    }),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('rasterising timed out')), 5000))
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  state.raster = toMono(data, { threshold: 128, dither: 'none' });
  $('#out-raster').textContent = bitmapToAscii(state.raster, { step: 2 });
  return state.raster;
}

/* ---------------------------------------------------------------- actions */

function newDoc() {
  state.doc = createLabelDoc({ preset: $('#preset').value, name: 'Arsin label' });
  state.selected = null;
  state.raster = null;
  renderAll();
}

function saveTemplate() {
  const name = prompt('Template name', state.doc.name || 'My label');
  if (!name) return;
  const templates = store.get('templates', {});
  state.doc.name = name;
  templates[name] = state.doc;
  store.set('templates', templates);
  toast('Template saved: ' + name, 'ok');
}

function loadTemplate() {
  const templates = store.get('templates', {});
  const names = Object.keys(templates);
  const body = el('div', { class: 'stack' });
  if (!names.length) body.append(el('p', { class: 'small muted', text: 'No saved templates yet.' }));
  for (const name of names) {
    body.append(el('div', { class: 'row spread' }, [
      el('span', { text: name }),
      el('div', { class: 'row tight' }, [
        el('button', { class: 'btn small', text: 'Load', onclick: () => { state.doc = templates[name]; renderAll(); modal.close(); toast('Loaded ' + name, 'ok'); } }),
        el('button', { class: 'btn small danger', text: t('action.delete'), onclick: () => { delete templates[name]; store.set('templates', templates); modal.close(); loadTemplate(); } })
      ])
    ]));
  }
  const modal = openModal({ title: t('designer.templates'), body });
}

function downloadOutput() {
  const result = state.output || renderLabel(state.doc, { lang: state.doc.language, mode: currentMode(), raster: state.raster });
  const ext = currentMode() === 'raster' ? 'bin' : state.doc.language === 'zpl' || state.doc.language === 'tspl' || state.doc.language === 'epl' || state.doc.language === 'cpcl' ? 'txt' : 'bin';
  download(`${slug(state.doc.name)}-${state.doc.language}.${ext}`, result.bytes, 'application/octet-stream');
}

function slug(s) {
  return String(s || 'label').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'label';
}

function deviceModal() {
  const saved = store.get('session', {}) || {};
  const host = textInput(saved.host || 'arsin_print_server.local', () => {});
  const key = el('input', { type: 'password', value: saved.apiKey || '', placeholder: 'API key (optional)' });
  const body = el('div', {}, [
    field('Device address', host, 'arsin_print_server.local or an IP address'),
    field('API key', key)
  ]);
  const modal = openModal({
    title: t('action.send'),
    body,
    actions: [
      { label: t('action.cancel'), class: 'ghost' },
      {
        label: t('action.send'),
        class: 'primary',
        onClick: async (close) => {
          close();
          const base = normalizeBase(host.value);
          store.set('session', { host: base, apiKey: key.value });
          state.device = new Device(base, key.value);
          try {
            const mode = currentMode();
            let payload;
            if (mode === 'raster') {
              const mono = state.raster || (await rasterise());
              payload = flatten(renderLabelRaster(state.doc, state.doc.language, mono));
            } else {
              payload = state.output && state.output.bytes ? state.output.bytes : renderLabel(state.doc, { lang: state.doc.language, mode: 'native' }).bytes;
            }
            // Jobs larger than the device body buffer are streamed by the firmware,
            // which cannot see the query string on that path - so big jobs get an
            // explicit cut command right after the payload.
            const bigJob = payload.length > 60000;
            const wantCut = state.doc.cut !== false;
            const res = await state.device.printBytes(payload, {
              lang: state.doc.language,
              cut: wantCut && !bigJob,
              copies: state.doc.copies
            });
            if (bigJob && wantCut) {
              try {
                await state.device.sendCommand(state.doc.language, 'cut', {});
              } catch (e) {
                /* the printer may not have a cutter - not fatal */
              }
            }
            toast('Sent to the printer (' + (res.bytes || payload.length) + ' bytes)', 'ok');
          } catch (e) {
            toast('Send failed: ' + e.message, 'danger', 6000);
          }
        }
      }
    ]
  });
}

function flatten(chunks) {
  const parts = [];
  for (const c of chunks) {
    if (typeof c === 'string') for (const ch of c) parts.push(ch.charCodeAt(0) & 0xff);
    else parts.push(...[...c].map((b) => b & 0xff));
  }
  return Uint8Array.from(parts);
}

/* ------------------------------------------------------------------- boot */


/* ------------------------------------------------------------ image raster */

const imageCache = new Map();

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('could not load the image'));
    image.src = src;
  });
}

/** Convert every image element into a 1bpp bitmap so it can be printed natively. */
async function prepareImages() {
  for (const element of state.doc.elements) {
    if (element.type !== 'image' || !element.src) continue;
    const width = Math.max(1, mmToDots(element.w || 10, state.doc.dpi));
    const height = Math.max(1, mmToDots(element.h || 10, state.doc.dpi));
    const key = [element.src.slice(0, 48), width, height, element.dither, element.threshold, element.invert].join('|');
    if (imageCache.has(key)) {
      element.mono = imageCache.get(key);
      continue;
    }
    try {
      const image = await loadImage(element.src);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height);
      const mono = toMono(data, { threshold: element.threshold == null ? 128 : element.threshold, dither: element.dither || 'floyd', invert: !!element.invert });
      imageCache.set(key, mono);
      element.mono = mono;
    } catch (e) {
      element.mono = null;
    }
  }
}

function renderAll() {
  renderElementList();
  renderProps();
  renderDocProps();
  renderVars();
  renderPreview();
  renderOutput();
}

/** Async variant used whenever image bitmaps may need refreshing. */
async function renderAllAsync() {
  await prepareImages();
  renderAll();
}

function wire() {
  for (const btn of $$('[data-add]')) btn.addEventListener('click', () => addElement(btn.dataset.add));
  $('#btn-new').addEventListener('click', newDoc);
  $('#btn-save-tpl').addEventListener('click', saveTemplate);
  $('#btn-load-tpl').addEventListener('click', loadTemplate);
  $('#btn-download').addEventListener('click', downloadOutput);
  $('#btn-copy').addEventListener('click', () => copyText(state.output && state.output.text ? state.output.text : $('#out-hex').textContent));
  $('#btn-print').addEventListener('click', deviceModal);
  $('#btn-export-json').addEventListener('click', () => download(slug(state.doc.name) + '.json', JSON.stringify(state.doc, null, 2), 'application/json'));
  $('#btn-import-json').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      state.doc = JSON.parse(await f.text());
      if (!Array.isArray(state.doc.elements)) state.doc.elements = [];
      await renderAllAsync();
      toast('Imported ' + f.name, 'ok');
    } catch (err) {
      toast('Import failed: ' + err.message, 'danger');
    }
  });
  $('#btn-zoom-in').addEventListener('click', () => { state.zoom = clamp(state.zoom + 0.25, 0.25, 3); renderPreview(); });
  $('#btn-zoom-out').addEventListener('click', () => { state.zoom = clamp(state.zoom - 0.25, 0.25, 3); renderPreview(); });
  $('#grid-toggle').addEventListener('change', (e) => { state.grid = e.target.checked; renderPreview(); });
  $('#btn-add-var').addEventListener('click', () => {
    const name = prompt('Variable name (used as {{name}})', 'serial');
    if (!name) return;
    state.doc.variables = state.doc.variables || {};
    state.doc.variables[name] = state.doc.variables[name] || '0001';
    renderVars();
    renderAll();
  });
  document.addEventListener('keydown', (e) => {
    const element = selectedElement();
    if (!element) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const step = e.shiftKey ? 2 : 0.5;
    if (e.key === 'ArrowLeft') { element.x = clamp(element.x - step, 0, state.doc.width); renderAll(); }
    if (e.key === 'ArrowRight') { element.x = clamp(element.x + step, 0, state.doc.width); renderAll(); }
    if (e.key === 'ArrowUp') { element.y = clamp(element.y - step, 0, state.doc.height); renderAll(); }
    if (e.key === 'ArrowDown') { element.y = clamp(element.y + step, 0, state.doc.height); renderAll(); }
    if (e.key === 'Delete') removeElement(element);
  });
}

function seed() {
  state.doc.name = 'Arsin sample label';
  state.doc.variables = { serial: '00042', product: 'Arsin Print Server' };
  state.doc.elements = [
    { id: uid(), type: 'text', x: 4, y: 3, w: 42, text: '{{product}}', fontSizeMm: 4, bold: true, align: 'left' },
    { id: uid(), type: 'text', x: 4, y: 9, w: 42, text: 'S/N {{serial}}', fontSizeMm: 3, align: 'left' },
    { id: uid(), type: 'barcode', x: 4, y: 15, w: 30, symbology: 'code128', data: 'ARSIN-{{serial}}', heightMm: 9, narrowMm: 0.25, showText: true },
    { id: uid(), type: 'qrcode', x: 33, y: 14, sizeMm: 13, data: 'ARSIN-{{serial}}', ecc: 'M' },
    { id: uid(), type: 'box', x: 1, y: 1, w: 48, h: 28, thicknessMm: 0.3 }
  ];
  state.selected = state.doc.elements[0].id;
}

fillSelects();
wire();
seed();
renderAllAsync();
