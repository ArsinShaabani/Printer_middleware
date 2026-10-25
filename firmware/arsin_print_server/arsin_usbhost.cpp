/*
 * Arsin Print Server - USB host printer path (ESP32-S3 / ESP32-S2).
 *
 * The Arduino core ships no printer class for the USB Host stack, so this file
 * implements a small bulk-transfer driver directly on the ESP-IDF USB Host
 * Library API:
 *
 *   1. install the USB Host Library (internal PHY, GPIO19/20 on the S3)
 *   2. register an asynchronous client
 *   3. on device attach: open it, walk the configuration descriptor for an
 *      interface with class 7 (printer) - falling back to any interface that
 *      exposes a bulk OUT endpoint - claim it and remember the endpoints
 *   4. pump a 4 KB software ring buffer into 512 byte bulk transfers from a
 *      dedicated task pinned to core 0, and forward any bulk IN traffic to the
 *      printer reply ring (/api/serial)
 *
 * Bulk transfers are submitted asynchronously and awaited with a 500 ms
 * timeout, so the printer loop never blocks for long.  VBUS must be supplied by
 * the board (or wire a power switch and define ARSIN_USB_VBUS_PIN).
 */
#include "arsin_printer.h"

#include <Arduino.h>
#include <string.h>

#include "arsin_config.h"
#include "arsin_log.h"
#include "arsin_version.h"

#if ARSIN_FEATURE_USBHOST

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "usb/usb_host.h"
#include "usb/usb_helpers.h"

#ifndef USB_CLASS_PRINTER
  #define USB_CLASS_PRINTER 0x07
#endif
#ifndef USB_BM_ATTRIBUTES_XFERTYPE_MASK
  #define USB_BM_ATTRIBUTES_XFERTYPE_MASK 0x03
#endif
#ifndef USB_BM_ATTRIBUTES_XFER_BULK
  #define USB_BM_ATTRIBUTES_XFER_BULK 0x02
#endif

