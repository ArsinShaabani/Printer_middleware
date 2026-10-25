/*
 * Arsin Print Server - printer transport layer implementation.
 *
 * This file is shared verbatim between the ESP32 and the ESP8266 sketches; the
 * platform differences (HardwareSerial vs SoftwareSerial, USB host, Bluetooth)
 * are resolved with the ARSIN_FEATURE_* macros from arsin_version.h.
 */
#include "arsin_printer.h"

#include <Arduino.h>
#include <string.h>

#include "arsin_config.h"
#include "arsin_log.h"
#include "arsin_version.h"

#if defined(ARDUINO_ARCH_ESP8266)
  #include <SoftwareSerial.h>
  #define ARSIN_PRINT_QUEUE 2048
  #define ARSIN_PUMP_SLICE 192
#else
  #include "driver/uart.h"
  #define ARSIN_PRINT_QUEUE 8192
  #define ARSIN_PUMP_SLICE 512
#endif

/* UART wiring defaults (override with -DARSIN_UART_TX_PIN=.. / -DARSIN_UART_RX_PIN=..) */
#ifndef ARSIN_UART_TX_PIN
  #if defined(ARDUINO_ARCH_ESP8266)
    #define ARSIN_UART_TX_PIN 15 /* D8 */
    #define ARSIN_UART_RX_PIN 13 /* D7 */
  #else
    #define ARSIN_UART_TX_PIN 17 /* UART2 TX */
    #define ARSIN_UART_RX_PIN 16 /* UART2 RX */
  #endif
#endif

namespace {

uint8_t g_queue[ARSIN_PRINT_QUEUE];
size_t g_head = 0; /* read position  */
size_t g_tail = 0; /* write position */
size_t g_used = 0;

ArsinPrinterState g_state = ARSIN_STATE_IDLE;
ArsinPrinterHealth g_health = ARSIN_HEALTH_OFFLINE;
uint32_t g_jobs = 0;
uint32_t g_bytes = 0;
uint32_t g_errors = 0;
char g_lastJob[20] = "";
char g_lastReply[24] = "";
uint32_t g_lastWrite = 0;
uint32_t g_lastReplyAt = 0;
bool g_uartReady = false;
char g_active[10] = "uart";

const char* healthName(ArsinPrinterHealth health) {
  switch (health) {
    case ARSIN_HEALTH_OK: return "ok";
    case ARSIN_HEALTH_PAPER_OUT: return "paper-out";
    case ARSIN_HEALTH_COVER_OPEN: return "cover-open";
    case ARSIN_HEALTH_ERROR: return "error";
    default: return "offline";
  }
}

/* ------------------------------------------------------------ UART transport */

#if defined(ARDUINO_ARCH_ESP8266)
SoftwareSerial g_softSerial(ARSIN_UART_RX_PIN, ARSIN_UART_TX_PIN);
#elif defined(SOC_UART_NUM) && (SOC_UART_NUM >= 3)
HardwareSerial g_printerUart(2);
#else
HardwareSerial g_printerUart(1);
#endif

uint8_t parityCode(const char* parity) {
  if (!parity) return 0;
  if (!strcasecmp(parity, "even")) return 1;
  if (!strcasecmp(parity, "odd")) return 2;
  return 0; /* mark/space are not representable on every core - treated as none */
}

void noteSerial(const uint8_t* data, size_t len) {
  if (!len) return;
  arsinSerialRingPush(data, len);
  const size_t keep = (len < sizeof(g_lastReply) - 1) ? len : sizeof(g_lastReply) - 1;
  size_t o = 0;
  for (size_t i = len - keep; i < len && o + 3 < sizeof(g_lastReply); i++) {
    static const char* digits = "0123456789ABCDEF";
    g_lastReply[o++] = digits[(data[i] >> 4) & 0x0F];
    g_lastReply[o++] = digits[data[i] & 0x0F];
  }
  g_lastReply[o] = 0;
  g_lastReplyAt = millis();
}

void classifyReply(const uint8_t* data, size_t len) {
  /* Best effort ESC/POS DLE EOT 1 parsing: bit 6 = paper end, bit 3 = offline,
   * bit 2 = drawer open.  Other languages simply report "ok". */
  for (size_t i = 0; i + 3 < len; i++) {
    if (data[i] == 0x10 && data[i + 1] == 0x04 && data[i + 2] == 0x01) {
      const uint8_t status = data[i + 3];
      if (status & 0x40) {
        g_health = ARSIN_HEALTH_PAPER_OUT;
      } else if (status & 0x08) {
        g_health = ARSIN_HEALTH_OFFLINE;
      } else if (status & 0x04) {
        g_health = ARSIN_HEALTH_COVER_OPEN;
      } else {
        g_health = ARSIN_HEALTH_OK;
      }
      LOGD("printer: status 0x%02X -> %s", status, healthName(g_health));
      return;
    }
  }
  if (len > 0 && g_health == ARSIN_HEALTH_OFFLINE) g_health = ARSIN_HEALTH_OK;
}

}  // namespace

