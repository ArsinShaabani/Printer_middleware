/** Documentation page: wiring library, language reference, API and FAQ. */
import { initShell, loadCatalog, $, el, esc, t, download, copyText, onChange } from './shell.js';
import { resolveWiring, boardsForApp, compatibility } from '../core/catalog.js';
import { renderWiringSvg, wiringToText } from '../core/wiring.js';
import { LANGUAGES, ACTIONS, actionsForLanguage, buildCommand } from '../core/commands.js';
import { SYMBOLOGIES } from '../core/barcode.js';

initShell();

const state = { catalog: null };

/* ------------------------------------------------------------ wiring library */

function renderWiringLibrary() {
  const appSelect = $('#wiring-app');
  const boardSelect = $('#wiring-board');
  appSelect.innerHTML = '';
  for (const app of state.catalog.apps) appSelect.append(el('option', { value: app.id, text: app.name }));

  const fillBoards = () => {
    const app = state.catalog.apps.find((a) => a.id === appSelect.value);
    boardSelect.innerHTML = '';
    for (const { board, compat } of boardsForApp(state.catalog, app.id)) {
      boardSelect.append(el('option', { value: board.id, text: board.name + (compat.ok ? '' : ' (partial)') }));
    }
    renderWiringDoc();
  };
  appSelect.addEventListener('change', fillBoards);
  boardSelect.addEventListener('change', renderWiringDoc);
  fillBoards();
}

function renderWiringDoc() {
  const host = $('#wiring-doc');
  host.innerHTML = '';
  const app = state.catalog.apps.find((a) => a.id === $('#wiring-app').value);
  const board = state.catalog.boards.find((b) => b.id === $('#wiring-board').value);
  if (!app || !board) return;
  for (const transport of app.transports) {
    const wiring = resolveWiring(board, app, transport.id);
    if (!wiring) continue;
    const compat = compatibility(board, app, transport.id);
    const card = el('div', { class: 'card mb2' }, [
      el('div', { class: 'spread' }, [
        el('h3', { class: 'mb0', text: wiring.title }),
        el('span', { class: 'badge ' + (compat.ok ? 'ok' : 'warn'), text: compat.ok ? 'compatible' : 'check requirements' })
      ]),
      el('p', { class: 'small', text: wiring.summary }),
      el('div', { class: 'diagram mb2', html: renderWiringSvg(wiring, board, app, { width: 960 }) }),
      el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [t('common.signal'), t('common.boardSide'), t('common.printerSide'), 'Cable'])]),
          el('tbody', {}, wiring.links.map((l) => el('tr', {}, [
            el('td', { text: l.signal }), el('td', { class: 'mono', text: l.board }), el('td', { class: 'mono', text: l.printer }), el('td', { class: 'small', text: l.cable })
          ])))
        ])
      ]),
      el('div', { class: 'row mt2' }, [
        el('button', { class: 'btn small', text: t('install.wiring.download'), onclick: () => download(`wiring-${app.id}-${board.id}-${transport.id}.md`, wiringToText(wiring, board, app), 'text/markdown') }),
        el('button', { class: 'btn small ghost', text: t('install.wiring.copy'), onclick: () => copyText(wiringToText(wiring, board, app)) })
      ])
    ]);
    if (wiring.warnings.length) {
      card.append(el('div', { class: 'callout warn mt2' }, [el('strong', { text: t('install.wiring.warnings') }), el('ul', {}, wiring.warnings.map((w) => el('li', { text: w })))]));
    }
    host.append(card);
  }
}

/* ------------------------------------------------------- language reference */

function renderLanguages() {
  const host = $('#languages-doc');
  host.innerHTML = '';
  host.append(el('p', { class: 'small', text: 'Arsin Print Server speaks the command set of your printer. Native commands are used where the language supports them; everything else is printed as a raster image, which works on any printer that accepts graphics.' }));
  const table = el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Language', 'Vendor', 'Device type', 'DPI', 'Charsets', 'Actions'])]),
      el('tbody', {}, LANGUAGES.map((l) => {
        const supported = actionsForLanguage(l.id).filter((a) => a.supported).length;
        return el('tr', {}, [
          el('td', {}, [el('strong', { text: l.name }), el('div', { class: 'small muted', text: l.note })]),
          el('td', { class: 'small', text: l.vendor }),
          el('td', { class: 'small', text: l.type }),
          el('td', { class: 'small', text: Array.isArray(l.dpi) ? l.dpi.join('/') : String(l.dpi) }),
          el('td', { class: 'small mono', text: l.charsets.join(', ') }),
          el('td', {}, [el('span', { class: 'badge ok', text: supported + '/' + ACTIONS.length })])
        ]);
      }))
    ])
  ]);
  host.append(table);

  host.append(el('h3', { class: 'mt3', text: 'Maintenance & troubleshooting actions' }));
  const actionTable = el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Action', 'Group', 'What it does', 'Example (ESC/POS)'])]),
      el('tbody', {}, ACTIONS.map((a) => {
        let hex = '';
        try {
          hex = buildCommand('escpos', a.id, {}).hex || '(not defined)';
        } catch (e) {
          hex = '(not defined)';
        }
        return el('tr', {}, [
          el('td', {}, [el('strong', { text: a.name })]),
          el('td', { class: 'small', text: a.group }),
          el('td', { class: 'small', text: a.desc }),
          el('td', { class: 'mono small', text: hex })
        ]);
      }))
    ])
  ]);
  host.append(actionTable);

  host.append(el('h3', { class: 'mt3', text: 'Barcode symbologies' }));
  host.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Symbology', 'Type', 'Characters'])]),
    el('tbody', {}, SYMBOLOGIES.map((s) => el('tr', {}, [el('td', { text: s.name }), el('td', { class: 'small', text: s.kind }), el('td', { class: 'small mono', text: s.chars })])))
  ])]));
}