namespace {

const size_t kRingSize = 4096;
const size_t kTransferSize = 512;
const uint32_t kTransferTimeoutMs = 500;
const BaseType_t kTaskCore = 0;

uint8_t g_ring[kRingSize];
size_t g_head = 0;
size_t g_tail = 0;
size_t g_used = 0;
SemaphoreHandle_t g_ringLock = nullptr;

usb_host_client_handle_t g_client = nullptr;
usb_device_handle_t g_device = nullptr;
usb_transfer_t* g_tx = nullptr;
usb_transfer_t* g_rx = nullptr;
SemaphoreHandle_t g_txDone = nullptr;
SemaphoreHandle_t g_rxDone = nullptr;
uint8_t g_epOut = 0;
uint8_t g_epIn = 0;
uint8_t g_interface = 0;
volatile bool g_connected = false;
volatile bool g_pendingAttach = false;
uint8_t g_pendingAddress = 0;
volatile bool g_taskRunning = false;
uint32_t g_lastError = 0;

char g_vid[8] = "0x0000";
char g_pid[8] = "0x0000";
char g_manufacturer[40] = "";
char g_product[40] = "";

void utf16ToAscii(const usb_str_desc_t* desc, char* out, size_t cap) {
  if (!out || cap == 0) return;
  out[0] = 0;
  if (!desc || desc->bLength < 4) return;
  size_t o = 0;
  const int chars = (desc->bLength - 2) / 2;
  for (int i = 0; i < chars && o + 1 < cap; i++) {
    const uint16_t c = (uint16_t)(desc->wData[i] & 0x7F);
    out[o++] = (char)(c ? c : '?');
  }
  out[o] = 0;
}

size_t ringPush(const uint8_t* data, size_t len) {
  if (!data || !len || !g_ringLock) return 0;
  if (xSemaphoreTake(g_ringLock, pdMS_TO_TICKS(20)) != pdTRUE) return 0;
  size_t accepted = 0;
  while (accepted < len && g_used < kRingSize) {
    g_ring[g_tail] = data[accepted++];
    g_tail = (g_tail + 1) % kRingSize;
    g_used++;
  }
  xSemaphoreGive(g_ringLock);
  if (accepted < len) {
    LOGW("usbhost: ring full, %u byte(s) dropped", (unsigned)(len - accepted));
  }
  return accepted;
}

size_t ringPop(uint8_t* out, size_t cap) {
  if (!out || !cap || !g_ringLock) return 0;
  if (xSemaphoreTake(g_ringLock, pdMS_TO_TICKS(20)) != pdTRUE) return 0;
  const size_t n = (g_used < cap) ? g_used : cap;
  for (size_t i = 0; i < n; i++) {
    out[i] = g_ring[(g_head + i) % kRingSize];
  }
  g_head = (g_head + n) % kRingSize;
  g_used -= n;
  xSemaphoreGive(g_ringLock);
  return n;
}

size_t ringUsed() {
  if (!g_ringLock) return 0;
  if (xSemaphoreTake(g_ringLock, pdMS_TO_TICKS(20)) != pdTRUE) return 0;
  const size_t used = g_used;
  xSemaphoreGive(g_ringLock);
  return used;
}

void txCallback(usb_transfer_t* transfer) {
  if (g_txDone) xSemaphoreGive(g_txDone);
  (void)transfer;
}

void rxCallback(usb_transfer_t* transfer) {
  if (transfer && transfer->status == USB_TRANSFER_STATUS_COMPLETED && transfer->actual_num_bytes > 0) {
    arsinSerialRingPush(transfer->data_buffer, (size_t)transfer->actual_num_bytes);
  }
  if (g_rxDone) xSemaphoreGive(g_rxDone);
}

/* ------------------------------------------------------------- enumeration */

void releaseDevice() {
  if (g_tx) {
    usb_host_transfer_free(g_tx);
    g_tx = nullptr;
  }
  if (g_rx) {
    usb_host_transfer_free(g_rx);
    g_rx = nullptr;
  }
  if (g_device) {
    usb_host_interface_release(g_client, g_device, g_interface);
    usb_host_device_close(g_client, g_device);
    g_device = nullptr;
  }
  g_connected = false;
  g_epOut = 0;
  g_epIn = 0;
  strncpy(g_vid, "0x0000", sizeof(g_vid) - 1);
  strncpy(g_pid, "0x0000", sizeof(g_pid) - 1);
  g_manufacturer[0] = 0;
  g_product[0] = 0;
}

bool attachDevice(uint8_t address) {
  releaseDevice();
  if (usb_host_device_open(g_client, address, &g_device) != ESP_OK) {
    LOGE("usbhost: unable to open device %u", (unsigned)address);
    return false;
  }

  usb_device_info_t info = {};
  if (usb_host_device_info(g_device, &info) == ESP_OK) {
    utf16ToAscii(info.str_desc_manufacturer, g_manufacturer, sizeof(g_manufacturer));
    utf16ToAscii(info.str_desc_product, g_product, sizeof(g_product));
  }

  const usb_device_desc_t* deviceDesc = nullptr;
  if (usb_host_get_device_descriptor(g_device, &deviceDesc) == ESP_OK && deviceDesc) {
    snprintf(g_vid, sizeof(g_vid), "0x%04X", deviceDesc->idVendor);
    snprintf(g_pid, sizeof(g_pid), "0x%04X", deviceDesc->idProduct);
  }

  const usb_config_desc_t* configDesc = nullptr;
  if (usb_host_get_active_config_descriptor(g_device, &configDesc) != ESP_OK || !configDesc) {
    LOGE("usbhost: no active configuration descriptor");
    releaseDevice();
    return false;
  }

  /* Look for a printer class interface first, otherwise accept the first
   * interface that exposes a bulk OUT endpoint (many thermal printers
   * enumerate as vendor specific class 0xFF). */
  int bestInterface = -1;
  uint8_t bestEpOut = 0;
  uint8_t bestEpIn = 0;
  const uint8_t interfaceCount = configDesc->bNumInterfaces;
  for (uint8_t iface = 0; iface < interfaceCount; iface++) {
    int offset = 0;
    const usb_intf_desc_t* intf = usb_parse_interface_descriptor(configDesc, iface, 0, &offset);
    if (!intf) continue;
    uint8_t epOut = 0;
    uint8_t epIn = 0;
    for (int ep = 0; ep < intf->bNumEndpoints; ep++) {
      int epOffset = 0;
      const usb_ep_desc_t* endpoint = usb_parse_endpoint_descriptor_by_index(intf, ep, configDesc->wTotalLength, &epOffset);
      if (!endpoint) continue;
      if ((endpoint->bmAttributes & USB_BM_ATTRIBUTES_XFERTYPE_MASK) != USB_BM_ATTRIBUTES_XFER_BULK) continue;
      if (endpoint->bEndpointAddress & 0x80) {
        if (!epIn) epIn = endpoint->bEndpointAddress;
      } else if (!epOut) {
        epOut = endpoint->bEndpointAddress;
      }
    }
    if (!epOut) continue;
    const bool isPrinter = (intf->bInterfaceClass == USB_CLASS_PRINTER);
    if (isPrinter || bestInterface < 0) {
      bestInterface = intf->bInterfaceNumber;
      bestEpOut = epOut;
      bestEpIn = epIn;
      if (isPrinter) break;
    }
  }

  if (bestInterface < 0) {
    LOGW("usbhost: device %s:%s has no bulk OUT endpoint - not a printer", g_vid, g_pid);
    releaseDevice();
    return false;
  }

  if (usb_host_interface_claim(g_client, g_device, (uint8_t)bestInterface, 0) != ESP_OK) {
    LOGE("usbhost: unable to claim interface %d", bestInterface);
    releaseDevice();
    return false;
  }
  g_interface = (uint8_t)bestInterface;
  g_epOut = bestEpOut;
  g_epIn = bestEpIn;

  if (usb_host_transfer_alloc(kTransferSize, 0, &g_tx) != ESP_OK) {
    LOGE("usbhost: unable to allocate the OUT transfer");
    releaseDevice();
    return false;
  }
  g_tx->device_handle = g_device;
  g_tx->bEndpointAddress = g_epOut;
  g_tx->callback = txCallback;
  g_tx->context = nullptr;
  g_tx->timeout_ms = kTransferTimeoutMs;

  if (g_epIn) {
    if (usb_host_transfer_alloc(kTransferSize, 0, &g_rx) == ESP_OK) {
      g_rx->device_handle = g_device;
      g_rx->bEndpointAddress = g_epIn;
      g_rx->callback = rxCallback;
      g_rx->num_bytes = kTransferSize;
      usb_host_transfer_submit(g_rx);
    }
  }

  g_connected = true;
  LOGI("usbhost: printer ready (%s:%s \"%s\") ep out 0x%02X in 0x%02X", g_vid, g_pid, g_product, g_epOut, g_epIn);
  return true;
}

void clientEvent(const usb_host_client_event_msg_t* msg, void* arg) {
  (void)arg;
  if (!msg) return;
  if (msg->event == USB_HOST_CLIENT_EVENT_NEW_DEV) {
    g_pendingAddress = msg->new_dev.address;
    g_pendingAttach = true;
  } else if (msg->event == USB_HOST_CLIENT_EVENT_DEV_GONE) {
    if (g_device && msg->dev_gone.dev_hdl == g_device) {
      LOGW("usbhost: printer removed");
      releaseDevice();
    }
  }
}

/* ------------------------------------------------------------------- pump */

void pumpOnce() {
  if (!g_tx || !g_connected) return;
  uint8_t buf[kTransferSize];
  const size_t n = ringPop(buf, sizeof(buf));
  if (n == 0) return;

  memcpy(g_tx->data_buffer, buf, n);
  g_tx->num_bytes = (int)n;
  while (xSemaphoreTake(g_txDone, 0) == pdTRUE) {
    /* clear a stale completion */
  }
  if (usb_host_transfer_submit(g_tx) != ESP_OK) {
    if (millis() - g_lastError > 5000) {
      g_lastError = millis();
      LOGW("usbhost: bulk submit failed");
    }
    return;
  }
  if (xSemaphoreTake(g_txDone, pdMS_TO_TICKS(kTransferTimeoutMs)) == pdTRUE) {
    if (g_tx->status != USB_TRANSFER_STATUS_COMPLETED) {
      if (millis() - g_lastError > 5000) {
        g_lastError = millis();
        LOGW("usbhost: bulk transfer status %d", (int)g_tx->status);
      }
    } else if (g_tx->actual_num_bytes < (int)n) {
      LOGW("usbhost: short bulk write (%d/%u)", g_tx->actual_num_bytes, (unsigned)n);
    }
  } else {
    LOGW("usbhost: bulk transfer timeout");
    usb_host_endpoint_halt(g_device, g_epOut);
    usb_host_endpoint_flush(g_device, g_epOut);
    usb_host_endpoint_clear(g_device, g_epOut);
  }
}

void usbTask(void* arg) {
  (void)arg;
  g_taskRunning = true;

#ifdef ARSIN_USB_VBUS_PIN
  pinMode(ARSIN_USB_VBUS_PIN, OUTPUT);
  digitalWrite(ARSIN_USB_VBUS_PIN, HIGH);
  delay(10);
#endif

  usb_host_config_t hostConfig = {};
  hostConfig.intr_flags = ESP_INTR_FLAG_LEVEL1;
  esp_err_t err = usb_host_install(&hostConfig);
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
    LOGE("usbhost: usb_host_install failed (%d)", (int)err);
    g_taskRunning = false;
    vTaskDelete(nullptr);
    return;
  }

