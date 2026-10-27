/**
 * Label & receipt designer.
 *
 * The heavy lifting (SVG preview + native printer commands) lives in
 * assets/js/core/label.js; this controller owns the document, the canvas
 * (drag / resize / snap / rulers), the layer list, the property panels, undo /
 * redo and the output panels. Everything the renderers support is exposed here,
 * so nothing the printer can do is hidden behind hand-edited JSON.
 */
import {
  initShell, $, $$, el, esc, t, toast, openModal, confirmDialog, download, copyText, store, uid, clamp, selectTab
} from './shell.js';
import {
  createLabelDoc, renderLabel, renderLabelSvg, renderLabelRaster, SIZE_PRESETS, mmToDots, substituteVars
} from '../core/label.js';
import { LANGUAGES, DEVICE_PROFILES } from '../core/commands.js';
import { SYMBOLOGIES, SYMBOLOGY_BY_ID } from '../core/barcode.js';
import { toMono, bitmapToAscii } from '../core/raster.js';
import { Device, normalizeBase, detectLocalDevice, localDeviceBase } from './device.js';

initShell();

const state = {
  doc: createLabelDoc({ preset: 'label-50x30', name: 'Arsin label' }),
  selected: null,
  zoom: 1,
  grid: true,
  snap: true,
  gridMm: 1,
  raster: null,
  output: null,
  device: null,
  localDevice: false,
  history: [],
  future: [],
  clipboard: null,
  /** px width of the paper at the current zoom (drives the rulers). */
  paperPx: 400
};

/* --------------------------------------------------------------- history */

function snapshot() {
  // `mono` bitmaps are large and rebuildable - never store them in the history.
  return JSON.parse(JSON.stringify(state.doc, (key, value) => (key === 'mono' ? undefined : value)));
}

function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 80) state.history.shift();
  state.future.length = 0;
  updateHistoryButtons();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  state.doc = state.history.pop();
  if (!state.doc.elements.some((e) => e.id === state.selected)) state.selected = null;
  renderAll();
  updateHistoryButtons();
}

function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  state.doc = state.future.pop();
  if (!state.doc.elements.some((e) => e.id === state.selected)) state.selected = null;
  renderAll();
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const back = $('#btn-undo');
  const fwd = $('#btn-redo');
  if (back) back.disabled = state.history.length === 0;
  if (fwd) fwd.disabled = state.future.length === 0;
}

/* ---------------------------------------------------------------- setup */

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
    pushHistory();
    state.doc.width = p.width;
    state.doc.height = p.height;
    state.doc.gap = p.gap;
    state.doc.dpi = p.dpi;
    state.doc.profile = p.profile;
    renderAll();
  });
  lang.addEventListener('change', () => {
    pushHistory();
    state.doc.language = lang.value;
    renderAll();
  });
  $('#mode').addEventListener('change', () => renderOutput());
}

function currentMode() {
  return $('#mode').value;
}

/* -------------------------------------------------------------- elements */

const ELEMENT_TYPES = [
  { type: 'text', icon: 'T', key: 'designer.add.text', fallback: 'Text' },
  { type: 'barcode', icon: 'IIII', key: 'designer.add.barcode', fallback: 'Barcode' },
  { type: 'qrcode', icon: 'QR', key: 'designer.add.qrcode', fallback: 'QR code' },
  { type: 'image', icon: 'IMG', key: 'designer.add.image', fallback: 'Image / logo' },
  { type: 'line', icon: '---', key: 'designer.add.line', fallback: 'Line' },
  { type: 'box', icon: '[ ]', key: 'designer.add.box', fallback: 'Box / frame' }
];

/** Ready-made elements: a good starting point beats six empty buttons. */
const PRESETS = [
  { id: 'title', label: 'Title', type: 'text', make: () => ({ text: 'ARSIN', fontSizeMm: 5, bold: true, w: 40 }) },
  { id: 'field', label: 'Field', type: 'text', make: () => ({ text: '{{product}}', fontSizeMm: 3.2, w: 40 }) },
  { id: 'caption', label: 'Caption', type: 'text', make: () => ({ text: 'S/N {{serial}}', fontSizeMm: 2.6, w: 40 }) },
  { id: 'barcode', label: 'Code 128', type: 'barcode', make: () => ({ symbology: 'code128', data: 'ARSIN-{{serial}}', heightMm: 9, showText: true, w: 34 }) },
  { id: 'ean13', label: 'EAN-13', type: 'barcode', make: () => ({ symbology: 'ean13', data: '4006381333931', heightMm: 11, showText: true, w: 30 }) },
  { id: 'qr', label: 'QR link', type: 'qrcode', make: () => ({ data: 'https://github.com/ArsinShaabani/Printer_middleware', sizeMm: 14, ecc: 'M' }) },
  { id: 'rule', label: 'Divider', type: 'line', make: () => ({ w: 42, thicknessMm: 0.4 }) },
  { id: 'frame', label: 'Frame', type: 'box', make: () => ({ w: 46, h: 26, thicknessMm: 0.4 }) }
];

function defaultElement(type) {
  const base = { id: uid(), type, x: 4, y: 4, rotation: 0 };
  switch (type) {
    case 'text':
      return { ...base, text: 'ARSIN {{serial}}', fontSizeMm: 3.5, w: 40, align: 'left', bold: false, lineHeight: 1.2 };
    case 'barcode':
      return { ...base, symbology: 'code128', data: 'ARSIN-{{serial}}', heightMm: 10, narrowMm: 0.25, showText: true, textSizeMm: 2.6, w: 40 };
    case 'qrcode':
      return { ...base, data: 'https://github.com/ArsinShaabani/Printer_middleware', sizeMm: 16, ecc: 'M' };
    case 'image':
      return { ...base, src: '', w: 20, h: 20, fit: 'xMidYMid meet', dither: 'floyd', threshold: 128 };
    case 'line':
      return { ...base, w: 40, h: 0, thicknessMm: 0.4 };
    case 'box':
      return { ...base, w: 42, h: 22, thicknessMm: 0.4, filled: false, radiusMm: 0 };
    default:
      return base;
  }
}

