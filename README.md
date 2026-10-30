# Arsin Print Server

**Make any printer wireless - and flash it straight from the browser.**

Arsin Print Server is a complete, open print bridge for **ESP32**, **ESP8266** and **Raspberry Pi**
boards, plus a data-driven installer website that:

1. lets you pick a firmware variant and a board,
2. generates the wiring diagram, pin table, bill of materials and safety notes for that exact combination,
3. flashes the board from Chrome/Edge with **Web Serial** (or installs the Raspberry Pi service with one command),
4. gives the device a full web control panel: wireless configuration, label designer and maintenance console.

```
printer ──(UART / USB / parallel)── board ──(Wi-Fi / Bluetooth / Ethernet)── POS, PC, phone, ERP
                                       │
                                       └── http://arsin_print_server.local  (web app + REST API)
```

---

## Highlights

**Firmware variants** (data/apps.json):

| Variant | Radios / transports | Typical use |
| --- | --- | --- |
| `print-server-wifi` | Wi-Fi, TCP 9100, mDNS, web app | Make an old serial/USB printer a network printer |
| `print-server-bt-spp` | Bluetooth Classic SPP (+ Wi-Fi) | Pair the printer with Android POS / Windows |
| `print-server-ble` | Bluetooth LE GATT (+ Wi-Fi) | Phones, ESP32-S3/C3/C6 boards |
| `print-server-usbhost` | USB host (+ Wi-Fi) | USB thermal printers, no soldering |
| `print-server-serial` | Transparent TCP <-> UART bridge | Diagnostics, legacy software, custom protocols |
| `print-server-hybrid` | Wi-Fi + BLE + USB host + serial | Everything at once, enterprise deployments |
| `print-server-cups` | Raspberry Pi + CUPS + IPP/AirPrint | Inkjets/lasers that need a real driver |

**Supported boards** (data/boards.json - 15 entries, extensible):

| Family | Boards |
| --- | --- |
| ESP32 | DevKit V1, WROOM-32D/U, WROVER (PSRAM), S3-DevKitC-1, S3-Zero/XIAO, C3-DevKitM-1, C6-DevKitC-1, S2-DevKitM-1 |
| ESP8266 | NodeMCU v3 (ESP-12E), Wemos D1 mini, ESP-01S |
| Raspberry Pi | Zero 2 W, Zero W, 4 Model B, 5 |

**Printer languages**: ESC/POS, ZPL II, EPL2, TSPL/TSPL2, CPCL, Star Line Mode, ESC/P (impact + inkjet), IPL, DPL, plain ASCII - with per-language maintenance commands (self test, status, calibration, nozzle check, head cleaning, counter read/reset, darkness, media type, factory reset) and a raster fallback that prints on any printer accepting graphics.

**Web app (served by the device)**:

- first-run wizard + captive portal, stores up to 5 Wi-Fi networks and always reconnects to the last working one
- change the AP SSID/password, device name, owner, location, static IP, hostname (mDNS)
- label designer: mm-accurate canvas, text/logo/lines/boxes/variables, 8 barcode symbologies + QR/Data Matrix/PDF417 output, native command export or raster, template save/load, direct print to the device
- maintenance console: every documented action per language with hex preview, raw hex/escaped-text console, serial receive buffer, live log
- configuration editor for the whole config schema, backup/restore, OTA firmware update, reboot/factory reset, diagnostics export
- REST API with CORS so the hosted site can drive a device on your LAN; SSE status stream, webhooks, API keys

---

## Quick start

### A. Flash an ESP32 / ESP8266 from the browser

1. Open the installer page (`install.html`) - locally with `npm run serve`, or on GitHub Pages.
2. Choose the application, the transport, then your board. Read the generated wiring guide and wire the printer.
3. Press **Install** and pick the serial port (Chrome/Edge, HTTPS or localhost).
4. Join the Wi-Fi network `arsin_print_server` (password `arsin1234`), complete the wizard, then open `http://arsin_print_server.local`.
5. Add the printer to your POS/ERP as a network printer on port **9100** (raw).

### B. Raspberry Pi

```bash
# 1. flash Raspberry Pi OS Lite with Raspberry Pi Imager (set hostname/Wi-Fi/SSH in advanced options)
# 2. on the Pi:
curl -fsSL https://raw.githubusercontent.com/ArsinShaabani/Printer_middleware/main/firmware/raspberrypi/install.sh | sudo bash
# 3. open http://arsin_print_server.local and follow the wizard
```