  usb_host_client_config_t clientConfig = {};
  clientConfig.is_synchronous = false;
  clientConfig.max_num_event_msg = 4;
  clientConfig.async.client_event_callback = clientEvent;
  clientConfig.async.callback_arg = nullptr;
  if (usb_host_client_register(&clientConfig, &g_client) != ESP_OK) {
    LOGE("usbhost: client registration failed");
    g_taskRunning = false;
    vTaskDelete(nullptr);
    return;
  }
  LOGI("usbhost: host library ready, waiting for a printer");

  while (true) {
    uint32_t flags = 0;
    usb_host_lib_handle_events(0, &flags);
    usb_host_client_handle_events(g_client, 0);

    if (g_pendingAttach) {
      g_pendingAttach = false;
      attachDevice(g_pendingAddress);
    }

    if (g_connected) {
      pumpOnce();
      if (g_rx && g_epIn && xSemaphoreTake(g_rxDone, 0) == pdTRUE) {
        g_rx->num_bytes = (int)kTransferSize;
        usb_host_transfer_submit(g_rx);
      }
    }

    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

}  // namespace

bool printerUsbBegin() {
  if (!g_config.usbHostEnabled) return false;
  if (g_taskRunning) return true;

  if (!g_ringLock) g_ringLock = xSemaphoreCreateMutex();
  if (!g_txDone) g_txDone = xSemaphoreCreateBinary();
  if (!g_rxDone) g_rxDone = xSemaphoreCreateBinary();
  if (!g_ringLock || !g_txDone || !g_rxDone) {
    LOGE("usbhost: unable to create synchronisation primitives");
    return false;
  }

  const BaseType_t created = xTaskCreatePinnedToCore(usbTask, "arsin-usb", 4096, nullptr, 2, nullptr, kTaskCore);
  if (created != pdPASS) {
    LOGE("usbhost: unable to start the USB task");
    return false;
  }
  LOGI("usbhost: driver task started on core %d", (int)kTaskCore);
  return true;
}

void printerUsbLoop() { /* the USB task does the work */ }

bool printerUsbConnected() { return g_connected; }

size_t printerUsbWrite(const uint8_t* data, size_t len) {
  if (!g_connected || !data) return 0;
  return ringPush(data, len);
}

void printerUsbDescribe(char* vid, size_t vidCap, char* pid, size_t pidCap, char* manufacturer, size_t mfgCap,
                        char* product, size_t prodCap) {
  if (vid && vidCap) {
    strncpy(vid, g_vid, vidCap - 1);
    vid[vidCap - 1] = 0;
  }
  if (pid && pidCap) {
    strncpy(pid, g_pid, pidCap - 1);
    pid[pidCap - 1] = 0;
  }
  if (manufacturer && mfgCap) {
    strncpy(manufacturer, g_manufacturer, mfgCap - 1);
    manufacturer[mfgCap - 1] = 0;
  }
  if (product && prodCap) {
    strncpy(product, g_product, prodCap - 1);
    product[prodCap - 1] = 0;
  }
}

#endif /* ARSIN_FEATURE_USBHOST */
