# Arsin Print Server - firmware

Firmware and host software for the Arsin Print Server: a wireless print bridge for
**ESP32**, **ESP32-S3/S2/C3/C6**, **ESP8266** and **Raspberry Pi**.  Every build
speaks the same REST/HTTP contract, advertises `arsin_print_server.local` over
mDNS and offers a raw print server on TCP 9100, so the browser installer and the
web application in this repository can talk to any of them.

```
firmware/
├── arsin_print_server/            ESP32 family sketch (Arduino, C++17)
├── arsin_print_server_esp8266/    ESP8266 sketch - same core, different .ino
├── raspberrypi/                   Python 3 service (standard library only)
│   ├── arsin_print_server.py
│   ├── install.sh
│   ├── arsin-print-server.service
│   └── config.example.json
├── tools/check-sources.mjs        structural source checker (see "Verification")
└── README.md
```

## 1. Build matrix (arduino-cli)

Install the cores once:

```bash
arduino-cli config init
arduino-cli config add board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json \
  https://arduino.esp8266.com/stable/package_esp8266com_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32      # 3.x is recommended (SSE support)
arduino-cli core install esp8266:esp8266  # 3.x
```

Then compile the sketch that matches the catalog board id:

| catalog board id      | board                       | arduino-cli FQBN                | sketch folder                 |
| --------------------- | --------------------------- | ------------------------------- | ----------------------------- |
| `esp32-devkit-v1`     | ESP32 DevKit V1 (WROOM-32)  | `esp32:esp32:esp32`             | `arsin_print_server`          |
| `esp32-wroom-32d`     | ESP32 WROOM-32D             | `esp32:esp32:esp32`             | `arsin_print_server`          |
| `esp32-wrover-devkit` | ESP32 WROVER (PSRAM)        | `esp32:esp32:esp32wrover`       | `arsin_print_server`          |
| `esp32-s3-devkitc-1`  | ESP32-S3 DevKitC-1          | `esp32:esp32:esp32s3`           | `arsin_print_server`          |
| `esp32-s3-zero`       | ESP32-S3 Zero               | `esp32:esp32:esp32s3`           | `arsin_print_server`          |
| `esp32-s2-devkit`     | ESP32-S2 DevKit             | `esp32:esp32:esp32s2`           | `arsin_print_server`          |
| `esp32-c3-devkitm-1`  | ESP32-C3 DevKitM-1          | `esp32:esp32:esp32c3`           | `arsin_print_server`          |
| `esp32-c6-devkitc-1`  | ESP32-C6 DevKitC-1          | `esp32:esp32:esp32c6`           | `arsin_print_server`          |
| `esp8266-nodemcu-v3`  | NodeMCU v2/v3               | `esp8266:esp8266:nodemcuv2`     | `arsin_print_server_esp8266`  |
| `esp8266-d1-mini`     | Wemos D1 mini               | `esp8266:esp8266:d1_mini`       | `arsin_print_server_esp8266`  |
| `esp8266-esp-01s`     | ESP-01S                     | `esp8266:esp8266:generic`       | `arsin_print_server_esp8266`  |

Examples:

```bash
# ESP32-S3, hybrid variant (Wi-Fi + BLE + USB host + serial)
arduino-cli compile --fqbn esp32:esp32:esp32s3 \
  --build-property compiler.cpp.extra_flags="-DARSIN_VARIANT_HYBRID" \
  firmware/arsin_print_server

# ESP32 classic, Bluetooth SPP variant
arduino-cli compile --fqbn esp32:esp32:esp32 \
  --build-property compiler.cpp.extra_flags="-DARSIN_VARIANT_BT" \
  firmware/arsin_print_server

# ESP8266 D1 mini (Wi-Fi + SoftwareSerial printer port)
arduino-cli compile --fqbn esp8266:esp8266:d1_mini firmware/arsin_print_server_esp8266

# flash it
arduino-cli upload --fqbn esp32:esp32:esp32s3 -p /dev/ttyACM0 firmware/arsin_print_server
```

