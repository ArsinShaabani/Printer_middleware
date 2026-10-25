/**
 * Arsin Print Server - device client.
 *
 * Talks to the firmware REST API of an ESP32 / ESP8266 / Raspberry Pi running
 * arsin_print_server. A demo implementation mirrors the same interface so the
 * whole UI stays explorable without hardware.
 */

const DEFAULT_TIMEOUT = 6000;

/** Accepts "arsin_print_server.local", "192.168.4.1:8080", "http://x/" ... */
export function normalizeBase(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

export class Device {
  constructor(baseUrl, apiKey = '') {
    this.base = normalizeBase(baseUrl);
    this.apiKey = apiKey || '';
  }

  get isDemo() {
    return false;
  }

  url(path) {
    return this.base + (path.startsWith('/') ? path : '/' + path);
  }

  headers(extra = {}) {
    const h = { ...extra };
    if (this.apiKey) h['X-Api-Key'] = this.apiKey;
    return h;
  }

  async request(path, opts = {}) {
    const { method = 'GET', body, json, headers = {}, timeout = DEFAULT_TIMEOUT, raw = false } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const init = { method, headers: this.headers(headers), signal: controller.signal };
      if (body != null) init.body = body;
      const res = await fetch(this.url(path), init);
      const text = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (text.slice(0, 180) || res.statusText));
      if (raw) return text;
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (e) {
        return { text };
      }
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The device did not answer within ' + timeout / 1000 + 's');
      throw new Error(e.message || 'network error');
    } finally {
      clearTimeout(timer);
    }
  }

  health() {
    return this.request('/api/health', { timeout: 3000, raw: true });
  }
  info() {
    return this.request('/api/info');
  }
  status() {
    return this.request('/api/status');
  }
  getConfig() {
    return this.request('/api/config');
  }
  setConfig(config) {
    return this.request('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
  }

  /** Send raw print data (Uint8Array or ArrayBuffer). */
  printBytes(bytes, opts = {}) {
    const params = new URLSearchParams();
    if (opts.lang) params.set('lang', opts.lang);
    if (opts.cut != null) params.set('cut', opts.cut ? '1' : '0');
    if (opts.copies) params.set('copies', String(opts.copies));
    const q = params.toString();
    return this.request('/api/print' + (q ? '?' + q : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      timeout: 30000
    });
  }

  sendCommand(lang, action, params = {}) {
    return this.request('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, action, params })
    });
  }

  rawSend(data, mode = 'hex') {
    return this.request('/api/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, mode })
    });
  }

  serial(since = 0) {
    return this.request('/api/serial?since=' + encodeURIComponent(since));
  }
  logs(since = 0) {
    return this.request('/api/logs?since=' + encodeURIComponent(since));
  }
  scanWifi() {
    return this.request('/api/wifi/scan', { timeout: 20000 });
  }
  joinWifi(ssid, password, save = true) {
    return this.request('/api/wifi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid, password, save }),
      timeout: 20000
    });
  }
  wifiStatus() {
    return this.request('/api/wifi');
  }
  setAccessPoint(ssid, password, enabled = true) {
    return this.request('/api/ap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid, password, enabled })
    });
  }
  reboot() {
    return this.request('/api/reboot', { method: 'POST', timeout: 4000 });
  }
  factoryReset() {
    return this.request('/api/factory-reset', { method: 'POST', timeout: 8000 });
  }
  ota(file) {
    return this.request('/api/ota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
      timeout: 180000
    });
  }
  backup() {
    return this.request('/api/backup', { raw: true });
  }
  restore(json) {
    return this.request('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof json === 'string' ? json : JSON.stringify(json)
    });
  }
  resetCounters() {
    return this.request('/api/counters/reset', { method: 'POST' });
  }
  eventsUrl() {
    const q = this.apiKey ? '?key=' + encodeURIComponent(this.apiKey) : '';
    return this.url('/events' + q);
  }
}

/** Canned device used when nothing is connected, so the UI stays usable. */
export class DemoDevice extends Device {
  constructor() {
    super('demo://local');
    this.jobs = 12;
    this.bytes = 48213;
    this.start = Date.now();
    this.config = null;
  }

  get isDemo() {
    return true;
  }

