/**
 * Maintenance & troubleshooting console: device dashboard, per-language
 * maintenance commands, raw console, configuration editor, logs and OTA.
 */
import { initShell, $, $$, el, esc, t, toast, download, copyText, store, clamp, openModal, confirmDialog } from './shell.js';
import { ACTIONS, LANGUAGES, LANGUAGE_BY_ID, actionsForLanguage, buildCommand, parseRawInput, toHex, toAscii } from '../core/commands.js';
import { Device, DemoDevice, normalizeBase, demoConfig, detectLocalDevice, localDeviceBase } from './device.js';

initShell();

const state = {
  device: new DemoDevice(),
  connected: false,
  info: null,
  status: null,
  config: null,
  logs: [],
  serialNext: 0,
  logNext: 0,
  lang: 'escpos',
  timer: null
};

/* --------------------------------------------------------------- connection */

function setState(kind, text) {
  const badge = $('#dev-state');
  badge.className = 'badge ' + kind;
  badge.textContent = text;
}

async function connect(useDemo = false) {
  if (useDemo) {
    state.device = new DemoDevice();
    state.connected = true;
    setState('info', t('device.demo'));
    await refreshAll();
    return;
  }
  const host = normalizeBase($('#dev-host').value);
  const key = $('#dev-key').value;
  store.set('session', { host, apiKey: key });
  state.device = new Device(host, key);
  setState('', '...');
  try {
    await state.device.health();
    state.connected = true;
    setState('ok', t('device.online'));
    toast(t('device.online'), 'ok');
    await refreshAll();
  } catch (e) {
    state.connected = false;
    setState('danger', t('device.offline'));
    toast('Connection failed: ' + e.message, 'danger', 6000);
  }
}

async function refreshAll() {
  if (!state.connected) return;
  try {
    const [info, status] = await Promise.all([state.device.info(), state.device.status()]);
    state.info = info;
    state.status = status;
    renderDashboard();
    $('#dev-last').textContent = 'updated ' + new Date().toLocaleTimeString();
    if (!state.config) await loadConfig();
  } catch (e) {
    setState('danger', t('device.offline'));
  }
}

/* ---------------------------------------------------------------- dashboard */

function kv(node, pairs) {
  node.innerHTML = '';
  for (const [k, v] of pairs) {
    node.append(el('dt', { text: k }), el('dd', { text: v == null || v === '' ? '-' : String(v) }));
  }
}

function renderDashboard() {
  const s = state.status || {};
  const info = state.info || {};
  const yes = (v) => (v ? t('common.yes', 'yes') : t('common.no', 'no'));
  kv($('#dash-status'), [
    [t('tdash.state', 'State'), s.state],
    [t('tdash.printer', 'Printer'), (s.printer && s.printer.status) || '-'],
    [t('tdash.printerConnected', 'Printer connected'), yes(s.printer && s.printer.connected)],
    [t('tdash.lastReply', 'Last printer reply'), s.printer && s.printer.lastReply],
    [t('tdash.queue', 'Queue depth'), s.queue && s.queue.depth],
    [t('tdash.lastJob', 'Last job'), s.queue && s.queue.lastJobId],
    [t('tdash.uptime', 'Uptime'), info.uptimeMs ? Math.round(info.uptimeMs / 1000) + ' s' : '-'],
    [t('tdash.heap', 'Free heap'), info.freeHeap ? Math.round(info.freeHeap / 1024) + ' kB' : '-'],
    [t('tdash.version', 'Version'), (info.version || '') + ' ' + (info.build || '')],
    [t('tdash.boardApp', 'Board / app'), (info.board || '') + ' / ' + (info.app || '')],
    [t('tdash.transport', 'Transport'), info.transport],
    [t('tdash.language', 'Language'), info.language]
  ]);
  kv($('#dash-counters'), [
    [t('tdash.jobs', 'Jobs'), s.counters && s.counters.jobs],
    [t('tdash.bytes', 'Bytes'), s.counters && s.counters.bytes],
    [t('tdash.errors', 'Errors'), s.counters && s.counters.errors]
  ]);
  kv($('#dash-wifi'), [
    [t('tdash.mode', 'Mode'), (s.wifi && s.wifi.mode) || info.wifiMode],
    [t('tdash.ssid', 'SSID'), s.wifi && s.wifi.ssid],
    [t('tdash.ip', 'IP'), s.wifi && s.wifi.ip],
    [t('tdash.rssi', 'RSSI'), s.wifi && s.wifi.rssi != null ? s.wifi.rssi + ' dBm' : '-'],
    [t('tdash.mdns', 'mDNS'), info.mdns],
    [t('tdash.hostname', 'Hostname'), info.hostname]
  ]);
  kv($('#dash-io'), [
    [t('tdash.btEnabled', 'Bluetooth enabled'), yes(s.bt && s.bt.enabled)],
    [t('tdash.btConnected', 'Bluetooth connected'), yes(s.bt && s.bt.connected)],
    [t('tdash.btName', 'Bluetooth name'), s.bt && s.bt.name],
    [t('tdash.usbConnected', 'USB connected'), yes(s.usb && s.usb.connected)],
    [t('tdash.usbIds', 'USB VID/PID'), s.usb ? (s.usb.vid || '') + ' / ' + (s.usb.pid || '') : '-'],
    [t('tdash.usbDevice', 'USB device'), s.usb ? (s.usb.manufacturer || '') + ' ' + (s.usb.product || '') : '-']
  ]);
}