`--output-dir build/<appId>/<boardId>/` is the layout the installer manifest
generator expects (`manifests/<appId>/<boardId>.json`).

### Web application assets

The sketch serves the web app from a generated header.  Build it first with the
repository tool (it writes `web_assets.h` into both sketch folders):

```bash
npm run build:web-assets        # -> firmware/arsin_print_server/web_assets.h
                                #    firmware/arsin_print_server_esp8266/web_assets.h
```

The header declares the shared contract:

```cpp
struct WebAsset { const char* path; const char* mime; const uint8_t* data;
                  unsigned int len; unsigned int originalLen; bool gz; };
static const WebAsset WEB_ASSETS[] = { ... };
static const unsigned int WEB_ASSETS_COUNT = N;
```

`web_assets.h` is generated and git ignored.  When it is missing (a plain
`arduino-cli compile` of this repository) the firmware falls back to
`web_assets_builtin.h`, a small self contained page, so the device is never
unreachable.  Gzipped entries (`gz == true`) are served with
`Content-Encoding: gzip`.

## 2. Variants (compile flags)

Add one `-D` flag; it selects the transport set **and** the catalog app id
reported by `/api/info`:

| flag                     | app id (`/api/info.app`)  | transports compiled in                   |
| ------------------------ | ------------------------- | ---------------------------------------- |
| `ARSIN_VARIANT_WIFI`     | `print-server-wifi`       | Wi-Fi web console, TCP 9100, mDNS, OTA   |
| `ARSIN_VARIANT_BT`       | `print-server-bt-spp`     | Bluetooth Classic SPP + serial + Wi-Fi   |
| `ARSIN_VARIANT_BLE`      | `print-server-ble`        | BLE GATT UART + serial + Wi-Fi           |
| `ARSIN_VARIANT_USBHOST`  | `print-server-usbhost`    | USB host printer driver + Wi-Fi          |
| `ARSIN_VARIANT_SERIAL`   | `print-server-serial`     | serial / COM bridge + Wi-Fi              |
| `ARSIN_VARIANT_HYBRID`   | `print-server-hybrid`     | everything the chip can do (default)     |
| `ARSIN_VARIANT_CUPS`     | `print-server-cups`       | Raspberry Pi only (the Python service)   |

Feature flags are pruned automatically per chip: the ESP32 classic has
Bluetooth Classic, the S3/S2 have a USB host port, the S2/C3/C6 have no
Bluetooth Classic, and the ESP8266 has neither.  Extra build properties:

| flag                            | effect                                                     |
| ------------------------------- | ---------------------------------------------------------- |
| `-DARSIN_UART_TX_PIN=n`         | printer TX GPIO (default 17 on ESP32, 15/D8 on ESP8266)    |
| `-DARSIN_UART_RX_PIN=n`         | printer RX GPIO (default 16 on ESP32, 13/D7 on ESP8266)    |
| `-DARSIN_UART_RTS_PIN=n`        | enables hardware flow control (ESP32, with `_CTS_PIN`)     |
| `-DARSIN_UART_CTS_PIN=n`        | CTS GPIO for hardware flow control                         |
| `-DARSIN_USB_VBUS_PIN=n`        | GPIO that switches the USB host VBUS (S3/S2)               |
| `-DARSIN_BOARD_ID=\"my-board\"` | override the board id reported by `/api/info`              |

### Wiring

| board        | printer TX/RX                | notes                                    |
| ------------ | ---------------------------- | ---------------------------------------- |
| ESP32        | GPIO17 → RX, GPIO16 ← TX     | UART2, UART0 stays the console           |
| ESP32-S3/S2  | GPIO17/16 or USB             | USB host needs GPIO19/20 free (S3)       |
| ESP32-C3/C6  | GPIO17/16                    | single radio, BLE only                   |
| ESP8266      | D8/GPIO15 → RX, D7/GPIO13 ← TX | SoftwareSerial @115200, UART0 console  |

