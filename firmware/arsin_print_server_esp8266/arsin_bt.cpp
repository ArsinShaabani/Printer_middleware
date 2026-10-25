/*
 * Arsin Print Server - Bluetooth front end implementation (ESP32 family).
 *
 * Incoming writes are reassembled into a job buffer and handed to the printer
 * queue when the link goes idle (120 ms) or when the buffer fills up, which is
 * how POS apps that stream a receipt in several BLE packets are handled.
 */
#include "arsin_bt.h"

#include <Arduino.h>
#include <stdio.h>
#include <string.h>

#include "arsin_config.h"
#include "arsin_json.h"
#include "arsin_log.h"
#include "arsin_printer.h"
#include "arsin_version.h"

#if ARSIN_FEATURE_BT_SPP || ARSIN_FEATURE_BLE

#if ARSIN_FEATURE_BT_SPP
  #include <BluetoothSerial.h>
#endif

#if ARSIN_FEATURE_BLE
  #include <BLE2902.h>
  #include <BLEDevice.h>
  #include <BLEServer.h>
  #include <BLEUtils.h>
  #define ARSIN_BLE_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
  #define ARSIN_BLE_RX_UUID "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
  #define ARSIN_BLE_TX_UUID "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
#endif

namespace {

#if defined(ARDUINO_ARCH_ESP8266)
const size_t kBtJobMax = 512;
#else
const size_t kBtJobMax = 4096;
#endif
const uint32_t kBtIdleFlushMs = 120;

uint8_t g_job[kBtJobMax];
size_t g_jobLen = 0;
uint32_t g_jobLastWrite = 0;
bool g_started = false;
volatile bool g_connected = false;
volatile uint32_t g_rxBytes = 0;
char g_mode[6] = "off";

#if ARSIN_FEATURE_BT_SPP
BluetoothSerial g_spp;
#endif

#if ARSIN_FEATURE_BLE
BLEServer* g_bleServer = nullptr;
BLECharacteristic* g_bleTx = nullptr;
#endif

void flushJob(const char* reason) {
  if (g_jobLen == 0) return;
  const size_t sent = printerWriteAll(g_job, g_jobLen, 800);
  char note[80];
  snprintf(note, sizeof(note), "{\"ok\":%s,\"bytes\":%u,\"queued\":%u}\n", (sent == g_jobLen) ? "true" : "false",
           (unsigned)g_jobLen, (unsigned)sent);
#if ARSIN_FEATURE_BLE
  if (g_bleTx) {
    g_bleTx->setValue((uint8_t*)note, strlen(note));
    g_bleTx->notify();
  }
#endif
  LOGI("bt: job flushed (%s) %u byte(s)", reason, (unsigned)g_jobLen);
  if (sent > 0) printerCountJob("bt");
  g_jobLen = 0;
}

}  // namespace

void printerBtOnReceive(const uint8_t* data, size_t len) {
  if (!data || len == 0) return;
  g_rxBytes += (uint32_t)len;
  size_t offset = 0;
  while (offset < len) {
    const size_t room = kBtJobMax - g_jobLen;
    const size_t chunk = ((len - offset) < room) ? (len - offset) : room;
    memcpy(g_job + g_jobLen, data + offset, chunk);
    g_jobLen += chunk;
    offset += chunk;
    if (g_jobLen >= kBtJobMax) flushJob("buffer full");
  }
  g_jobLastWrite = millis();
}

#if ARSIN_FEATURE_BT_SPP
namespace {
void sppEvent(esp_spp_cb_event_t event, esp_spp_cb_param_t* param) {
  (void)param;
  switch (event) {
    case ESP_SPP_SRV_OPEN_EVT:
      g_connected = true;
      LOGI("bt: SPP client connected");
      break;
    case ESP_SPP_CLOSE_EVT:
    case ESP_SPP_DISCONNECT_COMPLETE_EVT:
      g_connected = false;
      flushJob("disconnect");
      LOGI("bt: SPP client disconnected");
      break;
    default: break;
  }
}
}  // namespace
#endif

#if ARSIN_FEATURE_BLE
namespace {

class ArsinBleServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    (void)server;
    g_connected = true;
    LOGI("bt: BLE central connected");
  }
  void onDisconnect(BLEServer* server) override {
    g_connected = false;
    flushJob("disconnect");
    LOGI("bt: BLE central disconnected, advertising again");
    server->startAdvertising();
  }
};

class ArsinBleRxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const std::string value = characteristic->getValue();
    if (!value.empty()) printerBtOnReceive((const uint8_t*)value.data(), value.size());
  }
};

}  // namespace
#endif

bool arsinBtBegin() {
  if (g_started) return true;
  const char* name = g_config.btName[0] ? g_config.btName : "arsin_print_server";

#if ARSIN_FEATURE_BLE
  if (g_config.ble) {
    BLEDevice::init(name);
    g_bleServer = BLEDevice::createServer();
    g_bleServer->setCallbacks(new ArsinBleServerCallbacks());
    BLEService* service = g_bleServer->createService(ARSIN_BLE_SERVICE_UUID);
    BLECharacteristic* rx = service->createCharacteristic(
        ARSIN_BLE_RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
    rx->setCallbacks(new ArsinBleRxCallbacks());
    g_bleTx = service->createCharacteristic(ARSIN_BLE_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
    g_bleTx->addDescriptor(new BLE2902());
    service->start();
    BLEAdvertising* advertising = BLEDevice::getAdvertising();
    advertising->addServiceUUID(ARSIN_BLE_SERVICE_UUID);
    advertising->setScanResponse(true);
    advertising->setMinPreferred(0x06);
    advertising->setMinPreferred(0x12);
    BLEDevice::startAdvertising();
    strncpy(g_mode, "ble", sizeof(g_mode) - 1);
    g_started = true;
    LOGI("bt: BLE UART up as \"%s\" (service %s)", name, ARSIN_BLE_SERVICE_UUID);
    return true;
  }
#endif

#if ARSIN_FEATURE_BT_SPP
  if (!g_spp.begin(name, false)) {
    LOGE("bt: BluetoothSerial.begin failed");
    return false;
  }
  if (g_config.btPin[0]) {
    g_spp.setPin(g_config.btPin, (uint8_t)strlen(g_config.btPin));
  }
  g_spp.register_callback(sppEvent);
  strncpy(g_mode, "spp", sizeof(g_mode) - 1);
  g_started = true;
  LOGI("bt: SPP up as \"%s\" (PIN %s)", name, g_config.btPin);
  return true;
#else
  LOGW("bt: this build has no Bluetooth Classic radio");
  strncpy(g_mode, "off", sizeof(g_mode) - 1);
  return false;
#endif
}

void arsinBtLoop() {
  if (!g_started) return;

#if ARSIN_FEATURE_BT_SPP
  if (g_mode[0] == 's') {
    uint8_t buf[128];
    size_t n = 0;
    while (g_spp.available() > 0 && n < sizeof(buf)) {
      buf[n++] = (uint8_t)g_spp.read();
    }
    if (n) printerBtOnReceive(buf, n);
    if (!g_connected && g_spp.hasClient()) g_connected = true;
    if (g_connected && !g_spp.hasClient()) {
      g_connected = false;
      flushJob("disconnect");
    }
  }
#endif

  if (g_jobLen > 0 && (millis() - g_jobLastWrite) > kBtIdleFlushMs) {
    flushJob("idle");
  }
}

bool arsinBtEnabled() { return g_started; }
bool arsinBtConnected() { return g_started && g_connected; }
const char* arsinBtMode() { return g_started ? g_mode : "off"; }
const char* printerBtName() { return g_config.btName; }
uint32_t arsinBtRxBytes() { return g_rxBytes; }
const char* arsinBtNote() {
  if (g_started) return "ready";
#if defined(ARDUINO_ARCH_ESP8266)
  return "ESP8266 has no Bluetooth radio - Wi-Fi only";
#elif !ARSIN_FEATURE_BT_SPP && !ARSIN_FEATURE_BLE
  return "this variant was compiled without Bluetooth";
#else
  return "disabled in configuration";
#endif
}

#else /* no Bluetooth support compiled in at all (ESP8266, Wi-Fi only builds) */

bool arsinBtBegin() { return false; }
void arsinBtLoop() {}
bool arsinBtEnabled() { return false; }
bool arsinBtConnected() { return false; }
const char* arsinBtMode() { return "off"; }
const char* printerBtName() { return g_config.btName; }
uint32_t arsinBtRxBytes() { return 0; }
const char* arsinBtNote() {
#if defined(ARDUINO_ARCH_ESP8266)
  return "ESP8266 has no Bluetooth radio - Wi-Fi only";
#else
  return "this variant was compiled without Bluetooth";
#endif
}

#endif