bool printerUartBegin() {
  const uint32_t baud = g_config.baud ? g_config.baud : 115200;
#if defined(ARDUINO_ARCH_ESP8266)
  if (strcasecmp(g_config.parity, "none") != 0 || g_config.dataBits != 8 || g_config.stopBits != 1) {
    LOGW("uart: ESP8266 SoftwareSerial is 8N1 only, ignoring %u%c%u framing", (unsigned)g_config.dataBits,
         g_config.parity[0], (unsigned)g_config.stopBits);
  }
  g_softSerial.begin(baud);
  g_softSerial.setRxBufferSize(256);
  g_uartReady = true;
#else
  const uint32_t config = (uint32_t)((g_config.dataBits - 5) & 0x03) |
                          ((uint32_t)parityCode(g_config.parity) << 2) |
                          ((g_config.stopBits == 2 ? 3u : 1u) << 4);
  g_printerUart.begin(baud, config, (int8_t)ARSIN_UART_RX_PIN, (int8_t)ARSIN_UART_TX_PIN, false, 20);
  g_uartReady = true;
  #if defined(ARSIN_UART_RTS_PIN) && defined(ARSIN_UART_CTS_PIN)
  {
    const int port = (SOC_UART_NUM >= 3) ? 2 : 1;
    uart_set_pin((uart_port_t)port, (int)ARSIN_UART_TX_PIN, (int)ARSIN_UART_RX_PIN, (int)ARSIN_UART_RTS_PIN,
                 (int)ARSIN_UART_CTS_PIN);
    uart_set_hw_flow_ctrl((uart_port_t)port, UART_HW_FLOWCTRL_CTS_RTS, 32);
    LOGI("uart: hardware flow control enabled (RTS %d / CTS %d)", (int)ARSIN_UART_RTS_PIN, (int)ARSIN_UART_CTS_PIN);
  }
  #endif
#endif
  g_health = ARSIN_HEALTH_OK;
  LOGI("uart: printer port up at %u baud (%u%c%u)", (unsigned)baud, (unsigned)g_config.dataBits,
       g_config.parity[0], (unsigned)g_config.stopBits);
  return true;
}

size_t printerUartWrite(const uint8_t* data, size_t len) {
  if (!g_uartReady || !data || len == 0) return 0;
#if defined(ARDUINO_ARCH_ESP8266)
  return g_softSerial.write(data, len);
#else
  return g_printerUart.write(data, len);
#endif
}

size_t printerUartRead(uint8_t* out, size_t cap) {
  if (!g_uartReady || !out || cap == 0) return 0;
#if defined(ARDUINO_ARCH_ESP8266)
  const size_t available = (size_t)g_softSerial.available();
  const size_t n = (available < cap) ? available : cap;
  for (size_t i = 0; i < n; i++) out[i] = (uint8_t)g_softSerial.read();
#else
  const size_t available = (size_t)g_printerUart.available();
  const size_t n = (available < cap) ? available : cap;
  if (n) g_printerUart.readBytes(out, n);
#endif
  return n;
}

void printerUartLoop() {
  uint8_t buf[128];
  const size_t n = printerUartRead(buf, sizeof(buf));
  if (n) {
    noteSerial(buf, n);
    classifyReply(buf, n);
  }
}

/* ------------------------------------------- stubs when a feature is compiled out */

