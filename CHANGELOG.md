# Changelog

All notable changes to Arsin Print Server. This file also records *why* each fix was needed,
because most of these bugs were invisible until something actually compiled or ran.

## Unreleased - hardening pass

### Firmware now compiles (it never did)

The `Build & deploy site + firmware` workflow used to finish **green while producing no
firmware at all**: every compile step is `continue-on-error`, so a broken sketch is reported as
"no files were found ... no artifacts will be uploaded" and the run still succeeds. The site was
published, every board page said *not built yet*, and nothing pointed at the real cause.

Peeling the onion (each run revealed the next layer) found **ten real errors**:

| # | Where | Error | Fix |
| --- | --- | --- | --- |
| 1 | `arsin_commands.cpp` | `call of overloaded 'add(int)' is ambiguous` | added the missing `add(int)` overload - `b.add(0x00)` is ambiguous because `0` is a null pointer constant and converts to both `uint8_t` and `const char*` |
| 2 | `arsin_config.cpp` | `'ARSIN_MDNS_HOST' was not declared` | include `arsin_version.h` (where the macro lives) |
| 3 | `arsin_config.cpp` | `cannot bind uint32_t& to a uint16_t` | `clampU32` is now a template - the config struct mixes `uint16_t` and `uint32_t` |
| 4 | `arsin_web.cpp` | `'WiFiClient' does not name a type` | include `<WiFiClient.h>` - the ESP32 core does not pull it in through `WiFiServer.h`; the cascade also broke the raw-print server, the telnet port and the SSE clients |
| 5 | `arsin_web.cpp` | `too few arguments to arsinBuildCommand` | pass `sizeof(note)` at the streaming-cut call site |
| 6 | `arsin_web.cpp` | `no member named 'clientContentLength'` (ESP8266) | `requestContentLength()` reads the header on ESP8266 and uses the core method on ESP32 |
| 7 | `arsin_config.cpp` | `undefined reference to configFactoryReset` | the function was declared and called but never defined; implemented it |
| 8 | `arsin_bt.cpp` / `arsin_printer.cpp` | `multiple definition of printerBtName` | kept the stub in `arsin_printer.cpp`, removed the copy from the *disabled* branch of `arsin_bt.cpp` |
| 9 | `arsin_net.cpp`, `arsin_printer.cpp`, `arsin_store.cpp`, `arsin_web.cpp` | ESP8266 API differences | `WIFI_AUTH_OPEN` -> `AUTH_OPEN`; no `SoftwareSerial::setRxBufferSize`; `EEPROM.begin()` returns `void`; `WiFiServer` has no default constructor; `WiFiClient::connect()` takes two arguments |
| 10 | `arsin_bt.cpp` | `conversion from String to std::string` | `BLECharacteristic::getValue()` returns an Arduino `String` on arduino-esp32 3.x; read it through `c_str()` |

Plus one memory bug that only shows up at link time on the ESP8266:

- the generated `web_assets.h` only included `<avr/pgmspace.h>` for AVR, so on the ESP32/ESP8266
  cores `PROGMEM` fell through to the empty fallback and the whole ~137 kB asset bundle was
  placed in **DRAM**. The ESP8266 has ~80 kB of it, so the link failed with
  `section '.rodata' will not fit in region 'dram0_0_seg'`. The generator (and the hand-written
  fallback header) now include the core `pgmspace.h` through `__has_include`, so the assets
  really live in flash.

Two more, found once the ESP8266 build finally linked:

- **`printerBtBegin/Loop/Connected/Write` were only defined in the *stub* block** of
  `arsin_printer.cpp` (`#if !ARSIN_FEATURE_BT_SPP && !ARSIN_FEATURE_BLE`), so every BT/BLE/hybrid
  build failed to link. They now live in the enabled branch of `arsin_bt.cpp`, including the
  missing **printer -> Bluetooth** direction (SPP `write` and chunked BLE notifications).
- **`ESP_SPP_DISCONNECT_COMPLETE_EVT` does not exist in arduino-esp32 3.x** (IDF 4.x only) - the
  SPP callback handles `ESP_SPP_CLOSE_EVT`, which is enough.

### Flash partitions

The default arduino-esp32 partition gives the application 1.25 MB, and the firmware had grown past
it:

```
ESP32-S3: Sketch uses 1219185 bytes (93%) of program storage space. Maximum is 1310720 bytes.
ESP32-C3: Sketch uses 1341411 bytes (102%) of program storage space. Maximum is 1310720 bytes.
```

The catalog FQBNs now select `PartitionScheme=min_spiffs` (1.875 MB application + OTA + 190 kB
SPIFFS), which is what a device that advertises OTA needs anyway. The FQBN validator and its test
accept board options (`...:Option=Value`).

The **BLE build on the classic ESP32 is the one exception**: it is ~1.99 MB because that core links
the full Bluedroid stack, and a 4 MB flash cannot offer two application slots that large. Rather
than dropping OTA everywhere, `print-server-ble` excludes the three 4 MB classic ESP32 boards with
an explicit `excludeReason` that the wizard shows - the app was always aimed at the ESP32-S3/C3/C6,
and the classic ESP32 keeps the Bluetooth SPP build.


### The checks that should have caught it

The old static checker only looked at balanced braces and resolvable includes, which is why all
ten errors reached CI. `npm run check:firmware` now runs four checks:

- `check-sources.mjs` - braces, includes, ESP32/ESP8266 file sync, **multi-line and one-line
  definitions**, **functions declared but never defined** (that is the `configFactoryReset` link
  error) and duplicate definitions (warnings when both copies sit in `#if` blocks, errors
  otherwise);
- `check-syntax.mjs` - compiles the core-independent translation units with the local C++
  compiler against a small Arduino stub, **and counts the arguments at every call site of a
  function the sketch declares** (that is the `arsinBuildCommand` error);
- `check-assets.mjs` - compiles the embedded asset tables for both sketches;
- `check-print-streaming.mjs` - keeps `/api/print` streaming instead of buffering.

### Also fixed

- **The board-manager URLs.** Neither `esp32:esp32` nor `esp8266:esp8266` is in the default
  Arduino index, so a plain `arduino-cli core install` on a workstation fails. The workflows
  register the URLs now, and because the automation token cannot update `.github/workflows/*`,
  `tools/build-web-assets.mjs` also seeds `arduino-cli.yaml` when it runs in CI (that is the only
  repo-controlled step before the core install). It becomes redundant as soon as the workflow
  itself registers the URLs.
- **`firmware/arsin_print_server/web_assets_builtin.h` was never committed** - the `.gitignore`
  rule `firmware/arsin_print_server/web_assets_*.h` also matched it, so a fresh clone could not
  compile the ESP32 sketch. The rule is gone and a test now fails if the header is ignored or
  untracked.
- **`jsdom` pinned to `^29.1.1`.** `jsdom@30` requires Node >= 22.22 and its `undici` dependency
  touches `zlib.zstdDecompress` at load time, so every jsdom-based test failed on the Node 20
  `test.yml` runner.
- **The device web app was incomplete.** The embedded bundle shipped `designer.html` and
  `docs.html` but not `designer.js`/`docs.js`, so the label designer was dead on the board. The
  whole control panel is embedded for both chips now, and a test asserts that no page references
  a missing asset.
- **Dark mode did not toggle** (the theme was applied twice with the same expression) and i18n
  listeners wrote into documents that were no longer mounted.

### Wiring diagrams

The diagram used to be drawn with `width: 100%`, so it shrank with its container and 11.5 px
labels became unreadable. It is now a fixed 900-unit drawing with 15 px pin labels, a
`min-width` so it scrolls instead of shrinking, pin names inside the device boxes, the cable
name under each signal chip, a "N wires - M optional" summary and a legend. A test walks every
board x app x transport recipe and asserts that labels stay inside their boxes, rows never
overlap and nothing is smaller than 12 px.

### Label designer

Rebuilt into a real design tool: inline SVG icons for the palette, layers and actions, a canvas
toolbar, **smart alignment guides** (snap to the label and to every other element, with magenta
guide lines), a **safe-margin guide**, dash styles for lines and boxes, a frame around text
blocks, quiet zones for barcodes/QR, image rotation, plus the full property set, undo/redo,
rulers, snapping, drag and eight resize handles.

### Language

The UI is fully bilingual with an enforced dictionary (English + Persian, RTL aware), the
Vazirmatn/Inter webfonts and Persian typography. `test/i18n.test.mjs` fails if a key is missing
from either language, if a page references an unknown key, or if a maintenance action, catalog
app, transport or board family has no translation.