The installer sets up the Python service, systemd unit, mDNS advertisement and optionally CUPS with IPP/AirPrint sharing.

### C. Build the firmware yourself

The ESP32 and ESP8266 cores are **not** part of the default Arduino index, so the
board-manager URLs must be registered before any core can be installed - without
this step `arduino-cli core install esp32:esp32` fails and no firmware is ever
produced:

```bash
arduino-cli config init --overwrite
arduino-cli config add board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json \
  https://arduino.esp8266.com/stable/package_esp8266com_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32
arduino-cli core install esp8266:esp8266

# the device web app (designer + maintenance + docs) is embedded in the sketch,
# so generate the asset headers first
node tools/build-web-assets.mjs && node tools/build-web-assets.mjs --min

# ESP32 Wi-Fi bridge (DevKit V1)
arduino-cli compile -b esp32:esp32:esp32 -e firmware/arsin_print_server \
  --build-property build.extra_flags="-DARSIN_VARIANT_WIFI"

# ESP32-S3 USB host build
arduino-cli compile -b esp32:esp32:esp32s3 -e firmware/arsin_print_server \
  --build-property build.extra_flags="-DARSIN_VARIANT_USBHOST"

# ESP8266 (NodeMCU v3)
arduino-cli compile -b esp8266:esp8266:nodemcuv2 -e firmware/arsin_print_server_esp8266
```

Variants: `ARSIN_VARIANT_WIFI`, `ARSIN_VARIANT_BT`, `ARSIN_VARIANT_BLE`, `ARSIN_VARIANT_USBHOST`,
`ARSIN_VARIANT_SERIAL`, `ARSIN_VARIANT_HYBRID` (see firmware/README.md for the full matrix).

`npm run check:firmware` runs the four checks that stand in for a compile on a machine without
the Arduino cores - they exist because ten real errors once reached CI unnoticed (see
[CHANGELOG.md](CHANGELOG.md)):

- `check-sources.mjs` - brace/include balance, ESP32/ESP8266 file sync, multi-line and one-line
  definitions, **functions declared but never defined** (a link error) and duplicate definitions
  (warnings when both copies sit inside `#if` blocks, errors otherwise);
- `check-syntax.mjs` - compiles the core-independent translation units with your local C++
  compiler against a small Arduino stub **and counts the arguments at every call site** of a
  function the sketch declares;
- `check-assets.mjs` - compiles the embedded asset tables (fallback + generated) for both sketches;
- `check-print-streaming.mjs` - keeps `/api/print` streaming instead of buffering.

---

## Project layout

```
index.html            landing page (feature overview, board table)
install.html          guided installer: app -> transport -> board -> wiring -> flash -> configure
designer.html         label / receipt designer
troubleshoot.html    maintenance & troubleshooting console
docs.html             documentation: wiring library, languages, REST API, add-a-board, FAQ
assets/css/app.css    responsive stylesheet (dark mode, RTL aware)
assets/js/core/       pure, unit-tested logic (no DOM)
  catalog.js          board/app catalogs, compatibility, wiring resolution
  wiring.js           SVG wiring diagram + printable guide generator
  commands.js         10 printer languages, 19 maintenance actions, raw parsing
  barcode.js          Code128/39/93, ITF, EAN-13/8, UPC-A, Codabar encoders
  qr.js               QR encoder (byte mode, versions 1-10, L/M/Q/H)
  raster.js           1bpp conversion, dithering, per-language raster commands
  label.js            label document model, native renderers, SVG preview
assets/js/ui/         page controllers (shell, home, install, designer, troubleshoot, docs, device client)
data/boards.json      board catalog (add your own here or import it in the wizard)
data/apps.json        firmware catalog with per-transport wiring recipes
firmware/             ESP32 / ESP8266 sketches + Raspberry Pi service
manifests/            generated esp-web-tools manifests (one per app+board)
firmware-bin/         compiled binaries published by CI (git-ignored)
tools/                build, validation and preview tooling
firmware/tools/       firmware static checks (sources, embedded assets, streaming)
test/                 node:test suite (barcodes, QR, catalogs, wiring, commands, raster, labels, UI, designer, i18n)
```

## Development