#if !ARSIN_FEATURE_BT_SPP && !ARSIN_FEATURE_BLE
bool printerBtBegin() { return false; }
void printerBtLoop() {}
bool printerBtConnected() { return false; }
const char* printerBtName() { return g_config.btName; }
size_t printerBtWrite(const uint8_t* data, size_t len) { (void)data; (void)len; return 0; }
void printerBtOnReceive(const uint8_t* data, size_t len) { (void)data; (void)len; }
#endif

#if !ARSIN_FEATURE_USBHOST
bool printerUsbBegin() { return false; }
void printerUsbLoop() {}
bool printerUsbConnected() { return false; }
size_t printerUsbWrite(const uint8_t* data, size_t len) { (void)data; (void)len; return 0; }
void printerUsbDescribe(char* vid, size_t vidCap, char* pid, size_t pidCap, char* manufacturer, size_t mfgCap,
                        char* product, size_t prodCap) {
  if (vid && vidCap) strncpy(vid, "0x0000", vidCap - 1);
  if (vid && vidCap) vid[vidCap - 1] = 0;
  if (pid && pidCap) strncpy(pid, "0x0000", pidCap - 1);
  if (pid && pidCap) pid[pidCap - 1] = 0;
  if (manufacturer && mfgCap) manufacturer[0] = 0;
  if (product && prodCap) product[0] = 0;
}
#endif

/* ---------------------------------------------------------- transport choice */

namespace {

void selectActiveTransport() {
  const char* want = g_config.transport ? g_config.transport : "uart";
  const bool btAvailable = g_config.btEnabled && printerBtConnected();
  const char* chosen = "uart";

  if (!strcmp(want, "usbhost") && printerUsbConnected()) {
    chosen = "usbhost";
  } else if ((!strcmp(want, "bt") || !strcmp(want, "ble")) && btAvailable) {
    chosen = g_config.ble ? "ble" : "bt";
  } else if (!strcmp(want, "uart")) {
    chosen = "uart";
  } else if (printerUsbConnected()) {
    chosen = "usbhost"; /* failover: keep printing over USB */
  } else if (btAvailable) {
    chosen = g_config.ble ? "ble" : "bt";
  }

  if (strcmp(chosen, g_active) != 0) {
    LOGI("printer: active transport %s", chosen);
    strncpy(g_active, chosen, sizeof(g_active) - 1);
    g_active[sizeof(g_active) - 1] = 0;
  }
}

size_t transportWrite(const uint8_t* data, size_t len) {
  if (!strcmp(g_active, "usbhost")) return printerUsbWrite(data, len);
  if (!strcmp(g_active, "bt") || !strcmp(g_active, "ble")) return printerBtWrite(data, len);
  return printerUartWrite(data, len);
}

}  // namespace

bool printerBegin() {
  g_uartReady = false;
  printerQueueFlush();
  g_state = ARSIN_STATE_IDLE;

  printerUartBegin();

#if ARSIN_FEATURE_USBHOST
  if (g_config.usbHostEnabled) {
    printerUsbBegin();
  } else {
    LOGI("usbhost: disabled by configuration");
  }
#endif

#if ARSIN_FEATURE_BT_SPP || ARSIN_FEATURE_BLE
  if (g_config.btEnabled) {
    printerBtBegin();
  } else {
    LOGI("bt: disabled by configuration");
  }
#endif

  selectActiveTransport();
  return true;
}

void printerLoop() {
  selectActiveTransport();

  /* 1. collect replies from every live transport */
  printerUartLoop();
#if ARSIN_FEATURE_USBHOST
  printerUsbLoop();
#endif
#if ARSIN_FEATURE_BT_SPP || ARSIN_FEATURE_BLE
  printerBtLoop();
#endif

  /* 2. pump the queue towards the active transport */
  if (g_used == 0) {
    if (g_state == ARSIN_STATE_PRINTING && (millis() - g_lastWrite) > 400) {
      g_state = ARSIN_STATE_IDLE;
    }
    return;
  }

  uint8_t slice[ARSIN_PUMP_SLICE];
  const size_t n = (g_used < sizeof(slice)) ? g_used : sizeof(slice);
  for (size_t i = 0; i < n; i++) slice[i] = g_queue[(g_head + i) % ARSIN_PRINT_QUEUE];

  const size_t written = transportWrite(slice, n);
  if (written > 0) {
    g_head = (g_head + written) % ARSIN_PRINT_QUEUE;
    g_used -= written;
    g_bytes += (uint32_t)written;
    g_lastWrite = millis();
    g_state = ARSIN_STATE_PRINTING;
    if (g_health == ARSIN_HEALTH_OFFLINE) g_health = ARSIN_HEALTH_OK;
  } else {
    static uint32_t lastError = 0;
    if (millis() - lastError > 5000) {
      lastError = millis();
      g_errors++;
      LOGW("printer: transport %s refused %u bytes", g_active, (unsigned)n);
    }
    if (!printerConnected()) {
      g_health = ARSIN_HEALTH_OFFLINE;
      g_state = ARSIN_STATE_ERROR;
    }
  }
}

