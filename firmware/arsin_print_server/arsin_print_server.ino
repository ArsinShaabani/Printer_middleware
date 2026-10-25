/*
 * Arsin Print Server - ESP32 firmware (ESP32 / ESP32-S3 / ESP32-S2 / ESP32-C3 / ESP32-C6).
 *
 * Variants (compile with -DARSIN_VARIANT_xxx, see firmware/README.md):
 *   ARSIN_VARIANT_WIFI    print-server-wifi     Wi-Fi + TCP 9100 + web console
 *   ARSIN_VARIANT_BT      print-server-bt-spp   Bluetooth SPP front end
 *   ARSIN_VARIANT_BLE     print-server-ble      BLE GATT UART front end
 *   ARSIN_VARIANT_USBHOST print-server-usbhost  USB host printer driver
 *   ARSIN_VARIANT_SERIAL  print-server-serial   serial / COM bridge
 *   ARSIN_VARIANT_HYBRID  print-server-hybrid   everything the chip supports
 *
 * The REST contract, the raw 9100 server and the mDNS advertisement are
 * identical on every variant so the web application can talk to any build.
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
  Serial.begin(115200);
  delay(30); /* short settle so the first lines are visible on the console */

  Serial.printf("\n%s %s\n", ARSIN_DEVICE_ID, ARSIN_FW_VERSION);
  Serial.printf("board   : %s (%s)\n", ARSIN_BOARD_ID, ARSIN_CHIP);
  Serial.printf("variant : %s -> app %s\n", ARSIN_VARIANT_ID, ARSIN_APP_ID);
  Serial.printf("build   : %s\n", ARSIN_BUILD_DATE);

  arsinLogBegin(96, "info");
  arsinLogRaw("booting arsin print server");

  storeBegin();
  configLoad();
  arsinLogBegin(g_config.logBufferLines, g_config.logLevel);
  LOGI("config: language %s, transport %s, printer \"%s\"", g_config.language, g_config.transport, g_config.printerName);
  LOGI("heap after boot: %u byte(s)", (unsigned)ESP.getFreeHeap());

  if (g_config.webhookUrl[0] || g_config.ntpServer[0]) {
    configTime(0, 0, g_config.ntpServer[0] ? g_config.ntpServer : "pool.ntp.org");
  }

  netBegin();
  printerBegin();
  webBegin();

  LOGI("ready: http://%s/ (raw printing on port %u)", ARSIN_MDNS_NAME, (unsigned)webRawPort());
}

void loop() {
  /* Every stage is non blocking and bounded, so the task watchdog stays happy:
   * no delay() longer than 50 ms is ever used in the loops. */
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