/* -------------------------------------------------------------- maintenance */

function fillLanguages() {
  const select = $('#maint-lang');
  for (const l of LANGUAGES) select.append(el('option', { value: l.id, text: l.name + ' - ' + l.vendor }));
  select.value = state.lang;
  select.addEventListener('change', () => {
    state.lang = select.value;
    renderMaintenance();
  });
}

function renderMaintenance() {
  const host = $('#maint-grid');
  host.innerHTML = '';
  const actions = actionsForLanguage(state.lang);
  $('#maint-count').textContent = t('troubleshoot.count', '{supported} of {total} actions supported by {name}')
    .replace('{supported}', String(actions.filter((a) => a.supported).length))
    .replace('{total}', String(actions.length))
    .replace('{name}', (LANGUAGE_BY_ID[state.lang] || {}).name || '');
  for (const action of actions) {
    const card = el('div', { class: 'card pad-sm' + (action.supported ? '' : ' disabled') }, [
      el('div', { class: 'spread' }, [
        el('strong', { text: t('maint.action.' + action.id, action.name) }),
        el('span', { class: 'badge ' + (action.confidence === 'standard' ? 'ok' : action.confidence === 'vendor' ? 'info' : 'warn'), text: t('common.confidence.' + action.confidence, action.confidence) })
      ]),
      el('p', { class: 'small muted', text: t('maint.action.' + action.id + '.desc', action.desc) })
    ]);
    const params = {};
    if (action.params && action.params.length) {
      const grid = el('div', { class: 'prop-grid mb1' });
      for (const p of action.params) {
        let input;
        if (p.type === 'select') {
          input = el('select');
          for (const o of p.options) input.append(el('option', { value: o.value, text: o.label }));
          input.value = p.default;
          input.addEventListener('change', () => { params[p.id] = input.value; updatePreview(); });
        } else {
          input = el('input', { type: 'number', value: String(p.default), min: p.min, max: p.max });
          input.addEventListener('input', () => { params[p.id] = Number(input.value); updatePreview(); });
        }
        params[p.id] = p.default;
        grid.append(el('div', { class: 'field' }, [el('label', { text: p.label }), input]));
      }
      card.append(grid);
    }
    card.append(el('div', { class: 'row tight' }, [
      el('button', { class: 'btn small', text: t('troubleshoot.preview'), onclick: () => showPreview(action.id, params) }),
      el('button', { class: 'btn small primary', text: t('action.send'), disabled: !action.supported, onclick: () => runAction(action.id, params) })
    ]));
    if (action.note) card.append(el('p', { class: 'small muted mt1 mb0', text: action.note }));
    host.append(card);
  }
  function updatePreview() {
    /* parameters are captured by reference; nothing to do until send */
  }
}

function showPreview(actionId, params) {
  try {
    const cmd = buildCommand(state.lang, actionId, params);
    $('#maint-preview').textContent = [
      'Action : ' + cmd.actionName + ' (' + cmd.langName + ')',
      'Bytes  : ' + cmd.bytes.length,
      'Hex    : ' + cmd.hex,
      'ASCII  : ' + cmd.ascii,
      cmd.text ? 'Text   : ' + cmd.text : '',
      'Note   : ' + (cmd.note || '')
    ].filter(Boolean).join('\n');
  } catch (e) {
    $('#maint-preview').textContent = 'Error: ' + e.message;
  }
}