```bash
npm install          # dev dependencies: jsdom, qrcode, bwip-js (reference encoders for the tests)
npm test             # unit tests: barcode/QR verified against bwip-js and qrcode
npm run validate     # catalog schema validation
npm run check:firmware  # firmware source, embedded asset and streaming checks
npm run build        # embed the web app into the firmware + regenerate manifests
npm run serve        # preview the site at http://localhost:8080
```

`npm run build` writes `firmware/arsin_print_server/web_assets.h` and
`firmware/arsin_print_server_esp8266/web_assets.h` (gzipped assets served straight from flash)
and `manifests/index.json`.

## Languages

The whole UI is bilingual (English + Persian, RTL aware) and the Persian dictionary is
enforced by `test/i18n.test.mjs`: the two dictionaries must define the same keys, every
`data-i18n` key used by a page must exist in both, and every maintenance action, catalog app,
transport and board family must have a translation. The Vazirmatn/Inter webfonts are loaded
with `display=swap` and fall back to the system stack, so the device pages still render
correctly on a network without internet access.

Translated: navigation, the landing page, the installer wizard, the wiring tables and guide
chrome, the label designer, the maintenance console, the documentation and the FAQ - including
the catalog metadata (app taglines/summaries/features/requirements, transport labels, board
families).

Still English by design: the technical wiring *recipe* prose (step-by-step instructions,
safety warnings, cable notes) authored in `data/apps.json`, plus board MCU/pin strings. Add a
`wiring.<app>.<transport>.*` block to the dictionary if you need those in another language.

The board serves the **whole** control panel - not just a status page:

| route | what it is |
| --- | --- |
| `/` | device home: live status, links to every tool |
| `/designer.html` | label & receipt designer (runs in your browser, talks to the board over its REST API) |
| `/troubleshoot.html` | maintenance & service console: self test, calibration, head cleaning, counters, raw hex console, configuration editor, OTA, backup/restore, diagnostics |
| `/docs.html` | wiring library, printer language reference, REST API and the FAQ |

Both `designer.html` and `troubleshoot.html` detect that they are being served by a device
(they probe `/api/health`) and then connect to `window.location.origin` automatically, so
there is no address to type in. The same pages work on the hosted site, where you enter the
device address (mDNS name or IP) instead.

The designer itself is a full editor: millimetre canvas with rulers, drag/resize handles and
snapping, ready-made presets, undo/redo, align/z-order tools, layers with lock, variables,
templates, and a complete property panel for every element (text, barcode, QR, image, line,
box) - plus the native command, hex, JSON and raster output panels.

### Adding a board

Boards are data. Either add an entry to `data/boards.json` in a pull request, or paste a board JSON
into the **Add board** dialog on the installer page (kept in your browser). Minimum shape:

```json
{
  "id": "my-board-01",
  "name": "My board 01",
  "family": "esp32",
  "mcu": "ESP32-WROOM-32E",
  "tool": { "kind": "esp-web-tools", "chipFamily": "ESP32", "fqbn": "esp32:esp32:esp32" },
  "radios": { "wifi": true, "ble": true, "btClassic": true, "usbHost": false },
  "pins": { "uartTx": "GPIO 17", "uartRx": "GPIO 16", "v5": "5V", "gnd": "GND", "usbDp": "GPIO 20", "usbDm": "GPIO 19" }
}
```

Pin *roles* (not pin numbers) are what the wiring recipes reference, so a new board immediately gets
correct diagrams, requirements and compatibility checks for every application.

### Adding an application

Add an entry to `data/apps.json` with `transports`, a `wiring` recipe per transport, `requires`
(families/radios) and `firmware` metadata. The installer, docs and build matrix pick it up
automatically.

---

## REST API (identical on ESP32, ESP8266 and Raspberry Pi)

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness probe |
| GET | `/api/info` | board, app, version, MAC, IP, hostname, transport, language, heap, RSSI |
| GET | `/api/status` | printer state, queue, counters, Wi-Fi, Bluetooth, USB, uptime |
| GET/POST | `/api/config` | read / write the full configuration JSON |
| POST | `/api/print` | raw print body (`application/octet-stream`), query `lang`, `cut`, `copies`; bodies larger than the device buffer are streamed straight to the printer |
| POST | `/api/command` | `{lang, action, params}` - build and run a maintenance command |
| POST | `/api/raw` | `{data, mode: hex\|text}` - send arbitrary bytes |
| GET | `/api/serial?since=N` | received bytes from the printer |
| GET | `/api/logs?since=N` | device log |
| GET/POST | `/api/wifi/scan`, `/api/wifi`, `/api/ap` | wireless management |
| POST | `/api/ota`, `/api/reboot`, `/api/factory-reset` | maintenance |
| GET/POST | `/api/backup` | configuration backup / restore |
| GET | `/events` | server-sent event status stream |