function addElement(type, preset) {
  pushHistory();
  const element = { ...defaultElement(type), ...(preset ? preset.make() : {}) };
  element.id = uid();
  element.type = type;
  if (element.w && element.w > state.doc.width) element.w = Math.max(5, state.doc.width - 4);
  if (element.h && element.h > state.doc.height) element.h = Math.max(3, state.doc.height - 4);
  state.doc.elements.push(element);
  state.selected = element.id;
  renderAll();
  toast((preset ? preset.label : type) + ' ' + t('designer.added', 'added'), 'ok', 1800);
}

function selectedElement() {
  return state.doc.elements.find((e) => e.id === state.selected) || null;
}

function selectElement(id) {
  state.selected = id;
  renderElementList();
  renderProps();
  renderPreview();
}

function move(element, delta) {
  const list = state.doc.elements;
  const i = list.indexOf(element);
  const j = clamp(i + delta, 0, list.length - 1);
  if (i === j) return;
  pushHistory();
  list.splice(i, 1);
  list.splice(j, 0, element);
  renderAll();
}

function zOrder(element, mode) {
  const list = state.doc.elements;
  const i = list.indexOf(element);
  if (i < 0) return;
  pushHistory();
  list.splice(i, 1);
  if (mode === 'front') list.push(element);
  else if (mode === 'back') list.unshift(element);
  else list.splice(clamp(i + (mode === 'forward' ? 1 : -1), 0, list.length), 0, element);
  renderAll();
}

function removeElement(element) {
  pushHistory();
  state.doc.elements = state.doc.elements.filter((e) => e !== element);
  if (state.selected === element.id) state.selected = null;
  renderAll();
}

function duplicateElement(element) {
  pushHistory();
  const copy = { ...element, id: uid(), x: clamp((element.x || 0) + 2, 0, state.doc.width), y: clamp((element.y || 0) + 2, 0, state.doc.height) };
  delete copy.mono;
  state.doc.elements.push(copy);
  state.selected = copy.id;
  renderAll();
}

function copyElement(element) {
  state.clipboard = { ...element, id: undefined, mono: undefined };
  toast(t('designer.copied', 'Element copied'), 'ok', 1800);
}

function pasteElement() {
  if (!state.clipboard) return;
  pushHistory();
  const copy = { ...state.clipboard, id: uid(), x: clamp((state.clipboard.x || 0) + 2, 0, state.doc.width), y: clamp((state.clipboard.y || 0) + 2, 0, state.doc.height) };
  state.doc.elements.push(copy);
  state.selected = copy.id;
  renderAll();
}

function elementSize(element) {
  const w = element.w != null ? element.w : element.sizeMm != null ? element.sizeMm : 20;
  const h = element.h != null ? element.h : element.heightMm != null ? element.heightMm : element.sizeMm != null ? element.sizeMm : 6;
  return { w, h };
}

/** Align the selected element against the label edges / centre lines. */
function alignElement(mode) {
  const element = selectedElement();
  if (!element) return;
  pushHistory();
  const { w, h } = elementSize(element);
  if (mode === 'left') element.x = 0;
  if (mode === 'right') element.x = Math.max(0, state.doc.width - w);
  if (mode === 'center-h') element.x = Math.max(0, Math.round(((state.doc.width - w) / 2) * 2) / 2);
  if (mode === 'top') element.y = 0;
  if (mode === 'bottom') element.y = Math.max(0, state.doc.height - h);
  if (mode === 'center-v') element.y = Math.max(0, Math.round(((state.doc.height - h) / 2) * 2) / 2);
  renderAll();
}

function toggleLock(element) {
  element.locked = !element.locked;
  renderAll();
}

/** Centre the selected element on both axes of the label. */
function centerOnLabel() {
  const element = selectedElement();
  if (!element) return;
  pushHistory();
  const { w, h } = elementSize(element);
  element.x = Math.max(0, Math.round(((state.doc.width - w) / 2) * 2) / 2);
  element.y = Math.max(0, Math.round(((state.doc.height - h) / 2) * 2) / 2);
  renderAll();
}


/* -------------------------------------------------------------- palettes */

function elementLabel(element) {
  if (element.type === 'text') return substituteVars(element.text || '', state.doc.variables || {}) || 'Text';
  if (element.type === 'barcode' || element.type === 'qrcode') return element.data || element.type;
  if (element.type === 'image') return element.src ? 'Image' : 'Image (empty)';
  return element.type;
}

function renderPalette() {
  const host = $('#palette');
  if (!host) return;
  host.innerHTML = '';
  const basic = el('div', { class: 'palette-grid' });
  for (const type of ELEMENT_TYPES) {
    basic.append(
      el('button', { class: 'palette-btn', 'data-add': type.type, title: t(type.key, type.fallback) }, [
        el('span', { class: 'palette-icon', text: type.icon }),
        el('span', { class: 'palette-label', text: t(type.key, type.fallback) })
      ])
    );
  }
  host.append(basic);

  const presetHost = $('#preset-list');
  if (presetHost) {
    presetHost.innerHTML = '';
    for (const preset of PRESETS) {
      presetHost.append(el('button', { class: 'btn small ghost', 'data-preset': preset.id, text: preset.label }));
    }
  }
}