/* --------------------------------------------------------------- API docs */

const API_ROWS = [
  ['GET', '/api/health', 'Liveness probe, returns text/plain "arsin-print-server ok"'],
  ['GET', '/api/info', 'Device identity: board, app, version, build, MAC, IP, hostname, transport, language, heap, RSSI'],
  ['GET', '/api/status', 'Live state: printer connection and status, queue depth, counters, Wi-Fi, Bluetooth, USB, heap, uptime'],
  ['GET', '/api/config', 'Full configuration JSON (same schema as the firmware)'],
  ['POST', '/api/config', 'Replace the configuration; answers {ok, restartRequired}'],
  ['POST', '/api/print', 'Raw print body (application/octet-stream); query lang, cut=0|1, copies'],
  ['POST', '/api/command', 'JSON {lang, action, params} - build and send a maintenance command on the device'],
  ['POST', '/api/raw', 'JSON {data, mode:hex|text} - send arbitrary bytes to the printer'],
  ['GET', '/api/serial?since=N', 'Received bytes from the printer (hex) plus the next cursor'],
  ['GET', '/api/logs?since=N', 'Device log lines plus the next cursor'],
  ['GET/POST', '/api/wifi/scan, /api/wifi', 'Scan networks and join/persist credentials'],
  ['POST', '/api/ap', 'Change the access point SSID/password or enable/disable it'],
  ['POST', '/api/ota', 'Firmware upload (raw .bin body)'],
  ['GET/POST', '/api/backup', 'Download or restore the configuration'],
  ['POST', '/api/counters/reset', 'Reset the bridge job counters'],
  ['POST', '/api/reboot, /api/factory-reset', 'Device control'],
  ['GET', '/events', 'Server-sent events stream with the status JSON every 2 seconds']
];

function renderApi() {
  const host = $('#api-doc');
  host.innerHTML = '';
  host.append(el('div', { class: 'callout info' }, [
    el('strong', { text: 'One API, three platforms' }),
    el('p', { class: 'small mb0', text: 'The ESP32, ESP8266 and Raspberry Pi builds expose the same REST API, so the same web app, the same scripts and the same monitoring work everywhere. Every /api response carries CORS headers so the hosted web app can drive a device on your LAN.' })
  ]));
  host.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Method', 'Endpoint', 'Description'].map((h) => el('th', { text: h })))]),
    el('tbody', {}, API_ROWS.map((r) => el('tr', {}, [el('td', { class: 'mono small', text: r[0] }), el('td', { class: 'mono small', text: r[1] }), el('td', { class: 'small', text: r[2] })])))
  ])]));

  host.append(el('h3', { class: 'mt3', text: 'Examples' }));
  host.append(el('pre', { text: [
    '# health check',
    'curl http://arsin_print_server.local/api/health',
    '',
    '# print a raw ESC/POS receipt',
    "printf '\\x1b@Hello from Arsin\\n\\n\\n\\x1dV\\x00' | curl -X POST --data-binary @- \\",
    '  -H "Content-Type: application/octet-stream" \\',
    '  "http://arsin_print_server.local/api/print?lang=escpos&cut=1"',
    '',
    '# run the printer self test',
    "curl -X POST -H 'Content-Type: application/json' \\",
    "  -d '{\"lang\":\"zpl\",\"action\":\"selftest\",\"params\":{}}' \\",
    '  http://arsin_print_server.local/api/command',
    '',
    '# add it to CUPS as a raw socket printer',
    'lpadmin -p Arsin_Labels -E -v socket://arsin_print_server.local:9100 -m raw',
    '',
    '# Windows (PowerShell) raw print',
    '$client = New-Object System.Net.Sockets.TcpClient("arsin_print_server.local", 9100)',
    '$stream = $client.GetStream()',
    '$bytes  = [Text.Encoding]::ASCII.GetBytes("Hello`n`n`n")',
    '$stream.Write($bytes, 0, $bytes.Length)',
    '$client.Close()'
  ].join('\n') }));
}

