/**
 * Arsin Print Server - wiring diagram generator (pure).
 *
 * Produces a self-contained SVG string for a resolved wiring recipe. The layout
 * is deliberately schematic and readable: the board on the left and the printer
 * / connector on the right each list the exact pin they use, and every pin pair
 * is joined by one straight wire that carries the signal name. Long pin names
 * are wrapped instead of clipped, optional links are dashed, and the full
 * "signal: board pin -> printer pin" sentence is always present as an SVG
 * <title> (tooltip + screen reader) so no information is lost on small screens.
 * No DOM required.
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
 * Wrap a pin name into at most `maxLines` lines of roughly `maxChars`
 * characters. Words are never broken unless a single word is longer than the
 * line, in which case it is hard-split.
 */
function wrapText(value, maxChars, maxLines = 2) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
    while (line.length > maxChars) {
      lines.push(line.slice(0, maxChars));
      line = line.slice(maxChars);
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.join(' ').length < text.length) {
    const last = lines[lines.length - 1] || '';
    lines[lines.length - 1] = (last.length > maxChars - 2 ? last.slice(0, maxChars - 2) : last) + '\u2026';
  }
  return lines.slice(0, maxLines);
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
  const width = opts.width || 900;
  const allLinks = wiring && wiring.links ? wiring.links : [];
  const links = allLinks.filter((l) => !l.unresolved);
  const rows = links.length ? links : [{ placeholder: true }];

  /* Geometry: two device boxes with a wide wire lane between them, one row per
   * wire. Everything is sized so the labels stay legible when the SVG is scaled
   * down to a phone width (see .diagram svg { min-width } in app.css). */
  const boxW = 284;
  const boxX1 = 24;
  const boxX2 = width - boxW - 24;
  const wireX1 = boxX1 + boxW;
  const wireX2 = boxX2;
  const cx = (wireX1 + wireX2) / 2;
  const topPad = 96;
  const headerH = 108;
  const rowH = 56;
  const rowStart = topPad + headerH;
  const legendSpace = 120;
  const height = opts.height || Math.max(460, rowStart + rows.length * rowH + legendSpace);
  const boxH = Math.max(140, rowStart + rows.length * rowH + 24 - topPad);
  const logicVoltage = board && board.io ? board.io.logicVoltage : '';
  const optionalCount = links.filter((l) => l.required === false).length;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" ` +
      `aria-label="${esc(wiring ? wiring.title : 'Wiring diagram')}" font-family="ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">`
  );
  parts.push(defs());

  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="url(#bg)"/>`);

  /* ---- header ----------------------------------------------------------- */
  parts.push(
    `<text x="24" y="44" font-size="24" font-weight="700" fill="#0f172a">${esc(wiring ? wiring.title : 'Wiring')}</text>`,
    `<text x="24" y="72" font-size="14" fill="#475569">${esc(app ? app.name : '')} &#183; ${esc(board ? board.name : '')} &#183; ${esc(logicVoltage)} logic</text>`
  );
  if (links.length) {
    const summary = `${links.length} ${links.length === 1 ? 'wire' : 'wires'}` + (optionalCount ? ` &#183; ${optionalCount} optional` : '');
    parts.push(`<text x="${width - 24}" y="44" font-size="14" font-weight="600" fill="#4338ca" text-anchor="end">${summary}</text>`);
  }
  parts.push(
    `<line x1="24" y1="84" x2="${width - 24}" y2="84" stroke="#e2e8f0" stroke-width="1.5"/>`
  );

  /* ---- the two device boxes -------------------------------------------- */
  parts.push(box(boxX1, topPad, boxW, boxH, 'Board', board ? board.name : 'Board', '#eef2ff', '#4f46e5'));
  parts.push(subLines(boxX1 + 20, topPad, [board ? board.mcu : '', board && board.power ? board.power.input : ''], 32));

  parts.push(box(boxX2, topPad, boxW, boxH, 'Printer', printerTitle(app, wiring), '#ecfdf5', '#059669'));
  parts.push(
    subLines(
      boxX2 + 20,
      topPad,
      [
        logicVoltage ? `${logicVoltage} TTL / UART` : 'TTL / UART',
        wiring && wiring.transportId ? `transport: ${wiring.transportId}` : ''
      ],
      32
    )
  );

  /* ---- wires ------------------------------------------------------------ */
  if (!links.length) {
    const cy = Math.round(rowStart + rowH / 2);
    parts.push(
      `<path d="M ${wireX1} ${cy} q ${Math.round((wireX2 - wireX1) / 2)} -56 ${wireX2 - wireX1} 0" fill="none" stroke="#f59e0b" stroke-width="3" stroke-dasharray="8 6"/>`,
      `<text x="${cx}" y="${cy - 44}" text-anchor="middle" font-size="17" font-weight="700" fill="#b45309">No wires - wireless link</text>`,
      `<text x="${cx}" y="${cy + 34}" text-anchor="middle" font-size="14" fill="#64748b">This recipe needs no physical connection.</text>`
    );
  } else {
    rows.forEach((link, i) => {
      const y = Math.round(rowStart + rowH / 2 + i * rowH);
      const color = signalColor(link.signal);
      const label = `${link.signal}: ${link.board} -> ${link.printer}`;
      const dashed = link.required === false;
      const boardLines = wrapText(link.board, 26, 2);
      const printerLines = wrapText(link.printer, 30, 2);
      const group = ['<g>', `<title>${esc(label)}</title>`];

      // board-side pin name, right aligned against the box edge
      boardLines.forEach((line, li) => {
        const ly = boardLines.length === 1 ? y + 5 : y - 3 + li * 17;
        group.push(`<text x="${wireX1 - 18}" y="${ly}" text-anchor="end" font-size="15" fill="#0f172a">${esc(line)}</text>`);
      });
      // printer-side pin name, left aligned after the box edge
      printerLines.forEach((line, li) => {
        const ly = printerLines.length === 1 ? y + 5 : y - 3 + li * 17;
        group.push(`<text x="${wireX2 + 18}" y="${ly}" font-size="15" fill="#0f172a">${esc(line)}</text>`);
      });

      // the wire itself: exactly one horizontal cubic bezier per resolved link
      group.push(
        `<path d="M ${wireX1} ${y} C ${wireX1 + 80} ${y} ${wireX2 - 80} ${y} ${wireX2} ${y}" fill="none" stroke="${color}" stroke-width="3"${dashed ? ' stroke-dasharray="8 6"' : ''}/>`,
        `<circle cx="${wireX1}" cy="${y}" r="6" fill="${color}"/>`,
        `<circle cx="${wireX2}" cy="${y}" r="6" fill="${color}"/>`
      );

      // signal chip on the wire: the signal name in bold, the cable underneath
      const chipText = link.signal;
      const cw = Math.round(Math.max(84, Math.min(wireX2 - wireX1 - 24, 24 + chipText.length * 8.2)));
      group.push(
        `<rect x="${Math.round(cx - cw / 2)}" y="${y - 15}" width="${cw}" height="30" rx="15" fill="#ffffff" stroke="${color}" stroke-width="2"/>`,
        `<text x="${cx}" y="${y + 6}" text-anchor="middle" font-size="15" font-weight="700" fill="#0f172a">${esc(clip(chipText, Math.floor((cw - 24) / 8.2)))}</text>`
      );
      if (link.cable) {
        group.push(
          `<text x="${cx}" y="${y + 30}" text-anchor="middle" font-size="12" fill="#64748b">${esc(clip(link.cable, Math.floor((wireX2 - wireX1) / 6.4)))}</text>`
        );
      }
      if (dashed) group.push(`<text x="${cx}" y="${y - 24}" text-anchor="middle" font-size="12" font-weight="600" fill="#94a3b8">optional</text>`);
      group.push('</g>');
      parts.push(group.join('\n'));
    });
  }

  /* ---- legend ----------------------------------------------------------- */
  const legend = ['power', 'gnd', 'data', 'clock', 'usb', 'net'];
  const legendY = height - 30;
  parts.push(`<line x1="24" y1="${legendY - 30}" x2="${width - 24}" y2="${legendY - 30}" stroke="#e2e8f0" stroke-width="1.5"/>`);
  legend.forEach((k, i) => {
    const x = 24 + i * 96;
    parts.push(
      `<rect x="${x}" y="${legendY - 11}" width="22" height="11" rx="3" fill="${SIGNAL_COLORS[k]}"/>`,
      `<text x="${x + 30}" y="${legendY}" font-size="13" fill="#475569">${k}</text>`
    );
  });
  parts.push(
    `<text x="${width - 24}" y="${legendY}" text-anchor="end" font-size="13" fill="#475569">dashed wire = optional connection</text>`
  );
  if (wiring && wiring.power) {
    parts.push(`<text x="24" y="${height - 10}" font-size="12.5" fill="#94a3b8">${esc(clip(wiring.power, 120))}</text>`);
  }
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
    `<text x="${x + 20}" y="${y + 28}" font-size="12" letter-spacing="2" fill="${stroke}" font-weight="700">${esc(
      kicker.toUpperCase()
    )}</text>`,
    `<text x="${x + 20}" y="${y + 58}" font-size="19" font-weight="700" fill="#0f172a">${esc(clip(title, 24))}</text>`
  ].join('\n');
}

function subLines(x, y, lines, maxChars = 32) {
  return lines
    .filter(Boolean)
    .map((l, i) => `<text x="${x}" y="${y + 82 + i * 18}" font-size="13.5" fill="#475569">${esc(clip(l, maxChars))}</text>`)
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