async function runAction(actionId, params) {
  try {
    const cmd = buildCommand(state.lang, actionId, params);
    showPreview(actionId, params);
    const res = await state.device.sendCommand(state.lang, actionId, params);
    toast('Sent ' + cmd.actionName + ' (' + (res.bytes != null ? res.bytes : cmd.bytes.length) + ' bytes)', 'ok');
    logConsole('>> ' + cmd.actionName + ' :: ' + cmd.hex);
    await refreshAll();
  } catch (e) {
    toast('Action failed: ' + e.message, 'danger', 6000);
  }
}

/* ------------------------------------------------------------------ console */

function logConsole(line) {
  const out = $('#console-out');
  const stamp = new Date().toLocaleTimeString();
  out.textContent += `[${stamp}] ${line}\n`;
  out.scrollTop = out.scrollHeight;
}

function wireConsole() {
  const send = async () => {
    const value = $('#console-input').value;
    if (!value.trim()) return;
    const mode = $('#console-mode').value;
    const bytes = parseRawInput(value, mode);
    if ($('#console-echo').checked) logConsole('>> ' + toHex(bytes) + '   |' + toAscii(bytes) + '|');
    try {
      const res = await state.device.rawSend(value, mode);
      if (res && res.hex) logConsole('<< ' + res.hex);
      else if (res && res.ok) logConsole('<< sent ' + (res.bytes != null ? res.bytes : bytes.length) + ' bytes');
    } catch (e) {
      logConsole('!! ' + e.message);
    }
  };
  $('#console-send').addEventListener('click', send);
  $('#console-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
  });
  $('#console-clear').addEventListener('click', () => { $('#console-out').textContent = ''; });
  $('#console-save').addEventListener('click', () => download('arsin-console.txt', $('#console-out').textContent, 'text/plain'));
  for (const btn of $$('[data-quick]')) {
    btn.addEventListener('click', () => {
      $('#console-input').value = btn.dataset.quick;
      $('#console-mode').value = 'hex';
    });
  }
}

async function pollSerial() {
  if (!state.connected) return;
  try {
    const res = await state.device.serial(state.serialNext);
    if (res && res.data) {
      state.serialNext = res.next != null ? res.next : state.serialNext + 1;
      logConsole('<< ' + res.data);
    }
  } catch (e) {
    /* devices without serial replies simply skip */
  }
}

async function pollLogs() {
  if (!state.connected) return;
  try {
    const res = await state.device.logs(state.logNext);
    if (res && res.lines && res.lines.length) {
      state.logNext = res.next != null ? res.next : state.logNext + res.lines.length;
      for (const line of res.lines) state.logs.push(line);
      const out = $('#logs-out');
      out.textContent = state.logs.map((l) => `[${l.t}] ${l.level.toUpperCase().padEnd(5)} ${l.msg}`).join('\n');
      out.scrollTop = out.scrollHeight;
    }
  } catch (e) {
    /* ignore */
  }
}

/* -------------------------------------------------------------- config form */

