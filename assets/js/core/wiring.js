/**
 * Arsin Print Server - wiring diagram generator (pure).
 *
 * Produces a self-contained SVG string for a resolved wiring recipe: the board
 * on the left, the printer / connector on the right, every required link drawn
 * as a labelled wire, plus a colour legend and safety notes. No DOM required.
 */

const SIGNAL_COLORS = {
  power: '#e5484d',
  gnd: '#111111',
  data: '#3b82f6',
  clock: '#8b5cf6',
  usb: '#0ea5e9',
  net: '#16a34a',
  radio: '#f59e0b',
  other: '#64748b'
};

const SIGNAL_KIND = [
  [/^(vcc|5v|3v3|3\.3v|power|\+5v|vin)/i, 'power'],
  [/^(gnd|ground|vss)/i, 'gnd'],
  [/usb|d\+|d-/i, 'usb'],
  [/^(eth|rj45|lan|net|cat5)/i, 'net'],
  [/^(clk|clock)/i, 'clock'],
  [/^(tx|rx|txd|rxd|data|sck|sda|scl|cts|rts|dtr|dsr)/i, 'data']
];

export function signalKind(signal) {
  const s = String(signal || '').trim();
  for (const [re, kind] of SIGNAL_KIND) if (re.test(s)) return kind;
  return 'other';
}

export function signalColor(signal) {
  return SIGNAL_COLORS[signalKind(signal)] || SIGNAL_COLORS.other;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a wiring diagram.
 * @param {object} wiring  result of resolveWiring()
 * @param {object} board   normalised board
 * @param {object} app     normalised app
 * @param {object} [opts]  {width, height}
 * @returns {string} SVG markup
 */
export function renderWiringSvg(wiring, board, app, opts = {}) {
  const width = opts.width || 960;
  const links = (wiring && wiring.links ? wiring.links : []).filter((l) => !l.unresolved);
  const boxW = 250;
  const boxX1 = 40;
  const boxX2 = width - boxW - 40;
  const topPad = 120;
  const rowH = 34;
  const height = opts.height || Math.max(420, topPad + Math.max(links.length, 3) * rowH + 150);

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" ` +
      `aria-label="${esc(wiring ? wiring.title : 'Wiring diagram')}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">`
  );
  parts.push(defs());

  parts.push(
    `<rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="url(#bg)"/>`,
    `<text x="40" y="48" font-size="22" font-weight="700" fill="#0f172a">${esc(wiring ? wiring.title : 'Wiring')}</text>`,
    `<text x="40" y="74" font-size="14" fill="#475569">${esc(app ? app.name : '')} &#183; ${esc(board ? board.name : '')} &#183; ${esc(
      board ? board.io.logicVoltage : ''
    )} logic</text>`
  );

  parts.push(box(boxX1, topPad - 30, boxW, height - topPad - 60, 'Board', board ? board.name : 'Board', '#eef2ff', '#4f46e5'));
  parts.push(subLines(boxX1 + 16, topPad + 10, [board ? board.mcu : '', board ? board.power.input : '', board ? board.usb.port : '']));

  parts.push(box(boxX2, topPad - 30, boxW, height - topPad - 60, 'Printer', printerTitle(app, wiring), '#ecfdf5', '#059669'));
  parts.push(
    subLines(boxX2 + 16, topPad + 10, [
      board ? `${board.io.logicVoltage} TTL / UART` : '',
      wiring && wiring.transportId ? `transport: ${wiring.transportId}` : '',
      wiring && wiring.power ? wiring.power : ''
    ])
  );

  if (!links.length) {
    const cx = (boxX1 + boxW + boxX2) / 2;
    const cy = topPad + 70;
    parts.push(
      `<g stroke="#f59e0b" fill="none" stroke-width="3" stroke-linecap="round">` +
        `<path d="M ${cx - 60} ${cy} q 30 -28 60 0"/>` +
        `<path d="M ${cx - 40} ${cy + 16} q 20 -18 40 0"/>` +
        `<circle cx="${cx}" cy="${cy + 34}" r="5" fill="#f59e0b" stroke="none"/>` +
        `</g>`,
      `<text x="${cx}" y="${cy + 72}" font-size="14" text-anchor="middle" fill="#92400e">No wires - wireless link</text>`
    );
  } else {
    links.forEach((l, i) => {
      const y = topPad + 20 + i * rowH;
      const color = signalColor(l.signal);
      const dash = l.required === false ? ' stroke-dasharray="6 5"' : '';
      parts.push(
        `<path d="M ${boxX1 + boxW} ${y} C ${boxX1 + boxW + 70} ${y}, ${boxX2 - 70} ${y}, ${boxX2} ${y}" ` +
          `fill="none" stroke="${color}" stroke-width="3"${dash} stroke-linecap="round"/>`,
        `<circle cx="${boxX1 + boxW}" cy="${y}" r="5" fill="${color}"/>`,
        `<circle cx="${boxX2}" cy="${y}" r="5" fill="${color}"/>`
      );
      const label = `${l.signal}: ${l.board} -> ${l.printer}`;
      const w = Math.min(430, 11 + label.length * 7.1);
      const cx = (boxX1 + boxW + boxX2) / 2;
      parts.push(
        `<rect x="${cx - w / 2}" y="${y - 13}" width="${w}" height="26" rx="13" fill="#ffffff" stroke="${color}" stroke-width="1.5" opacity="0.97"/>`,
        `<text x="${cx}" y="${y + 5}" font-size="12.5" text-anchor="middle" fill="#0f172a">${esc(label)}</text>`
      );
    });
  }

  const legend = ['power', 'gnd', 'data', 'usb', 'net'];
  legend.forEach((k, i) => {
    const x = 40 + i * 120;
    const y = height - 34;
    parts.push(
      `<rect x="${x}" y="${y - 10}" width="18" height="10" rx="3" fill="${SIGNAL_COLORS[k]}"/>`,
      `<text x="${x + 26}" y="${y}" font-size="12" fill="#475569">${k}</text>`
    );
  });
  parts.push('</svg>');
  return parts.join('\n');
}