function renderElementList() {
  const host = $('#el-list');
  if (!host) return;
  host.innerHTML = '';
  const count = $('#el-count');
  if (count) count.textContent = String(state.doc.elements.length);
  // Top-most element first, like every drawing app.
  [...state.doc.elements].reverse().forEach((element) => {
    host.append(
      el('div', {
        class: 'el-item' + (element.id === state.selected ? ' selected' : '') + (element.locked ? ' locked' : ''),
        onclick: () => selectElement(element.id)
      }, [
        el('span', { class: 'type', text: element.type }),
        el('span', { class: 'grow', text: String(elementLabel(element)).slice(0, 18) }),
        el('button', { class: 'icon-btn small ghost', text: element.locked ? '\u{1F512}' : '\u{1F513}', title: element.locked ? 'Unlock' : 'Lock', onclick: (e) => { e.stopPropagation(); toggleLock(element); } }),
        el('button', { class: 'icon-btn small ghost', text: '\u2191', title: 'Bring forward', onclick: (e) => { e.stopPropagation(); zOrder(element, 'forward'); } }),
        el('button', { class: 'icon-btn small ghost', text: '\u2193', title: 'Send backward', onclick: (e) => { e.stopPropagation(); zOrder(element, 'backward'); } }),
        el('button', { class: 'icon-btn small ghost', text: '\u29C9', title: t('action.duplicate'), onclick: (e) => { e.stopPropagation(); duplicateElement(element); } }),
        el('button', { class: 'icon-btn small ghost', text: '\u2715', title: t('action.delete'), onclick: (e) => { e.stopPropagation(); removeElement(element); } })
      ])
    );
  });
  if (!state.doc.elements.length) host.append(el('p', { class: 'small muted', text: t('designer.empty', 'No elements yet - add one from the palette.') }));
}

/* ---------------------------------------------------------------- fields */

function field(labelText, input, hint) {
  const wrap = el('div', { class: 'field' }, [el('label', { text: labelText }), input]);
  if (hint) wrap.append(el('div', { class: 'hint', text: hint }));
  return wrap;
}

function numberInput(value, onChange, opts = {}) {
  const input = el('input', { type: 'number', value: String(value == null ? 0 : value), step: opts.step || '0.5', min: opts.min, max: opts.max });
  input.addEventListener('input', () => onChange(Number(input.value)));
  input.addEventListener('change', () => onChange(Number(input.value)));
  return input;
}