const CONFIG_FIELDS = [
  { path: 'device.name', label: 'Device name', type: 'text' },
  { path: 'device.owner', label: 'Owner', type: 'text' },
  { path: 'device.location', label: 'Location', type: 'text' },
  { path: 'ap.enabled', label: 'Access point enabled', type: 'bool' },
  { path: 'ap.ssid', label: 'Access point SSID', type: 'text' },
  { path: 'ap.password', label: 'Access point password', type: 'text' },
  { path: 'sta.enabled', label: 'Join a Wi-Fi network', type: 'bool' },
  { path: 'sta.ssid', label: 'Wi-Fi SSID', type: 'text' },
  { path: 'sta.password', label: 'Wi-Fi password', type: 'text' },
  { path: 'sta.hostname', label: 'Hostname (mDNS)', type: 'text' },
  { path: 'sta.alwaysReconnect', label: 'Always reconnect', type: 'bool' },
  { path: 'sta.dhcp', label: 'DHCP', type: 'bool' },
  { path: 'sta.ip', label: 'Static IP', type: 'text' },
  { path: 'sta.gateway', label: 'Gateway', type: 'text' },
  { path: 'sta.subnet', label: 'Subnet mask', type: 'text' },
  { path: 'sta.dns', label: 'DNS server', type: 'text' },
  { path: 'printer.name', label: 'Printer name', type: 'text' },
  { path: 'printer.language', label: 'Printer language', type: 'select', options: LANGUAGES.map((l) => ({ value: l.id, label: l.name })) },
  { path: 'printer.profile', label: 'Device profile', type: 'select', options: [{ value: 'receipt', label: 'Receipt / POS' }, { value: 'label', label: 'Label printer' }, { value: 'inkjet', label: 'Inkjet' }, { value: 'impact', label: 'Impact / dot matrix' }] },
  { path: 'printer.transport', label: 'Transport', type: 'select', options: [{ value: 'uart', label: 'UART / serial' }, { value: 'usbhost', label: 'USB host' }, { value: 'bt', label: 'Bluetooth' }, { value: 'ble', label: 'Bluetooth LE' }, { value: 'parallel', label: 'Parallel' }, { value: 'network', label: 'Network' }] },
  { path: 'printer.baud', label: 'Baud rate', type: 'number', min: 300, max: 921600, step: 300 },
  { path: 'printer.dataBits', label: 'Data bits', type: 'number', min: 5, max: 8 },
  { path: 'printer.parity', label: 'Parity', type: 'select', options: [{ value: 'none', label: 'None' }, { value: 'even', label: 'Even' }, { value: 'odd', label: 'Odd' }] },
  { path: 'printer.stopBits', label: 'Stop bits', type: 'select', options: [{ value: '1', label: '1' }, { value: '2', label: '2' }] },
  { path: 'printer.widthMm', label: 'Paper width (mm)', type: 'number', min: 20, max: 300, step: 1 },
  { path: 'printer.dpi', label: 'DPI', type: 'number', min: 180, max: 600, step: 1 },
  { path: 'printer.darkness', label: 'Darkness (0-15)', type: 'number', min: 0, max: 15 },
  { path: 'printer.speed', label: 'Speed (ips)', type: 'number', min: 1, max: 14 },
  { path: 'printer.mediaType', label: 'Media type', type: 'select', options: [{ value: 'gap', label: 'Gap' }, { value: 'blackmark', label: 'Black mark' }, { value: 'continuous', label: 'Continuous' }] },
  { path: 'printer.cut', label: 'Cut after print', type: 'bool' },
  { path: 'printer.charset', label: 'Charset', type: 'select', options: [{ value: 'cp437', label: 'CP437' }, { value: 'cp850', label: 'CP850' }, { value: 'cp1252', label: 'CP1252' }, { value: 'cp1256', label: 'CP1256 (Arabic)' }, { value: 'cp864', label: 'CP864 (Arabic)' }] },
  { path: 'bt.enabled', label: 'Bluetooth enabled', type: 'bool' },
  { path: 'bt.name', label: 'Bluetooth name', type: 'text' },
  { path: 'bt.pin', label: 'Bluetooth PIN', type: 'text' },
  { path: 'bt.ble', label: 'Use BLE instead of SPP', type: 'bool' },
  { path: 'usbHost.enabled', label: 'USB host enabled', type: 'bool' },
  { path: 'usbHost.autoDetect', label: 'Auto detect printer', type: 'bool' },
  { path: 'network.rawPort', label: 'Raw print port', type: 'number', min: 1, max: 65535 },
  { path: 'network.webPort', label: 'Web port', type: 'number', min: 1, max: 65535 },
  { path: 'network.mdns', label: 'mDNS advertisement', type: 'bool' },
  { path: 'network.keepAlive', label: 'TCP keep-alive', type: 'bool' },
  { path: 'security.webPassword', label: 'Web password', type: 'text' },
  { path: 'security.apiKey', label: 'API key', type: 'text' },
  { path: 'security.allowCors', label: 'Allow CORS from browsers', type: 'bool' },
  { path: 'logging.level', label: 'Log level', type: 'select', options: [{ value: 'error', label: 'error' }, { value: 'warn', label: 'warn' }, { value: 'info', label: 'info' }, { value: 'debug', label: 'debug' }] },
  { path: 'cloud.webhookUrl', label: 'Webhook URL (job events)', type: 'text' },
  { path: 'cloud.onJob', label: 'Call webhook after each job', type: 'bool' },
  { path: 'cloud.ntpServer', label: 'NTP server', type: 'text' },
  { path: 'cloud.timezone', label: 'Timezone', type: 'text' }
];

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