function printerTitle(app, wiring) {
  if (!app) return 'Printer';
  const t = (app.transports || []).find((x) => x.id === (wiring && wiring.transportId));
  return t ? t.name : 'Printer';
}

function box(x, y, w, h, kicker, title, fill, stroke) {
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`,
    `<text x="${x + 16}" y="${y + 26}" font-size="11" letter-spacing="1.6" fill="${stroke}" font-weight="700">${esc(
      kicker.toUpperCase()
    )}</text>`,
    `<text x="${x + 16}" y="${y + 52}" font-size="16" font-weight="700" fill="#0f172a">${esc(clip(title, 24))}</text>`
  ].join('\n');
}

function subLines(x, y, lines) {
  return lines
    .filter(Boolean)
    .map((l, i) => `<text x="${x}" y="${y + 30 + i * 20}" font-size="12.5" fill="#475569">${esc(clip(l, 34))}</text>`)
    .join('\n');
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}

function defs() {
  return `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#f8fafc"/></linearGradient></defs>`;
}

/** Plain-text wiring guide (markdown) for copy/paste, docs and CI artefacts. */
export function wiringToText(wiring, board, app) {
  if (!wiring) return 'No wiring recipe for this combination.';
  const out = [];
  out.push(`# ${wiring.title}`);
  out.push(`Board: ${board.name} (${board.mcu})`);
  out.push(`App: ${app.name} - transport: ${wiring.transportId}`);
  if (wiring.summary) out.push('', wiring.summary);
  out.push('', '## Connections');
  if (!wiring.links.length) out.push('- Wireless only, no physical wiring required.');
  for (const l of wiring.links) {
    out.push(`- ${l.signal}: ${l.board}  ->  ${l.printer}  (${l.cable})${l.required === false ? ' [optional]' : ''}`);
    if (l.note) out.push(`  - ${l.note}`);
  }
  if (wiring.cables.length) {
    out.push('', '## Bill of materials');
    for (const c of wiring.cables) out.push(`- ${c.qty || 1} x ${c.item}${c.note ? ` - ${c.note}` : ''}`);
  }
  if (wiring.steps.length) {
    out.push('', '## Steps');
    wiring.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  }
  if (wiring.warnings.length) {
    out.push('', '## Warnings');
    for (const w of wiring.warnings) out.push(`- ${w}`);
  }
  if (wiring.prerequisites.length) {
    out.push('', '## Prerequisites');
    for (const p of wiring.prerequisites) out.push(`- ${p}`);
  }
  return out.join('\n');
}