function textInput(value, onChange) {
  const input = el('input', { type: 'text', value: value == null ? '' : String(value) });
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function textAreaInput(value, onChange, rows = 3) {
  const input = el('textarea', { rows });
  input.value = value == null ? '' : String(value);
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

const ROTATIONS = [{ value: '0', label: '0\u00b0' }, { value: '90', label: '90\u00b0' }, { value: '180', label: '180\u00b0' }, { value: '270', label: '270\u00b0' }];

/** Edit a numeric property: live preview + one history entry per change. */
function propNumber(element, key, opts = {}) {
  return numberInput(element[key], (v) => {
    pushHistory();
    element[key] = clamp(v, opts.min == null ? 0 : opts.min, opts.max == null ? 9999 : opts.max);
    renderAll();
  }, opts);
}

function propText(element, key, onDone) {
  return textInput(element[key], (v) => {
    element[key] = v;
    if (onDone) onDone();
    renderElementList();
    renderPreview();
    renderOutput();
  });
}

function propCheck(element, key, label, onDone) {
  return checkInput(element[key], (v) => {
    pushHistory();
    element[key] = v;
    if (onDone) onDone();
    renderAll();
  }, label);
}

function propSelect(element, key, options, onDone) {
  return selectInput(element[key], options, (v) => {
    pushHistory();
    element[key] = v;
    if (onDone) onDone();
    renderAll();
  });
}


/* -------------------------------------------------------------- properties */

function renderProps() {
  const host = $('#props');
  if (!host) return;
  host.innerHTML = '';
  const element = selectedElement();
  if (!element) {
    host.append(el('p', { class: 'small muted', text: t('designer.selectHint', 'Select an element to edit it, or add a new one from the palette.') }));
    return;
  }
  host.append(
    el('div', { class: 'spread mb1' }, [
      el('span', { class: 'badge brand', text: element.type }),
      el('span', { class: 'small muted mono', text: '#' + String(element.id).slice(0, 5) })
    ])
  );

  /* position + size, shared by every element */
  const pos = el('div', { class: 'prop-grid' }, [
    field('X (mm)', propNumber(element, 'x', { step: '0.5', min: 0, max: state.doc.width })),
    field('Y (mm)', propNumber(element, 'y', { step: '0.5', min: 0, max: state.doc.height }))
  ]);
  if (element.type !== 'qrcode') {
    pos.append(field('Width (mm)', propNumber(element, 'w', { step: '0.5', min: 1, max: state.doc.width })));
  }
  if (element.type === 'image' || element.type === 'line' || element.type === 'box') {
    pos.append(field('Height (mm)', propNumber(element, 'h', { step: '0.5', min: element.type === 'line' ? 0 : 1, max: state.doc.height })));
  }
  if (element.type !== 'line' && element.type !== 'box') {
    pos.append(field('Rotation', propSelect(element, 'rotation', ROTATIONS)));
  }
  host.append(pos);

  if (element.type === 'text') {
    host.append(field(t('designer.text', 'Text'), textAreaInput(element.text, (v) => {
      element.text = v;
      renderElementList();
      renderPreview();
      renderOutput();
    }), 3), t('designer.textHint', '{{variable}} placeholders are replaced at print time.'));
    host.append(el('div', { class: 'prop-grid' }, [
      field('Font size (mm)', propNumber(element, 'fontSizeMm', { step: '0.5', min: 1, max: 40 })),
      field('Align', propSelect(element, 'align', [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }])),
      field('Line spacing', propNumber(element, 'lineHeight', { step: '0.1', min: 0.8, max: 3 }), t('designer.previewOnly', 'Preview and raster output')),
      field('Letter spacing', propNumber(element, 'letterSpacing', { step: '0.1', min: 0, max: 5 }), t('designer.previewOnly', 'Preview and raster output'))
    ]));
    host.append(propCheck(element, 'bold', 'Bold (ESC/POS, Star, ESC/P)'));
    host.append(propCheck(element, 'italic', 'Italic (preview / raster)'));
    host.append(propCheck(element, 'underline', 'Underline (preview / raster)'));
    host.append(propCheck(element, 'reverse', 'Inverse - white on black'));
  }

  if (element.type === 'barcode') {
    host.append(field('Data', propText(element, 'data')));
    host.append(field('Symbology', propSelect(element, 'symbology', SYMBOLOGIES.map((s) => ({ value: s.id, label: s.name + (s.kind === '2d' ? ' (2D)' : '') })))));
    const meta = SYMBOLOGY_BY_ID[element.symbology];
    if (meta) host.append(el('div', { class: 'hint', text: 'Allowed characters: ' + meta.chars }));
    host.append(el('div', { class: 'prop-grid' }, [
      field('Bar height (mm)', propNumber(element, 'heightMm', { step: '0.5', min: 3, max: 80 })),
      field('Narrow bar (mm)', propNumber(element, 'narrowMm', { step: '0.05', min: 0.1, max: 2 })),
      field('Human text (mm)', propNumber(element, 'textSizeMm', { step: '0.2', min: 1, max: 10 }))
    ]));
    host.append(propCheck(element, 'showText', 'Show the human readable text'));
  }

  if (element.type === 'qrcode') {
    host.append(field('Data', propText(element, 'data')));
    host.append(el('div', { class: 'prop-grid' }, [
      field('Size (mm)', propNumber(element, 'sizeMm', { step: '0.5', min: 4, max: 100 })),
      field('Error correction', propSelect(element, 'ecc', [
        { value: 'L', label: 'L - 7% recovery' },
        { value: 'M', label: 'M - 15% recovery' },
        { value: 'Q', label: 'Q - 25% recovery' },
        { value: 'H', label: 'H - 30% recovery' }
      ]))
    ]));
    host.append(el('div', { class: 'hint', text: t('designer.qrHint', 'Higher error correction survives scratches but makes the modules smaller.') }));
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
      pushHistory();
      element.src = dataUrl;
      element.mono = null;
      renderAllAsync();
    });
    host.append(field(t('action.upload'), file));
    if (element.src) host.append(el('div', { class: 'image-preview' }, [el('img', { src: element.src, alt: 'logo' })]));
    host.append(el('div', { class: 'prop-grid' }, [
      field('Threshold', propNumber(element, 'threshold', { step: '1', min: 0, max: 255 })),
      field('Dithering', propSelect(element, 'dither', [
        { value: 'floyd', label: 'Floyd-Steinberg' },
        { value: 'atkinson', label: 'Atkinson' },
        { value: 'bayer', label: 'Ordered (Bayer)' },
        { value: 'none', label: 'Plain threshold' }
      ])),
      field('Fit', propSelect(element, 'fit', [
        { value: 'xMidYMid meet', label: 'Contain (keep ratio)' },
        { value: 'none', label: 'Stretch to box' },
        { value: 'xMidYMid slice', label: 'Cover (crop)' }
      ]))
    ]));
    host.append(propCheck(element, 'invert', 'Invert black / white'));
  }

  if (element.type === 'line') {
    host.append(el('div', { class: 'prop-grid' }, [
      field('Length (mm)', propNumber(element, 'w', { step: '0.5', min: 0.5, max: state.doc.width })),
      field('Thickness (mm)', propNumber(element, 'thicknessMm', { step: '0.1', min: 0.1, max: 5 }))
    ]));
    host.append(el('div', { class: 'row tight mt1' }, [
      el('button', { class: 'btn small', text: 'Horizontal', onclick: () => { pushHistory(); element.h = 0; element.w = element.w || 40; renderAll(); } }),
      el('button', { class: 'btn small', text: 'Vertical', onclick: () => { pushHistory(); element.w = 0; element.h = element.h || 20; renderAll(); } })
    ]));
  }

  if (element.type === 'box') {
    host.append(el('div', { class: 'prop-grid' }, [
      field('Thickness (mm)', propNumber(element, 'thicknessMm', { step: '0.1', min: 0.1, max: 5 })),
      field('Corner radius (mm)', propNumber(element, 'radiusMm', { step: '0.5', min: 0, max: 20 }), t('designer.radiusHint', 'Honoured by ZPL; other languages print square corners'))
    ]));
    host.append(propCheck(element, 'filled', 'Filled (solid black)'));
  }

  host.append(el('div', { class: 'row tight mt2' }, [
    el('button', { class: 'btn small', text: t('action.duplicate'), onclick: () => duplicateElement(element) }),
    el('button', { class: 'btn small ghost', text: t('action.copy', 'Copy'), onclick: () => copyElement(element) }),
    el('button', { class: 'btn small danger', text: t('action.delete'), onclick: () => removeElement(element) })
  ]));
}

/* -------------------------------------------------------------- arrange */

function renderArrange() {
  const host = $('#arrange');
  if (!host) return;
  host.innerHTML = '';
  const disabled = !selectedElement();
  const mk = (label, title, fn, attrs = {}) => el('button', { class: 'btn small ghost', text: label, title, disabled, ...attrs, onclick: fn });
  host.append(
    el('div', { class: 'arrange-grid' }, [
      mk('\u21E4', 'Align left', () => alignElement('left'), { 'data-align': 'left' }),
      mk('\u2194', 'Centre horizontally', () => alignElement('center-h'), { 'data-align': 'center-h' }),
      mk('\u21E5', 'Align right', () => alignElement('right'), { 'data-align': 'right' }),
      mk('\u21E1', 'Align top', () => alignElement('top'), { 'data-align': 'top' }),
      mk('\u2195', 'Centre vertically', () => alignElement('center-v'), { 'data-align': 'center-v' }),
      mk('\u21E3', 'Align bottom', () => alignElement('bottom'), { 'data-align': 'bottom' })
    ])
  );
  host.append(
    el('div', { class: 'row tight mt1' }, [
      mk(t('designer.toFront', 'Bring to front'), 'Bring to front', () => zOrder(selectedElement(), 'front'), { 'data-arrange': 'front' }),
      mk(t('designer.toBack', 'Send to back'), 'Send to back', () => zOrder(selectedElement(), 'back'), { 'data-arrange': 'back' })
    ])
  );
  host.append(
    el('div', { class: 'row tight mt1' }, [
      mk(t('designer.duplicate', 'Duplicate'), t('action.duplicate'), () => duplicateElement(selectedElement()), { 'data-arrange': 'duplicate' }),
      mk(t('designer.copy', 'Copy'), t('action.copy', 'Copy'), () => copyElement(selectedElement()), { 'data-arrange': 'copy' }),
      mk(t('designer.paste', 'Paste'), t('designer.paste', 'Paste'), () => pasteElement(), { 'data-arrange': 'paste' })
    ])
  );
  host.append(
    el('div', { class: 'row tight mt1' }, [
      mk(t('designer.undo', 'Undo'), 'Undo (Ctrl+Z)', () => undo(), { 'data-arrange': 'undo' }),
      mk(t('designer.redo', 'Redo'), 'Redo (Ctrl+Shift+Z)', () => redo(), { 'data-arrange': 'redo' })
    ])
  );
}