  async request(path) {
    await new Promise((r) => setTimeout(r, 120));
    if (path.startsWith('/api/health')) return 'arsin-print-server ok (demo)';
    if (path.startsWith('/api/info')) {
      return {
        device: 'arsin_print_server',
        app: 'print-server-wifi',
        board: 'esp32-s3-devkitc-1',
        version: '1.0.0-demo',
        build: new Date().toISOString().slice(0, 10),
        mac: 'A0:B1:C2:D3:E4:F5',
        ip: '192.168.4.1',
        hostname: 'arsin-print-server',
        transport: 'usbhost',
        language: 'escpos',
        uptimeMs: Date.now() - this.start,
        freeHeap: 187432,
        rssi: -52,
        mdns: 'arsin_print_server.local',
        wifiMode: 'ap+sta'
      };
    }
    if (path.startsWith('/api/status')) {
      return {
        state: 'idle',
        printer: { connected: true, status: 'ok', lastReply: '1B 40 00' },
        queue: { depth: 0, lastJobId: 'job-' + this.jobs },
        counters: { jobs: this.jobs, bytes: this.bytes, errors: 0 },
        wifi: { ssid: 'ARSIN-OFFICE', ip: '192.168.1.42', rssi: -52, mode: 'ap+sta' },
        bt: { enabled: false, connected: false, name: 'arsin_print_server' },
        usb: { connected: true, vid: '0x04b8', pid: '0x0e15', manufacturer: 'EPSON', product: 'TM-T20III' },
        heap: 187432,
        uptimeMs: Date.now() - this.start
      };
    }
    if (path.startsWith('/api/config')) {
      if (!this.config) this.config = demoConfig();
      return this.config;
    }
    if (path.startsWith('/api/serial')) return { data: '1B 40 00 00', next: 4 };
    if (path.startsWith('/api/logs')) {
      return {
        lines: [
          { t: 1, level: 'info', msg: 'demo mode: no device connected' },
          { t: 2, level: 'info', msg: 'printer profile ESC/POS 80mm loaded' },
          { t: 3, level: 'warn', msg: 'paper sensor reported low paper 2 minutes ago' }
        ],
        next: 3
      };
    }
    if (path.startsWith('/api/wifi/scan')) {
      return { networks: [
        { ssid: 'ARSIN-OFFICE', rssi: -52, secure: true },
        { ssid: 'Shop-Guest', rssi: -71, secure: false },
        { ssid: 'TP-Link_2G', rssi: -83, secure: true }
      ] };
    }
    return { ok: true, demo: true };
  }

  async printBytes(bytes) {
    this.jobs += 1;
    this.bytes += bytes.length || 0;
    await new Promise((r) => setTimeout(r, 260));
    return { ok: true, jobId: 'job-' + this.jobs, bytes: bytes.length || 0, demo: true };
  }
}

/** Default configuration shown in demo mode (mirrors the firmware schema). */
export function demoConfig() {
  return {
    device: { name: 'arsin-print-01', owner: '', location: 'Front desk', notes: 'Demo device' },
    ap: { enabled: true, ssid: 'arsin_print_server', password: 'arsin1234', ip: '192.168.4.1' },
    sta: {
      enabled: true, ssid: 'ARSIN-OFFICE', password: '', dhcp: true, ip: '', gateway: '', subnet: '', dns: '',
      hostname: 'arsin-print-server', alwaysReconnect: true,
      saved: [{ ssid: 'ARSIN-OFFICE', password: '' }, { ssid: 'Shop-Guest', password: '' }]
    },
    printer: {
      name: 'EPSON TM-T20III', model: 'TM-T20III', language: 'escpos', profile: 'receipt', transport: 'usbhost',
      baud: 115200, dataBits: 8, parity: 'none', stopBits: 1, widthMm: 80, dpi: 203, cut: true, charset: 'cp437',
      darkness: 8, speed: 4, mediaType: 'continuous', strobeDelayUs: 3
    },
    bt: { enabled: false, name: 'arsin_print_server', pin: '0000', ble: false },
    usbHost: { enabled: true, autoDetect: true, maxPowerMa: 500 },
    network: { rawPort: 9100, webPort: 80, mdns: true, telnetDebug: false, keepAlive: true },
    security: { webPassword: '', apiKey: '', allowCors: true },
    logging: { level: 'info', bufferLines: 120 },
    cloud: { webhookUrl: '', onJob: false, ntpServer: 'pool.ntp.org', timezone: 'UTC' }
  };
}

/** Build the right client from a saved session (or a demo client). */
export function clientFromSession(session) {
  if (!session || !session.host) return new DemoDevice();
  return new Device(session.host, session.apiKey || '');
}