Examples:

```bash
curl http://arsin_print_server.local/api/health
printf '\x1b@Hello from Arsin\n\n\n\x1dV\x00' | curl -X POST --data-binary @- \
  -H 'Content-Type: application/octet-stream' \
  'http://arsin_print_server.local/api/print?lang=escpos&cut=1'
curl -X POST -H 'Content-Type: application/json' \
  -d '{"lang":"zpl","action":"selftest","params":{}}' \
  http://arsin_print_server.local/api/command
lpadmin -p Arsin_Labels -E -v socket://arsin_print_server.local:9100 -m raw
```

---

## CI / CD

The workflows live in [`ci/github-workflows/`](ci/github-workflows) and are enabled with one command
(the automation token used to prepare this repository has no `workflows` permission, so GitHub refuses
to create `.github/workflows/*` from this branch):

```bash
node tools/install-workflows.mjs     # copies them into .github/workflows/
git add .github/workflows && git commit -m 'ci: enable the workflows' && git push
```

Then set **Settings -> Pages -> Source: GitHub Actions** once. After that:

- `test.yml` - unit tests, catalog validation and the firmware static checks on every push / pull request.
- `deploy-pages.yml` - builds the web assets + manifests, compiles every board/variant pair, publishes the installer site (with browser flashing) to GitHub Pages.
- `build-firmware.yml` - compiles the same matrix and attaches the binaries to a GitHub release on tag pushes.

> **Why the firmware build needs care.** Neither `esp32:esp32` nor `esp8266:esp8266` is in the
> default Arduino index, so a plain `arduino-cli core install` fails on a workstation unless the
> board-manager URLs are registered first (see *Build the firmware yourself* above). GitHub's
> runner image already resolves `esp32:esp32`, so the workflows work there either way - they
> register the URLs anyway to make the step deterministic across runner images and CLI versions:
>
> ```yaml
> arduino-cli config init --overwrite || true
> arduino-cli config add board_manager.additional_urls \
>   https://espressif.github.io/arduino-esp32/package_esp32_index.json \
>   https://arduino.esp8266.com/stable/package_esp8266com_index.json
> arduino-cli core update-index
> ```
>
> The compile steps are `continue-on-error` so a broken sketch never blocks the site - which means
> a run can be **green while producing no firmware at all**. Always check the job summary: it must
> list the binaries under *Firmware binaries collected*. If it says
> "No firmware binaries were produced", open one of the *Compile …* jobs and read the compiler
> output; `npm run check:firmware` catches most of these classes of error locally.
>
> That is exactly how this project shipped for a while: ten real errors (an ambiguous overload, a
> missing include, a `uint16_t`/`uint32_t` mismatch, a missing `WiFiClient.h`, a call with one
> argument too few, an undefined function, a duplicate definition, five ESP8266 API differences and
> an ESP8266 DRAM overflow) hid behind a green run. Every one of them is listed with its fix in
> [CHANGELOG.md](CHANGELOG.md).

### Large print jobs

Labels can be big: a 100 x 150 mm shipping label as a raster image is easily 100 kB. The firmware
streams those bodies to the printer in bounded chunks instead of buffering them, so RAM stays flat
even on an ESP8266. On that streaming path the request query string is not visible to the firmware,
so `lang`/`cut`/`copies` fall back to the configured defaults - the web designer therefore sends an
explicit cut command after any job above 60 kB. Small jobs keep the full query-string behaviour.

## Security notes

- Everything runs on your LAN; no cloud service is involved. Optional webhooks only fire if configured.
- Set a web password and an API key for deployments where other people share the network.
- CORS can be disabled in the configuration if the hosted web app should not be able to talk to the device.
- The AP password must be at least 8 characters; change `arsin1234` before shipping a device.

## License

MIT - see [LICENSE](LICENSE).