/* ------------------------------------------------------------- document */

function renderDocProps() {
  const host = $('#doc-props');
  if (!host) return;
  host.innerHTML = '';
  host.append(field('Name', textInput(state.doc.name, (v) => { state.doc.name = v; renderOutput(); })));
  host.append(el('div', { class: 'prop-grid' }, [
    field('Width (mm)', numberInput(state.doc.width, (v) => { pushHistory(); state.doc.width = clamp(v, 5, 400); renderAll(); }, { step: '1', min: 5 })),
    field('Height (mm)', numberInput(state.doc.height, (v) => { pushHistory(); state.doc.height = clamp(v, 5, 500); renderAll(); }, { step: '1', min: 5 })),
    field('Gap (mm)', numberInput(state.doc.gap, (v) => { pushHistory(); state.doc.gap = clamp(v, 0, 20); renderAll(); }, { step: '0.5', min: 0 })),
    field('DPI', selectInput(String(state.doc.dpi), [
      { value: '203', label: '203 dpi (8 dots/mm)' },
      { value: '300', label: '300 dpi' },
      { value: '600', label: '600 dpi' },
      { value: '180', label: '180 dpi (impact)' },
      { value: '360', label: '360 dpi (inkjet)' }
    ], (v) => { pushHistory(); state.doc.dpi = Number(v); renderAll(); })),
    field('Copies', numberInput(state.doc.copies, (v) => { state.doc.copies = clamp(v, 1, 99); renderOutput(); }, { step: '1', min: 1, max: 99 })),
    field('Media', selectInput(state.doc.mediaType, [
      { value: 'gap', label: 'Gap / die-cut' },
      { value: 'blackmark', label: 'Black mark' },
      { value: 'continuous', label: 'Continuous' }
    ], (v) => { pushHistory(); state.doc.mediaType = v; renderOutput(); })),
    field('Darkness', numberInput(state.doc.darkness, (v) => { state.doc.darkness = clamp(v, 0, 15); renderOutput(); }, { step: '1', min: 0, max: 15 })),
    field('Speed (ips)', numberInput(state.doc.speed, (v) => { state.doc.speed = clamp(v, 1, 14); renderOutput(); }, { step: '1', min: 1, max: 14 })),
    field('Rotation', selectInput(String(state.doc.rotation || 0), ROTATIONS, (v) => { pushHistory(); state.doc.rotation = Number(v); renderOutput(); })),
    field('Printer profile', selectInput(state.doc.profile, DEVICE_PROFILES.map((p) => ({ value: p.id, label: p.name })), (v) => { pushHistory(); state.doc.profile = v; renderOutput(); }))
  ]));
  host.append(checkInput(state.doc.cut !== false, (v) => { state.doc.cut = v; renderOutput(); }, 'Cut after printing (receipt printers)'));
  host.append(el('div', { class: 'hint', text: t('designer.docHint', 'Sizes are in millimetres; the dots column shows what the printer receives.') }));
}

/* ------------------------------------------------------------- variables */

function renderVars() {
  const host = $('#var-list');
  if (!host) return;
  host.innerHTML = '';
  state.doc.variables = state.doc.variables || {};
  const vars = state.doc.variables;
  const keys = Object.keys(vars);
  if (!keys.length) host.append(el('p', { class: 'small muted', text: t('designer.noVars', 'No variables yet. Use {{name}} in text and fill the value here.') }));
  for (const key of keys) {
    host.append(el('div', { class: 'row tight' }, [
      el('span', { class: 'mono small var-chip', text: '{{' + key + '}}' }),
      textInput(vars[key], (v) => { vars[key] = v; renderPreview(); renderOutput(); }),
      el('button', { class: 'icon-btn small ghost', text: '\u2715', title: t('action.delete'), onclick: () => { pushHistory(); delete vars[key]; renderVars(); renderAll(); } })
    ]));
  }
  host.append(el('div', { class: 'row tight mt1' }, [
    el('input', { id: 'new-var-name', type: 'text', placeholder: t('designer.varName', 'variable name') }),
    el('button', { class: 'btn small', text: t('action.add'), onclick: addVariable })
  ]));
}

function addVariable() {
  const input = $('#new-var-name');
  const name = input && input.value ? input.value.trim().replace(/[^\w.-]/g, '') : '';
  if (!name) return;
  pushHistory();
  state.doc.variables = state.doc.variables || {};
  if (state.doc.variables[name] == null) state.doc.variables[name] = '';
  if (input) input.value = '';
  renderVars();
  renderAll();
}


/* ----------------------------------------------------------- preview */

/** Bounding box of an element in millimetres (used by the canvas overlay). */
function elementBoxMm(element) {
  const size = elementSize(element);
  return {
    x: Number(element.x) || 0,
    y: Number(element.y) || 0,
    w: Math.max(0.5, size.w || 10),
    h: Math.max(0.5, size.h || 5)
  };
}

function snapMm(value) {
  const step = state.snap ? state.gridMm : 0.5;
  return Math.max(0, Math.round(value / step) * step);
}