size_t printerWrite(const uint8_t* data, size_t len) {
  if (!data || len == 0) return 0;
  size_t accepted = 0;
  while (accepted < len && g_used < ARSIN_PRINT_QUEUE) {
    g_queue[g_tail] = data[accepted++];
    g_tail = (g_tail + 1) % ARSIN_PRINT_QUEUE;
    g_used++;
  }
  if (accepted < len) {
    g_errors++;
    LOGW("printer: queue full, %u byte(s) dropped", (unsigned)(len - accepted));
  }
  return accepted;
}

size_t printerWriteAll(const uint8_t* data, size_t len, uint32_t timeoutMs) {
  if (!data) return 0;
  const uint32_t started = millis();
  size_t sent = 0;
  while (sent < len) {
    const size_t accepted = printerWrite(data + sent, len - sent);
    sent += accepted;
    if (sent >= len) break;
    printerLoop();
    if (millis() - started > timeoutMs) break;
    delay(1); /* never longer than 50 ms per iteration */
  }
  return sent;
}

size_t printerQueueDepth() { return g_used; }
size_t printerQueueCapacity() { return ARSIN_PRINT_QUEUE; }
void printerQueueFlush() {
  g_head = 0;
  g_tail = 0;
  g_used = 0;
}

ArsinPrinterState printerState() { return g_state; }
ArsinPrinterHealth printerHealth() { return g_health; }
const char* printerHealthName() { return healthName(g_health); }
const char* printerStateName() {
  switch (g_state) {
    case ARSIN_STATE_PRINTING: return "printing";
    case ARSIN_STATE_ERROR: return "error";
    default: return "idle";
  }
}
const char* printerActiveTransport() { return g_active; }
const char* printerConfiguredTransport() { return g_config.transport; }

bool printerConnected() {
  if (!strcmp(g_active, "usbhost")) return printerUsbConnected();
  if (!strcmp(g_active, "bt") || !strcmp(g_active, "ble")) return printerBtConnected();
  return g_uartReady;
}

const char* printerLastReply() { return g_lastReply; }

uint32_t printerJobs() { return g_jobs; }
uint32_t printerBytes() { return g_bytes; }
uint32_t printerErrors() { return g_errors; }
void printerCountersReset() {
  g_jobs = 0;
  g_bytes = 0;
  g_errors = 0;
  LOGI("printer: counters reset");
}

void printerCountJob(const char* jobId) {
  g_jobs++;
  if (jobId) {
    strncpy(g_lastJob, jobId, sizeof(g_lastJob) - 1);
    g_lastJob[sizeof(g_lastJob) - 1] = 0;
  }
}

const char* printerLastJobId() { return g_lastJob; }

void printerSetError(const char* reason) {
  g_state = ARSIN_STATE_ERROR;
  g_errors++;
  if (reason) LOGW("printer: %s", reason);
}

void printerClearError() {
  if (g_state == ARSIN_STATE_ERROR) g_state = g_used ? ARSIN_STATE_PRINTING : ARSIN_STATE_IDLE;
}

void printerRequestStatus() {
  /* DLE EOT 1 + GS r 1 - harmless on non ESC/POS printers, which simply
   * ignore the bytes, and answers the "lastReply" field on Epson clones. */
  static const uint8_t query[] = {0x10, 0x04, 0x01, 0x1D, 0x72, 0x01};
  if (!strcmp(g_config.language, "escpos")) {
    printerWrite(query, sizeof(query));
  }
}