Level shift 5 V TTL printers; feed the printer from its own supply and add a
1000 µF capacitor across 5 V/GND when the printer shares the board supply.

## 3. REST / HTTP contract

Every `/api/*` response carries `Access-Control-Allow-Origin: *` and
`Access-Control-Allow-Headers: Content-Type, X-Api-Key`; `OPTIONS` is answered
with `204`.  When `security.apiKey` is set, every state changing call needs the
`X-Api-Key` header.  When `security.webPassword` is set, the UI and
`/api/config` require HTTP basic auth (`admin` + that password).

| method | path                       | request                                   | response |
| ------ | -------------------------- | ----------------------------------------- | -------- |
| GET    | `/api/health`              | –                                         | `200 text/plain "arsin-print-server ok"` |
| GET    | `/api/info`                | –                                         | `{device,app,board,version,build,mac,ip,hostname,transport,language,uptimeMs,freeHeap,rssi,mdns,wifiMode}` |
| GET    | `/api/status`              | –                                         | `{state,printer,queue,counters,wifi,bt,usb,heap,uptimeMs}` |
| GET    | `/api/config`              | –                                         | config JSON (schema below) |
| POST   | `/api/config`              | config JSON (partial is fine)             | `{ok:true,restartRequired:bool}` |
| POST   | `/api/print`               | raw bytes, query `lang`,`cut=0|1`,`copies` | `{ok:true,jobId,bytes}` |
| POST   | `/api/command`             | `{lang,action,params}`                    | `{ok:true,hex,bytes,note}` |
| POST   | `/api/raw`                 | `{data,mode:"hex"|"text"}`                | `{ok:true,bytes}` |
| GET    | `/api/serial?since=N`      | –                                         | `{data:"1B 40 ..",next:N}` |
| GET    | `/api/logs?since=N`        | –                                         | `{lines:[{t,level,msg}],next:N}` |
| POST   | `/api/wifi/scan`           | –                                         | `{networks:[{ssid,rssi,secure}]}` |
| GET    | `/api/wifi`                | –                                         | `{ok,mode,sta,ap,saved,mdns}` |
| POST   | `/api/wifi`                | `{ssid,password,save}`                    | `{ok,ssid,ip,rssi,saved}` (5 networks kept) |
| POST   | `/api/ap`                  | `{ssid,password,enabled}`                 | `{ok,ap:{enabled,ssid,ip}}` |
| POST   | `/api/reboot`              | –                                         | `{ok:true,restarting:true}` |
| POST   | `/api/factory-reset`       | –                                         | `{ok:true,restartRequired:true}` |
| POST   | `/api/ota`                 | firmware image (ESP only)                 | `{ok:true,bytes,restarting:true}` |
| GET    | `/api/backup`              | –                                         | config JSON download |
| POST   | `/api/backup`              | config JSON                               | `{ok:true,restartRequired:true}` |
| POST   | `/api/counters/reset`      | –                                         | `{ok:true}` |
| GET    | `/events`                  | –                                         | `text/event-stream`, status JSON every 2 s |
| GET    | `/` + any unknown path     | –                                         | web application (PROGMEM assets) |
| TCP    | `:9100`                    | raw print bytes                           | streamed to the printer |

`POST /api/command` builds the byte sequence **on the device** for: `selftest`,
`status`, `config`, `initialize`, `feed`, `cut`, `drawer`, `calibrate`,
`density`, `media`, `counter`, `resetcounter`, `factoryreset`, `info`,
`barcode`, `nozzlecheck`, `headclean`, `align`, `saveconfig`, `barcodetest`,
in `escpos`, `zpl`, `tspl`, `epl`, `cpcl`, `starprnt`, `escp` or `plain`.  The
ESC/POS sequences are byte identical to `assets/js/core/commands.js`; the other
languages use the vendor native commands and return a `note`.