function renderPreview() {
  const host = $('#preview');
  if (!host) return;
  const dots = mmToDots(state.doc.width, state.doc.dpi);
  const px = Math.max(80, Math.round(dots * state.zoom));
  state.paperPx = px;
  host.innerHTML = renderLabelSvg(state.doc, { grid: state.grid, showBorder: true, displayWidth: px + 'px' }) + renderOverlay();
  const sizeLabel = $('#size-label');
  if (sizeLabel) {
    sizeLabel.textContent = `${state.doc.width} x ${state.doc.height} mm @ ${state.doc.dpi} dpi (${dots} x ${mmToDots(state.doc.height, state.doc.dpi)} dots)`;
  }
  const zoomLabel = $('#zoom-label');
  if (zoomLabel) zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
  renderRulers(px);
  wirePreviewDrag();
}

const HANDLE_IDS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function handlePoints(box) {
  const { x, y, w, h } = box;
  return {
    nw: { x, y }, n: { x: x + w / 2, y }, ne: { x: x + w, y },
    e: { x: x + w, y: y + h / 2 }, se: { x: x + w, y: y + h }, s: { x: x + w / 2, y: y + h },
    sw: { x, y: y + h }, w: { x, y: y + h / 2 }
  };
}

/** Selection outline + resize handles, drawn in label (dot) coordinates. */
function renderOverlay() {
  const dots = mmToDots(state.doc.width, state.doc.dpi);
  const hDots = mmToDots(state.doc.height, state.doc.dpi);
  const parts = [`<svg class="preview-overlay" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dots} ${hDots}" preserveAspectRatio="none" aria-hidden="true">`];
  const element = selectedElement();
  if (element) {
    const mm = elementBoxMm(element);
    const x = mmToDots(mm.x, state.doc.dpi);
    const y = mmToDots(mm.y, state.doc.dpi);
    const w = mmToDots(mm.w, state.doc.dpi);
    const h = mmToDots(mm.h, state.doc.dpi);
    const stroke = Math.max(1, dots * 0.0025);
    const hs = clamp(dots * 0.022, 4, 16);
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#4f46e5" stroke-width="${stroke}" stroke-dasharray="${stroke * 5} ${stroke * 4}"/>`);
    const points = handlePoints({ x, y, w, h });
    for (const id of HANDLE_IDS) {
      const p = points[id];
      parts.push(`<rect x="${p.x - hs / 2}" y="${p.y - hs / 2}" width="${hs}" height="${hs}" fill="#ffffff" stroke="#4f46e5" stroke-width="${stroke}" data-handle="${id}"/>`);
    }
    if (element.locked) parts.push(`<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" font-size="${hs}" fill="#94a3b8">locked</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

/* -------------------------------------------------------------- rulers */

function renderRulers(px) {
  const pxPerMm = px / Math.max(1, state.doc.width);
  const hHost = $('#ruler-h');
  const vHost = $('#ruler-v');
  if (hHost) hHost.innerHTML = rulerSvg(state.doc.width, pxPerMm, 'h');
  if (vHost) vHost.innerHTML = rulerSvg(state.doc.height, pxPerMm, 'v');
}

function rulerSvg(lengthMm, pxPerMm, dir) {
  const size = Math.max(1, Math.round(lengthMm * pxPerMm));
  const thick = 16;
  const w = dir === 'h' ? size : thick;
  const h = dir === 'h' ? thick : size;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#f1f5f9"/>`);
  const step = pxPerMm >= 6 ? 1 : 5;
  for (let mm = 0; mm <= lengthMm + 0.001; mm += step) {
    const p = Math.round(mm * pxPerMm);
    const major = Math.abs(mm % 5) < 0.001;
    const len = major ? thick : thick * 0.45;
    if (dir === 'h') {
      parts.push(`<line x1="${p}" y1="${thick - len}" x2="${p}" y2="${thick}" stroke="#94a3b8" stroke-width="1"/>`);
      if (major && mm > 0) parts.push(`<text x="${p + 2}" y="9" font-size="9" fill="#64748b">${Math.round(mm)}</text>`);
    } else {
      parts.push(`<line x1="${thick - len}" y1="${p}" x2="${thick}" y2="${p}" stroke="#94a3b8" stroke-width="1"/>`);
      if (major && mm > 0) parts.push(`<text x="2" y="${p - 2}" font-size="9" fill="#64748b">${Math.round(mm)}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('');
}


/* ---------------------------------------------------------- interactions */

/** Drag / resize / select directly on the preview with millimetre precision. */
function wirePreviewDrag() {
  const paper = $('#preview');
  if (!paper) return;
  const svg = paper.querySelector('svg');
  if (!svg || typeof svg.addEventListener !== 'function') return;

  const pointMm = (ev) => {
    const rect = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : { left: 0, top: 0, width: 0 };
    const width = rect.width || state.paperPx || 1;
    const scale = state.doc.width / width;
    return { x: (ev.clientX - rect.left) * scale, y: (ev.clientY - rect.top) * scale };
  };

  const handleAt = (pt, box) => {
    const tol = Math.max(1.2, state.doc.width * 0.02);
    const points = handlePoints(box);
    for (const id of HANDLE_IDS) {
      const p = points[id];
      if (Math.abs(pt.x - p.x) <= tol && Math.abs(pt.y - p.y) <= tol) return id;
    }
    return null;
  };

  const contains = (box, pt) => pt.x >= box.x - 0.5 && pt.x <= box.x + box.w + 0.5 && pt.y >= box.y - 0.5 && pt.y <= box.y + box.h + 0.5;

  let drag = null;

  svg.addEventListener('pointerdown', (ev) => {
    const pt = pointMm(ev);
    const element = selectedElement();
    if (element && !element.locked) {
      const box = elementBoxMm(element);
      const handle = handleAt(pt, box);
      if (handle) {
        pushHistory();
        drag = { mode: 'resize', handle, element, box, start: pt };
        if (svg.setPointerCapture) svg.setPointerCapture(ev.pointerId);
        return;
      }
      if (contains(box, pt)) {
        pushHistory();
        drag = { mode: 'move', element, start: pt, originX: element.x, originY: element.y };
        if (svg.setPointerCapture) svg.setPointerCapture(ev.pointerId);
        return;
      }
    }
    const hit = [...state.doc.elements].reverse().find((e) => contains(elementBoxMm(e), pt));
    if (hit) {
      selectElement(hit.id);
      if (!hit.locked) {
        pushHistory();
        drag = { mode: 'move', element: hit, start: pt, originX: hit.x, originY: hit.y };
        if (svg.setPointerCapture) svg.setPointerCapture(ev.pointerId);
      }
    } else {
      selectElement(null);
    }
  });

  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const pt = pointMm(ev);
    const dx = pt.x - drag.start.x;
    const dy = pt.y - drag.start.y;
    if (drag.mode === 'move') {
      drag.element.x = clamp(snapMm(drag.originX + dx), 0, Math.max(0, state.doc.width - 0.5));
      drag.element.y = clamp(snapMm(drag.originY + dy), 0, Math.max(0, state.doc.height - 0.5));
    } else {
      const box = drag.box;
      const id = drag.handle;
      let x = box.x;
      let y = box.y;
      let w = box.w;
      let h = box.h;
      if (id.includes('e')) w = Math.max(2, snapMm(box.w + dx));
      if (id.includes('s')) h = Math.max(2, snapMm(box.h + dy));
      if (id.includes('w')) { const nw = Math.max(2, snapMm(box.w - dx)); x = box.x + (box.w - nw); w = nw; }
      if (id.includes('n')) { const nh = Math.max(2, snapMm(box.h - dy)); y = box.y + (box.h - nh); h = nh; }
      drag.element.x = clamp(x, 0, state.doc.width);
      drag.element.y = clamp(y, 0, state.doc.height);
      drag.element.w = clamp(w, 0.5, state.doc.width - drag.element.x);
      if (drag.element.type === 'image' || drag.element.type === 'line' || drag.element.type === 'box') {
        drag.element.h = clamp(h, 0, state.doc.height - drag.element.y);
      }
    }
    renderPreview();
  });

  const finish = () => {
    if (!drag) return;
    drag = null;
    renderProps();
    renderOutput();
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
  svg.addEventListener('pointerleave', finish);
}


/* ------------------------------------------------------------ output */

/** Rasterise the label once per document revision (canvas based). */
async function ensureRaster() {
  const signature = JSON.stringify(state.doc, (key, value) => (key === 'mono' ? undefined : value));
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
  $('#out-json').textContent = JSON.stringify(state.doc, (key, value) => (key === 'mono' ? undefined : value), 2);
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
  const rasterOut = $('#out-raster');
  if (rasterOut) rasterOut.textContent = bitmapToAscii(state.raster, { step: 2 });
  return state.raster;
}


/* ---------------------------------------------------------------- actions */

function newDoc() {
  pushHistory();
  state.doc = createLabelDoc({ preset: $('#preset').value, name: 'Arsin label' });
  state.selected = null;
  state.raster = null;
  renderAll();
  toast(t('action.reset') + ' \u2713', 'ok', 1600);
}

function slug(s) {
  return String(s || 'label').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'label';
}

function saveTemplate() {
  const name = state.doc.name || 'My label';
  const templates = store.get('templates', {});
  templates[name] = JSON.parse(JSON.stringify(state.doc, (key, value) => (key === 'mono' ? undefined : value)));
  store.set('templates', templates);
  toast(t('designer.savedTemplate', 'Template saved') + ': ' + name, 'ok');
}

function loadTemplate() {
  const templates = store.get('templates', {});
  const names = Object.keys(templates);
  const body = el('div', { class: 'stack' });
  if (!names.length) body.append(el('p', { class: 'small muted', text: t('designer.noTemplates', 'No saved templates yet.') }));
  for (const name of names) {
    body.append(el('div', { class: 'row spread' }, [
      el('span', { text: name }),
      el('div', { class: 'row tight' }, [
        el('button', { class: 'btn small', text: t('designer.load', 'Load'), onclick: () => { pushHistory(); state.doc = templates[name]; renderAll(); modal.close(); toast(t('designer.loaded', 'Loaded') + ' ' + name, 'ok'); } }),
        el('button', { class: 'btn small danger', text: t('action.delete'), onclick: () => { delete templates[name]; store.set('templates', templates); modal.close(); loadTemplate(); } })
      ])
    ]));
  }
  const modal = openModal({ title: t('designer.templates'), body });
}

function exportDoc() {
  download(slug(state.doc.name) + '.json', JSON.stringify(state.doc, (key, value) => (key === 'mono' ? undefined : value), 2), 'application/json');
}

async function importDoc(file) {
  try {
    const parsed = JSON.parse(await file.text());
    pushHistory();
    state.doc = parsed;
    if (!Array.isArray(state.doc.elements)) state.doc.elements = [];
    state.selected = null;
    await renderAllAsync();
    toast(t('designer.imported', 'Imported') + ' ' + file.name, 'ok');
  } catch (err) {
    toast('Import failed: ' + err.message, 'danger', 6000);
  }
}

function downloadOutput() {
  const result = state.output || renderLabel(state.doc, { lang: state.doc.language, mode: currentMode(), raster: state.raster });
  const ext = currentMode() === 'raster' ? 'bin' : ['zpl', 'tspl', 'epl', 'cpcl'].includes(state.doc.language) ? 'txt' : 'bin';
  download(`${slug(state.doc.name)}-${state.doc.language}.${ext}`, result.bytes, 'application/octet-stream');
}

function flatten(chunks) {
  const parts = [];
  for (const c of chunks) {
    if (typeof c === 'string') for (const ch of c) parts.push(ch.charCodeAt(0) & 0xff);
    else parts.push(...[...c].map((b) => b & 0xff));
  }
  return Uint8Array.from(parts);
}

function deviceModal() {
  const saved = store.get('session', {}) || {};
  const fallback = state.localDevice ? localDeviceBase() : 'arsin_print_server.local';
  const host = textInput(saved.host || fallback, () => {});
  const key = el('input', { type: 'password', value: saved.apiKey || '', placeholder: 'API key (optional)' });
  const body = el('div', {}, [
    el('p', { class: 'small', text: state.localDevice
      ? t('designer.localDevice', 'This page is served by the device itself - press Send to print straight away.')
      : t('designer.remoteDevice', 'Enter the address of the device on your network (mDNS name or IP).') }),
    field(t('device.host'), host, 'arsin_print_server.local / 192.168.4.1 / http://host:80'),
    field(t('device.apikey'), key)
  ]);
  openModal({
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
            const res = await state.device.printBytes(payload, { lang: state.doc.language, cut: wantCut && !bigJob, copies: state.doc.copies });
            if (bigJob && wantCut) {
              try {
                await state.device.sendCommand(state.doc.language, 'cut', {});
              } catch (e) {
                /* the printer may not have a cutter - not fatal */
              }
            }
            toast(t('designer.sent', 'Sent to the printer') + ' (' + (res.bytes || payload.length) + ' bytes)', 'ok');
          } catch (e) {
            toast('Send failed: ' + e.message, 'danger', 6000);
          }
        }
      }
    ]
  });
}


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
  renderArrange();
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


/* ------------------------------------------------------------------- wires */

function wire() {
  for (const btn of $$('[data-add]')) btn.addEventListener('click', () => addElement(btn.dataset.add));
  for (const btn of $$('[data-preset]')) {
    const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
    if (preset) btn.addEventListener('click', () => addElement(preset.type, preset));
  }
  $('#btn-new').addEventListener('click', newDoc);
  $('#btn-save-tpl').addEventListener('click', saveTemplate);
  $('#btn-load-tpl').addEventListener('click', loadTemplate);
  $('#btn-download').addEventListener('click', downloadOutput);
  $('#btn-copy').addEventListener('click', () => copyText(state.output && state.output.text ? state.output.text : $('#out-hex').textContent));
  $('#btn-print').addEventListener('click', deviceModal);
  $('#btn-export-json').addEventListener('click', exportDoc);
  $('#btn-import-json').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importDoc(f);
  });

  const zoomTo = (v) => { state.zoom = clamp(v, 0.2, 4); renderPreview(); };
  $('#btn-zoom-in').addEventListener('click', () => zoomTo(state.zoom + 0.25));
  $('#btn-zoom-out').addEventListener('click', () => zoomTo(state.zoom - 0.25));
  const reset = $('#btn-zoom-reset');
  if (reset) reset.addEventListener('click', () => zoomTo(1));

  $('#grid-toggle').addEventListener('change', (e) => { state.grid = e.target.checked; renderPreview(); });
  const snapToggle = $('#snap-toggle');
  if (snapToggle) {
    snapToggle.checked = state.snap;
    snapToggle.addEventListener('change', (e) => { state.snap = e.target.checked; });
  }
  const gridSize = $('#grid-size');
  if (gridSize) {
    gridSize.value = String(state.gridMm);
    gridSize.addEventListener('change', (e) => { state.gridMm = clamp(Number(e.target.value), 0.5, 10); });
  }

  const undoBtn = $('#btn-undo');
  if (undoBtn) undoBtn.addEventListener('click', undo);
  const redoBtn = $('#btn-redo');
  if (redoBtn) redoBtn.addEventListener('click', redo);

  const center = $('#btn-center');
  if (center) center.addEventListener('click', () => centerOnLabel());
  $('#btn-add-var').addEventListener('click', addVariable);

  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    const element = selectedElement();
    if (!element) return;
    if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateElement(element); return; }
    if (meta && e.key.toLowerCase() === 'c') { copyElement(element); return; }
    if (meta && e.key.toLowerCase() === 'v') { pasteElement(); return; }
    if (element.locked) return;
    const step = e.shiftKey ? 5 : state.snap ? state.gridMm : 0.5;
    let handled = true;
    if (e.key === 'ArrowLeft') element.x = clamp(element.x - step, 0, state.doc.width);
    else if (e.key === 'ArrowRight') element.x = clamp(element.x + step, 0, state.doc.width);
    else if (e.key === 'ArrowUp') element.y = clamp(element.y - step, 0, state.doc.height);
    else if (e.key === 'ArrowDown') element.y = clamp(element.y + step, 0, state.doc.height);
    else if (e.key === 'Delete' || e.key === 'Backspace') removeElement(element);
    else handled = false;
    if (handled) {
      e.preventDefault();
      renderAll();
    }
  });
}


/* ------------------------------------------------------------------- seed */

function seed() {
  state.doc.name = 'Arsin sample label';
  state.doc.variables = { serial: '00042', product: 'Arsin Print Server' };
  state.doc.elements = [
    { id: uid(), type: 'text', x: 4, y: 3, w: 42, text: '{{product}}', fontSizeMm: 4, bold: true, align: 'left', lineHeight: 1.2 },
    { id: uid(), type: 'text', x: 4, y: 9, w: 42, text: 'S/N {{serial}}', fontSizeMm: 3, align: 'left', lineHeight: 1.2 },
    { id: uid(), type: 'barcode', x: 4, y: 15, w: 30, symbology: 'code128', data: 'ARSIN-{{serial}}', heightMm: 9, narrowMm: 0.25, showText: true, textSizeMm: 2.6 },
    { id: uid(), type: 'qrcode', x: 33, y: 14, sizeMm: 13, data: 'ARSIN-{{serial}}', ecc: 'M' },
    { id: uid(), type: 'box', x: 1, y: 1, w: 48, h: 28, thicknessMm: 0.3, radiusMm: 0 }
  ];
  state.selected = state.doc.elements[0].id;
}

/* ------------------------------------------------------------------- boot */

fillSelects();
renderPalette();
wire();
seed();
updateHistoryButtons();
renderAllAsync();

detectLocalDevice().then((local) => {
  state.localDevice = !!local;
  const banner = $('#device-banner');
  if (banner && state.localDevice) {
    banner.hidden = false;
    banner.innerHTML = '';
    banner.append(el('span', { text: t('designer.servedByDevice', 'Served by the device itself - printing goes straight to the printer attached to this board.') }));
  }
});