/* --------------------------------------------------------- add a board doc */

const BOARD_EXAMPLE = {
  id: 'my-board-01',
  name: 'My board 01',
  vendor: 'Community',
  family: 'esp32',
  mcu: 'ESP32-WROOM-32E',
  arch: 'xtensa',
  tool: { kind: 'esp-web-tools', chipFamily: 'ESP32', fqbn: 'esp32:esp32:esp32', flashSize: '4MB' },
  radios: { wifi: true, ble: true, btClassic: true, usbHost: false },
  pins: {
    uartTx: 'GPIO 17',
    uartRx: 'GPIO 16',
    v5: '5V',
    v3v3: '3V3',
    gnd: 'GND',
    usbDp: 'GPIO 20',
    usbDm: 'GPIO 19',
    spare1: 'GPIO 4'
  },
  io: { logicVoltage: '3.3V', input5vTolerant: false },
  power: { input: 'USB-C 5V', typicalMa: 250, maxMa: 700 },
  usb: { port: 'USB-C', chip: 'CP2102', note: 'Built-in UART bridge' },
  tags: ['wifi', 'bluetooth'],
  notes: ['Community board contributed by a user.']
};

function renderBoardsDoc() {
  const host = $('#boards-doc');
  host.innerHTML = '';
  host.append(el('p', { class: 'small', text: 'New boards are data, not code. Add an entry to data/boards.json in a pull request, or paste one into the Add board dialog on the install page - it is stored in your browser and immediately available in the wizard.' }));
  host.append(el('h3', { text: 'Pin roles' }));
  host.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Role', 'Used for'])]),
    el('tbody', {}, [
      ['uartTx', 'Board transmit line to the printer (TX2/TX0/D8 ...)'],
      ['uartRx', 'Board receive line from the printer, used for status and flow control'],
      ['uartTxAlt / uartRxAlt', 'Secondary UART (for example UART0 on ESP32 boards)'],
      ['usbDp / usbDm', 'USB data lines when the board acts as USB host'],
      ['usb5v / usbGnd', 'USB VBUS and ground for the USB host path'],
      ['v5 / v3v3 / gnd', 'Power and ground rails'],
      ['led / btn', 'Status LED and button'],
      ['spare1 / spare2', 'Optional extras: DTR/CTS flow control, strobe, RTS']
    ].map((r) => el('tr', {}, [el('td', { class: 'mono', text: '@' + r[0] }), el('td', { class: 'small', text: r[1] })])))
  ])]));
  host.append(el('h3', { class: 'mt3', text: 'Example board entry' }));
  host.append(el('pre', { text: JSON.stringify(BOARD_EXAMPLE, null, 2) }));
  host.append(el('div', { class: 'row' }, [
    el('button', { class: 'btn small', text: 'Copy the example', onclick: () => copyText(JSON.stringify(BOARD_EXAMPLE, null, 2)) }),
    el('button', { class: 'btn small ghost', text: 'Download it', onclick: () => download('my-board-01.json', JSON.stringify(BOARD_EXAMPLE, null, 2), 'application/json') }),
    el('a', { class: 'btn small primary', href: 'install.html', text: 'Import it in the wizard' })
  ]));
  host.append(el('div', { class: 'callout info mt2' }, [
    el('strong', { text: 'How compatibility works' }),
    el('p', { class: 'small mb0', text: 'An application declares required families and radios (for example Bluetooth Classic for the SPP build). The wizard greys out boards that cannot run it and explains exactly why, using the pin roles above - a missing pin role means the wiring cannot be generated.' })
  ]));
}

/* ------------------------------------------------------------- build docs */