Examples:

```bash
curl http://arsin_print_server.local/api/health
curl -X POST http://arsin_print_server.local/api/command \
     -H 'Content-Type: application/json' \
     -d '{"lang":"escpos","action":"selftest","params":{}}'
# {"ok":true,"hex":"1B 40 1D 28 41 02 00 01 00","bytes":9,"note":"GS ( A execute printer test"}
curl -X POST 'http://arsin_print_server.local/api/print?lang=escpos&cut=1' \
     -H 'Content-Type: application/octet-stream' --data-binary @receipt.bin
printf 'hello\n' | nc arsin_print_server.local 9100     # raw path, no size limit
```

### Config schema

The schema is `/workspace/data/config.schema.json` when that file is present,
otherwise the document below.  The Raspberry Pi build adds `printer.device`,
`printer.cupsQueue`, `printer.networkHost`, `printer.networkPort` and
`printer.flowControl`.

```json
{"device":{"name":"arsin-print-01","owner":"","location":"","notes":""},
 "ap":{"enabled":true,"ssid":"arsin_print_server","password":"arsin1234","ip":"192.168.4.1"},
 "sta":{"enabled":true,"ssid":"","password":"","dhcp":true,"ip":"","gateway":"","subnet":"","dns":"",
        "hostname":"arsin-print-server","alwaysReconnect":true,"saved":[{"ssid":"","password":""}]},
 "printer":{"name":"Generic ESC/POS","model":"","language":"escpos","profile":"receipt","transport":"uart",
            "baud":115200,"dataBits":8,"parity":"none","stopBits":1,"widthMm":80,"dpi":203,"cut":true,
            "charset":"cp437","darkness":8,"speed":4,"mediaType":"gap","strobeDelayUs":3},
 "bt":{"enabled":false,"name":"arsin_print_server","pin":"0000","ble":false},
 "usbHost":{"enabled":false,"autoDetect":true,"maxPowerMa":500},
 "network":{"rawPort":9100,"webPort":80,"mdns":true,"telnetDebug":false,"keepAlive":true},
 "security":{"webPassword":"","apiKey":"","allowCors":true},
 "logging":{"level":"info","bufferLines":120},
 "cloud":{"webhookUrl":"","onJob":false,"ntpServer":"pool.ntp.org","timezone":"UTC"}}
```

Every value is bounds checked on load (baud whitelist, ports 1-65535, darkness
0-15, string lengths, media/language/transport enums).  Unknown keys are kept
and missing keys fall back to the defaults, which keeps upgrades migration safe.

## 4. Raspberry Pi service

`firmware/raspberrypi/arsin_print_server.py` is a single file, **standard
library only** (Python 3.9+; no aiohttp, no pyserial, no zeroconf).  There is
nothing to `pip install`: `requirements` are "none - the Python 3 standard
library is enough".  Optional system packages add features:

| package                      | used for                                              |
| ---------------------------- | ----------------------------------------------------- |
| `cups` / `cups-client`       | the CUPS transport (`lp -d <queue> -o raw -`)          |
| `network-manager` (`nmcli`)  | Wi-Fi scan / join / hotspot through `/api/wifi*`       |
| `avahi-utils`                | `avahi-publish-service` for the mDNS advertisement     |
| `wireless-tools` (`iwlist`)  | Wi-Fi scan fallback when NetworkManager is missing     |

Transports (`printer.transport`): `usbhost` (`/dev/usb/lp*`, auto-detected),
`serial` (`/dev/ttyUSB0`, `/dev/ttyACM0` with termios framing and optional
RTS/CTS or XON/XOFF), `cups` (raw queue) and `network` (raw socket to another
printer).  `--no-printer` accepts jobs and discards them, which is what the
smoke test below uses.