async function loadConfig() {
  try {
    state.config = await state.device.getConfig();
    renderConfig();
  } catch (e) {
    toast('Could not load the configuration: ' + e.message, 'danger');
  }
}

function renderConfig() {
  const host = $('#cfg-form');
  host.innerHTML = '';
  const config = state.config || demoConfig();
  for (const field of CONFIG_FIELDS) {
    let input;
    const value = getPath(config, field.path);
    if (field.type === 'bool') {
      input = el('input', { type: 'checkbox' });
      input.checked = !!value;
    } else if (field.type === 'select') {
      input = el('select');
      for (const o of field.options) input.append(el('option', { value: o.value, text: o.label }));
      input.value = value == null ? '' : String(value);
    } else if (field.type === 'number') {
      input = el('input', { type: 'number', value: value == null ? '' : String(value), min: field.min, max: field.max, step: field.step || 1 });
    } else {
      input = el('input', { type: field.path.includes('password') || field.path.includes('apiKey') ? 'text' : 'text', value: value == null ? '' : String(value) });
    }
    input.addEventListener('change', () => {
      let v;
      if (field.type === 'bool') v = input.checked;
      else if (field.type === 'number') v = Number(input.value);
      else v = input.value;
      setPath(state.config, field.path, v);
      $('#cfg-raw').textContent = JSON.stringify(state.config, null, 2);
    });
    host.append(el('div', { class: 'field' }, [el('label', { text: field.label }), input]));
  }
  $('#cfg-raw').textContent = JSON.stringify(config, null, 2);
}

/* ----------------------------------------------------------------- firmware */

function wireFirmware() {
  $('#ota-start').addEventListener('click', async () => {
    const file = $('#ota-file').files && $('#ota-file').files[0];
    if (!file) {
      toast('Choose a .bin file first', 'warn');
      return;
    }
    const progress = $('#ota-progress');
    progress.textContent = 'Uploading ' + file.name + ' (' + Math.round(file.size / 1024) + ' kB)...';
    try {
      const res = await state.device.ota(file);
      progress.textContent = 'Uploaded. ' + (res && res.ok ? 'Device is rebooting.' : 'Check the device.');
      toast('Firmware uploaded', 'ok');
    } catch (e) {
      progress.textContent = 'Failed: ' + e.message;
      toast('OTA failed: ' + e.message, 'danger', 6000);
    }
  });
  $('#backup-download').addEventListener('click', async () => {
    try {
      const json = await state.device.backup();
      download('arsin-print-server-backup.json', typeof json === 'string' ? json : JSON.stringify(json, null, 2), 'application/json');
    } catch (e) {
      download('arsin-print-server-backup.json', JSON.stringify(state.config || demoConfig(), null, 2), 'application/json');
    }
  });
  $('#backup-restore').addEventListener('click', () => $('#restore-file').click());
  $('#restore-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      await state.device.restore(text);
      state.config = JSON.parse(text);
      renderConfig();
      toast('Configuration restored', 'ok');
    } catch (err) {
      toast('Restore failed: ' + err.message, 'danger');
    }
  });
  $('#dev-reboot').addEventListener('click', () => confirmDialog('Reboot the device now?', async () => {
    try {
      await state.device.reboot();
      toast('Reboot command sent', 'ok');
    } catch (e) {
      toast('Reboot failed: ' + e.message, 'danger');
    }
  }, 'Reboot'));
  $('#dev-reset').addEventListener('click', () => confirmDialog('Factory reset clears Wi-Fi credentials and settings. Continue?', async () => {
    try {
      await state.device.factoryReset();
      toast('Factory reset requested', 'warn');
    } catch (e) {
      toast('Reset failed: ' + e.message, 'danger');
    }
  }, 'Factory reset'));
  $('#diag-run').addEventListener('click', async () => {
    const out = $('#diag-out');
    out.textContent = 'Collecting...';
    const lines = [];
    lines.push('Arsin Print Server diagnostics');
    lines.push('time: ' + new Date().toISOString());
    lines.push('address: ' + (state.device.base || 'demo'));
    try {
      const [info, status] = await Promise.all([state.device.info(), state.device.status()]);
      lines.push('info: ' + JSON.stringify(info));
      lines.push('status: ' + JSON.stringify(status));
      lines.push('config: ' + JSON.stringify(state.config || (await state.device.getConfig())));
    } catch (e) {
      lines.push('error: ' + e.message);
    }
    lines.push('user agent: ' + navigator.userAgent);
    out.textContent = lines.join('\n');
  });
}

