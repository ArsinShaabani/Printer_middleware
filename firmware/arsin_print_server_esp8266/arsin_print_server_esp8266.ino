/*
 * Arsin Print Server - ESP8266 firmware (NodeMCU v2/v3, Wemos D1 mini, ESP-01S...).
 *
 * Wi-Fi only: the ESP8266 has no Bluetooth radio and no USB host port, so
 * /api/status always reports bt.enabled=false with a note and the printer is
 * reached over SoftwareSerial on D7 (GPIO13, RX) / D8 (GPIO15, TX) at 115200
 * baud, while the hardware UART0 stays available as the console.
 *
 * App id: print-server-wifi (variant ARSIN_VARIANT_WIFI).
 *
 * Board FQBNs: esp8266:esp8266:nodemcuv2, esp8266:esp8266:d1_mini,
 *              esp8266:esp8266:generic (see firmware/README.md)
 */
#include "arsin_version.h"

#include "arsin_bt.h"
#include "arsin_config.h"
#include "arsin_log.h"
#include "arsin_net.h"
#include "arsin_printer.h"
#include "arsin_store.h"
#include "arsin_web.h"

namespace {
uint32_t g_lastStatusPoll = 0;
uint32_t g_lastHeapLog = 0;
const uint32_t kStatusPollMs = 30000;
const uint32_t kHeapLogMs = 300000;
}  // namespace

void setup() {
  /* UART0 stays the console, the printer hangs off SoftwareSerial (see
   * arsin_printer.cpp). */
  Serial.begin(115200);
  delay(30);
  Serial.println();
  Serial.printf("%s %s\n", ARSIN_DEVICE_ID, ARSIN_FW_VERSION);
  Serial.printf("board   : %s (%s)\n", ARSIN_BOARD_ID, ARSIN_CHIP);
  Serial.printf("variant : %s -> app %s\n", ARSIN_VARIANT_ID, ARSIN_APP_ID);
  Serial.printf("build   : %s\n", ARSIN_BUILD_DATE);
  Serial.println("printer : SoftwareSerial RX D7 (GPIO13) / TX D8 (GPIO15)");

  arsinLogBegin(40, "info");
  arsinLogRaw("booting arsin print server (ESP8266)");

  storeBegin();
  configLoad();
  arsinLogBegin(g_config.logBufferLines, g_config.logLevel);
  LOGI("config: language %s, printer \"%s\", baud %u", g_config.language, g_config.printerName,
       (unsigned)g_config.baud);
  LOGI("heap after boot: %u byte(s)", (unsigned)ESP.getFreeHeap());

  if (g_config.webhookUrl[0] || g_config.ntpServer[0]) {
    configTime(0, 0, g_config.ntpServer[0] ? g_config.ntpServer : "pool.ntp.org");
  }

  netBegin();
  printerBegin();
  webBegin();

  LOGI("ready: http://%s/ (raw printing on port %u)", ARSIN_MDNS_NAME, (unsigned)webRawPort());
  LOGW("bt: %s", arsinBtNote());
}

void loop() {
  netLoop();
  printerLoop();
  arsinBtLoop();
  webLoop();

  if (millis() - g_lastStatusPoll > kStatusPollMs) {
    g_lastStatusPoll = millis();
    printerRequestStatus();
    printerClearError();
  }

  if (millis() - g_lastHeapLog > kHeapLogMs) {
    g_lastHeapLog = millis();
    LOGI("heap %u byte(s), queue %u/%u, jobs %u, bytes %u", (unsigned)ESP.getFreeHeap(),
         (unsigned)printerQueueDepth(), (unsigned)printerQueueCapacity(), (unsigned)printerJobs(),
         (unsigned)printerBytes());
  }

  delay(2);
}