### One line installer

```bash
curl -fsSL https://raw.githubusercontent.com/ArsinShaabani/Printer_middleware/main/firmware/raspberrypi/install.sh | sudo bash
```

or from a checkout:

```bash
sudo ./install.sh                 # install / upgrade, keeps the config
sudo ./install.sh --with-cups     # + CUPS and a raw queue ARSIN_PrintServer
sudo ./install.sh --port 8080     # serve the web app on another port
sudo ./install.sh --uninstall     # remove the service (config is kept)
```

The installer is idempotent.  It creates the `arsin-print` system user (member
of `dialout` and `lp`), copies the service to `/opt/arsin-print-server`, creates
`/etc/arsin-print-server/config.json` from the example when it is missing,
installs `arsin-print-server.service`, enables and restarts it and prints the
URLs.  Without systemd use `--no-service` and run:

```bash
python3 /opt/arsin-print-server/arsin_print_server.py --config /etc/arsin-print-server/config.json
journalctl -u arsin-print-server -f     # logs
```

### Service flags

| flag                | meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `--config PATH`     | config file (default `/etc/arsin-print-server/config.json`)     |
| `--host ADDR`       | HTTP bind address (default `0.0.0.0`)                           |
| `--port N`          | override `network.webPort`                                      |
| `--raw-port N`      | override `network.rawPort`                                      |
| `--web-root DIR`    | directory holding `index.html` + `assets/`                      |
| `--no-printer`      | dry run: accept jobs, report a simulated printer                |
| `--no-mdns`         | do not spawn `avahi-publish-service`                            |
| `--log-level LEVEL` | `debug`, `info`, `warn`, `error`                                |
| `--print-config`    | print the effective config and exit                             |

`POST /api/reboot` exits the process so systemd restarts it;
`POST /api/factory-reset` restores the defaults and rewrites the config.
`POST /api/ota` answers `501` on Linux (OTA is an ESP-only feature).

## 5. Behaviour, safety and limitations

**Transports and failover.**  All transports funnel into one ring buffer that
`printerLoop()` drains in 192-512 byte slices, so `loop()` never blocks for more
than 50 ms and the task watchdog stays happy.  The active transport is picked
per write: the configured one when it is usable, otherwise USB host, then
Bluetooth, then UART - printing survives a Wi-Fi or USB drop.

**Bluetooth.**  ESP32 classic: `BluetoothSerial` SPP with the configured name and
PIN.  ESP32-S3/S2/C3/C6: BLE GATT UART (`6E400001-...` service, RX
`6E400002-...`, TX `6E400003-...`).  Fragmented writes are reassembled into a
4 KB job buffer and flushed after 120 ms of silence (or when full), and the TX
characteristic notifies a small `{"ok":true,"bytes":N}` result.  ESP8266 has no
radio for this, so `/api/status` reports `bt.enabled=false` with a note.

**USB host.**  The Arduino core has no printer class, so `arsin_usbhost.cpp`
implements a bulk-transfer driver on the ESP-IDF USB Host Library: install the
host stack (internal PHY, GPIO19/20 on the S3), open the device, walk the
configuration descriptor for interface class 7 (falling back to any interface
with a bulk OUT endpoint), claim it and pump a 4 KB ring into 512 byte bulk
transfers from a task pinned to core 0.  Bulk IN traffic is forwarded to
`/api/serial`.  VBUS must be supplied by the board or switched with
`-DARSIN_USB_VBUS_PIN=n`.

**Wi-Fi.**  AP+STA with a captive portal DNS server on the soft-AP
(`arsin_print_server` / `arsin1234` by default, >= 8 characters enforced),
mDNS `http://arsin_print_server.local` with `_http._tcp` and
`_pdl-datastream._tcp` (port 9100), a 15 s reconnect retry and a 10 minute
watchdog that re-opens the AP when the configured network never comes up.  Up to
five networks are remembered and the last good one is tried first.