/* -------------------------------------------------------------------- wires */

function wireWifi() {
  $('#wifi-scan').addEventListener('click', async () => {
    const host = $('#wifi-list');
    host.textContent = 'Scanning...';
    try {
      const res = await state.device.scanWifi();
      host.innerHTML = '';
      const ssid = el('input', { type: 'text', placeholder: t('troubleshoot.wifi.ssid') });
      const pass = el('input', { type: 'password', placeholder: t('troubleshoot.wifi.password') });
      for (const net of res.networks || []) {
        host.append(el('div', { class: 'row spread' }, [
          el('span', { text: net.ssid + (net.secure ? ' \ud83d\udd12' : '') }),
          el('span', { class: 'small muted', text: net.rssi + ' dBm' }),
          el('button', { class: 'btn small', text: t('troubleshoot.wifi.use'), onclick: () => { ssid.value = net.ssid; } })
        ]));
      }
      host.append(el('div', { class: 'grid cols-2 mt2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'SSID' }), ssid]),
        el('div', { class: 'field' }, [el('label', { text: 'Password' }), pass])
      ]));
      host.append(el('button', {
        class: 'btn primary',
        text: t('action.connect'),
        onclick: async () => {
          try {
            await state.device.joinWifi(ssid.value.trim(), pass.value, true);
            toast('Connecting to ' + ssid.value, 'ok');
          } catch (e) {
            toast('Join failed: ' + e.message, 'danger');
          }
        }
      }));
    } catch (e) {
      host.innerHTML = '<div class="callout warn">' + esc(e.message) + '</div>';
    }
  });
  $('#reset-counters').addEventListener('click', async () => {
    try {
      await state.device.resetCounters();
      toast('Counters reset', 'ok');
      await refreshAll();
    } catch (e) {
      toast('Reset failed: ' + e.message, 'danger');
    }
  });
  $('#cfg-reload').addEventListener('click', loadConfig);
  $('#cfg-save').addEventListener('click', async () => {
    try {
      const res = await state.device.setConfig(state.config);
      toast('Configuration saved' + (res && res.restartRequired ? ' - reboot required' : ''), 'ok');
    } catch (e) {
      toast('Save failed: ' + e.message, 'danger');
    }
  });
  $('#logs-refresh').addEventListener('click', pollLogs);
  $('#auto-refresh').addEventListener('change', (e) => {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (e.target.checked) {
      state.timer = setInterval(async () => {
        await refreshAll();
        await pollSerial();
        await pollLogs();
      }, 5000);
    }
  });
}

(function boot() {
  const saved = store.get('session', {}) || {};
  if (saved.host) $('#dev-host').value = saved.host;
  if (saved.apiKey) $('#dev-key').value = saved.apiKey;
  fillLanguages();
  renderMaintenance();
  wireConsole();
  wireWifi();
  wireFirmware();
  $('#dev-connect').addEventListener('click', () => connect(false));
  $('#dev-demo').addEventListener('click', () => connect(true));
  $('#auto-refresh').dispatchEvent(new Event('change'));
  // When the page is served by the board itself the device address is the
  // current origin - connect straight away instead of asking for an IP.
  detectLocalDevice().then((local) => {
    if (local) {
      const base = localDeviceBase();
      $('#dev-host').value = base;
      store.set('session', { host: base, apiKey: saved.apiKey || '' });
      const banner = $('#device-banner');
      if (banner) {
        banner.hidden = false;
        banner.innerHTML = '';
        banner.append(el('span', { text: t('troubleshoot.servedByDevice', 'This page is served by the device itself - it is already connected.') }));
      }
      connect(false);
    } else if (saved.host) {
      connect(false);
    } else {
      connect(true);
    }
  });
})();