function renderBuild() {
  const host = $('#build-doc');
  host.innerHTML = '';
  const card = el('div', { class: 'grid cols-2' });
  card.append(el('div', { class: 'card' }, [
    el('h3', { text: 'Firmware (arduino-cli)' }),
    el('pre', { text: [
      'arduino-cli core update-index',
      'arduino-cli core install esp32:esp32',
      'arduino-cli core install esp8266:esp8266',
      '',
      '# ESP32 Wi-Fi bridge for a DevKit V1',
      'arduino-cli compile -b esp32:esp32:esp32 -e firmware/arsin_print_server \\',
      '  --build-property build.extra_flags="-DARSIN_VARIANT_WIFI"',
      '',
      '# ESP32-S3 USB-host build',
      'arduino-cli compile -b esp32:esp32:esp32s3 -e firmware/arsin_print_server \\',
      '  --build-property build.extra_flags="-DARSIN_VARIANT_USBHOST"',
      '',
      '# ESP8266 (NodeMCU v3)',
      'arduino-cli compile -b esp8266:esp8266:nodemcuv2 -e firmware/arsin_print_server_esp8266'
    ].join('\n') })
  ]));
  card.append(el('div', { class: 'card' }, [
    el('h3', { text: 'Web app + manifests' }),
    el('pre', { text: [
      'npm install',
      'npm test                 # unit tests (barcode/QR/label/wiring/catalog)',
      'npm run validate         # catalog schema validation',
      'npm run build            # web assets + firmware manifests',
      'npm run serve            # local preview on http://localhost:8080'
    ].join('\n') }),
    el('p', { class: 'small muted', text: 'npm run build generates the firmware web asset header and manifests/index.json used by the browser installer. GitHub Actions runs the same commands, compiles every board/variant pair and publishes the site to GitHub Pages.' })
  ]));
  host.append(card);
  host.append(el('div', { class: 'callout info mt2' }, [
    el('strong', { text: 'Raspberry Pi' }),
    el('p', { class: 'small mb0', text: 'Flash Raspberry Pi OS Lite, then run firmware/raspberrypi/install.sh. It installs the Python service, systemd unit, mDNS advertisement and optionally CUPS with IPP/AirPrint sharing.' })
  ]));
}

/* -------------------------------------------------------------- FAQ */

const FAQ = [
  ['The board is not detected in the browser', 'Use a Chromium-based browser over HTTPS or localhost, a data-capable USB cable (many are charge-only) and the right driver (CP210x, CH34x, FTDI). Hold BOOT, tap RESET, release BOOT to force the bootloader, then retry.'],
  ['Nothing prints / garbage characters', 'Baud rate mismatch or wrong logic levels. Try 9600/19200/38400/115200 in the maintenance page and make sure the printer is 3.3V TTL or level shifted. Garbage output is almost always a baud or level problem.'],
  ['Printer prints only the first job', 'Flow control. Enable RTS/CTS in the configuration if your printer exposes BUSY/DTR, or lower the baud rate so the buffer cannot overrun.'],
  ['The device IP keeps changing', 'Give the board a DHCP reservation in your router, or set a static IP in Configuration > Network. mDNS arsin_print_server.local works without a fixed IP on most networks.'],
  ['Labels print shifted or half missing', 'Calibrate the media (Maintenance > Media calibration) and check the media type (gap / black mark / continuous) plus the label length in the designer. For ZPL also run ~JC.'],
  ['USB printer not detected', 'Only ESP32-S3/S2 and Raspberry Pi have USB host. Use a powered hub and a short cable; laser printers that need a proprietary driver must use the Raspberry Pi + CUPS build.'],
  ['Inkjet prints nothing / banding', 'Run the nozzle check and head cleaning from the maintenance page (ESC/P builds), then print a status sheet. Deep clogs usually need the vendor utility - the bridge cannot force a service-level cleaning cycle on every model.'],
  ['I need AirPrint / IPP Everywhere', 'Use the Raspberry Pi CUPS build: it installs CUPS, shares the printer over IPP and exposes the Arsin web app on top.'],
  ['How do I update the firmware later?', 'Upload the new .bin on the Firmware & backup tab (OTA) - no cable needed. The same tab can back up and restore the whole configuration.'],
  ['Can several printers share one board?', 'One printer per board is the supported configuration; a Raspberry Pi 4/5 can run several printers at once through CUPS.'],
  ['Does it work without internet?', 'Yes. Everything runs locally; only the OTA download and NTP need the internet.'],
  ['Is my print data private?', 'Yes: data goes from your app to the board and out to the printer. Nothing is sent to a cloud service. Optional webhooks only fire if you configure them.']
];

function renderFaq() {
  const host = $('#faq-doc');
  host.innerHTML = '';
  for (const [q, a] of FAQ) {
    host.append(el('details', { class: 'card mb2' }, [el('summary', { text: q }), el('p', { class: 'small mb0 mt1', text: a })]));
  }
}

/* ------------------------------------------------------------------- boot */

(async function boot() {
  renderLanguages();
  renderApi();
  renderBoardsDoc();
  renderBuild();
  renderFaq();
  try {
    state.catalog = await loadCatalog();
    renderWiringLibrary();
  } catch (e) {
    $('#wiring-doc').innerHTML = '<div class="callout danger">Could not load the catalog: ' + esc(e.message) + '</div>';
  }
  onChange(() => {
    renderLanguages();
    renderApi();
    renderBoardsDoc();
    renderBuild();
    renderFaq();
    renderWiringDoc();
  });
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-goto]');
    if (!link) return;
    e.preventDefault();
    const bar = $('.tabs[data-group="docs"]');
    const btn = bar && $('button[data-tab="' + link.dataset.goto + '"]', bar);
    if (btn) btn.click();
  });
})();