**Server-sent events.**  `/events` streams the status document every 2 s on
`arduino-esp32` core **3.x** (chunked `text/event-stream`, up to 3 clients).  On
core 2.x and on the ESP8266 the endpoint answers `501` with a clear message
telling the client to poll `/api/status`; the Raspberry Pi build always
supports SSE.

**Request body limits.**  `/api/print` and the raw-body `/api/ota` path are
limited by the RAM available to the web server (64 KB on ESP32, 4 KB on
ESP8266).  Larger jobs should use the raw TCP port 9100, which streams straight
to the printer with no buffering.  `/api/ota` prefers
`multipart/form-data` (`curl -F firmware=@app.bin`), which streams through
`Update.write()` without buffering the image.

**Persistence.**  ESP32: Preferences/NVS (namespace `arsin-ps`, key `cfg`).
ESP8266: EEPROM with a magic + CRC32 envelope.  Both store the configuration as
the JSON document the API exchanges, so loading is migration safe: unknown keys
are ignored and missing keys keep their defaults.  The Raspberry Pi stores
`config.json` and writes it atomically.

**Logs and replies.**  Fixed size ring buffers (96 entries on ESP32, 40 on
ESP8266, 2000 on the Pi) for log lines and printer replies, with a monotonic
cursor, so `/api/logs` and `/api/serial` never copy the whole buffer.  Set
`network.telnetDebug` to also stream log documents over TCP 23.

**Webhook.**  With `cloud.webhookUrl` set (http only) and `cloud.onJob` enabled,
each completed HTTP print job is reported as JSON.

## 6. Verification

No compiler is available in the review sandbox, so the checks below are the ones
that can be run anywhere.  `firmware/tools/check-sources.mjs` verifies balanced
`(){}[]` (strings, char literals and comments are skipped), balanced
`#if/#endif`, that every local `#include` resolves, that no file-scope function
is defined twice inside one sketch, and that the files shared by the two Arduino
sketches are byte identical.

```bash
node firmware/tools/check-sources.mjs                     # structural check
python3 -m py_compile firmware/raspberrypi/arsin_print_server.py
python3 -c "import json;json.load(open('firmware/raspberrypi/config.example.json'))"
bash -n firmware/raspberrypi/install.sh
```

Smoke test of the Raspberry Pi service (no printer needed):

```bash
cd firmware/raspberrypi
python3 arsin_print_server.py --config config.example.json --port 8099 --no-printer --no-mdns &
curl -s http://127.0.0.1:8099/api/health
curl -s http://127.0.0.1:8099/api/info
curl -s http://127.0.0.1:8099/api/status
curl -s -X POST http://127.0.0.1:8099/api/command \
     -H 'Content-Type: application/json' \
     -d '{"lang":"escpos","action":"selftest","params":{}}'
kill %1
```

On a device, sanity check the same endpoints:

```bash
curl http://arsin_print_server.local/api/health
curl http://arsin_print_server.local/api/status
curl -X POST http://arsin_print_server.local/api/command \
     -H 'Content-Type: application/json' -d '{"lang":"escpos","action":"selftest"}'
curl -X POST 'http://arsin_print_server.local/api/print?cut=1' --data-binary @receipt.bin
curl -N http://arsin_print_server.local/events      # SSE, ESP32 core 3.x only
```

### Not verified here

* Compiling the sketches with `arduino-cli` - the sandbox proxy truncates the
  ESP32/ESP8266 toolchain downloads (`checking local archive integrity` fails),
  so the C++ was only checked structurally, by review, and against the upstream
  core sources (WebServer/Parsing, NetworkClient, USB Host, Updater).
* Hardware behaviour: real printers, Bluetooth pairing, USB enumeration and OTA.
* `install.sh` was syntax checked (`bash -n`) but not executed, since it needs a
  root Debian system with systemd.
