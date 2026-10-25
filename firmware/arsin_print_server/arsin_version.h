/*
 * Arsin Print Server - build identity, compile variants and board detection.
 *
 * Every variant is selected with a single -D flag (see firmware/README.md):
 *   ARSIN_VARIANT_WIFI / _BT / _BLE / _USBHOST / _SERIAL / _HYBRID
 * and maps onto one of the catalog app ids used by the web installer.
 */
#ifndef ARSIN_VERSION_H
#define ARSIN_VERSION_H

#define ARSIN_FW_VERSION "1.0.0"
#define ARSIN_DEVICE_ID "arsin_print_server"
#define ARSIN_MDNS_HOST "arsin-print-server"      /* mDNS hostname            */
#define ARSIN_MDNS_NAME "arsin_print_server.local" /* advertised http:// name */
#define ARSIN_BUILD_DATE __DATE__ " " __TIME__

/* ------------------------------------------------------------------ variant */

#if defined(ARSIN_VARIANT_HYBRID)
  #define ARSIN_VARIANT_ID "hybrid"
  #define ARSIN_APP_ID "print-server-hybrid"
#elif defined(ARSIN_VARIANT_BT)
  #define ARSIN_VARIANT_ID "bt"
  #define ARSIN_APP_ID "print-server-bt-spp"
#elif defined(ARSIN_VARIANT_BLE)
  #define ARSIN_VARIANT_ID "ble"
  #define ARSIN_APP_ID "print-server-ble"
#elif defined(ARSIN_VARIANT_USBHOST)
  #define ARSIN_VARIANT_ID "usbhost"
  #define ARSIN_APP_ID "print-server-usbhost"
#elif defined(ARSIN_VARIANT_SERIAL)
  #define ARSIN_VARIANT_ID "serial"
  #define ARSIN_APP_ID "print-server-serial"
#elif defined(ARSIN_VARIANT_WIFI)
  #define ARSIN_VARIANT_ID "wifi"
  #define ARSIN_APP_ID "print-server-wifi"
#else
  /* Default build: the most capable variant the chip can run. */
  #define ARSIN_VARIANT_HYBRID 1
  #define ARSIN_VARIANT_ID "hybrid"
  #define ARSIN_APP_ID "print-server-hybrid"
#endif

/* ----------------------------------------------------------- chip detection */

#if defined(ARDUINO_ARCH_ESP32)
  #if defined(CONFIG_IDF_TARGET_ESP32S3)
    #define ARSIN_CHIP "esp32s3"
    #define ARSIN_CHIP_USB_HOST 1
    #define ARSIN_CHIP_BLE 1
    #define ARSIN_CHIP_BT_SPP 0
  #elif defined(CONFIG_IDF_TARGET_ESP32S2)
    #define ARSIN_CHIP "esp32s2"
    #define ARSIN_CHIP_USB_HOST 1
    #define ARSIN_CHIP_BLE 0
    #define ARSIN_CHIP_BT_SPP 0
  #elif defined(CONFIG_IDF_TARGET_ESP32C3)
    #define ARSIN_CHIP "esp32c3"
    #define ARSIN_CHIP_USB_HOST 0
    #define ARSIN_CHIP_BLE 1
    #define ARSIN_CHIP_BT_SPP 0
  #elif defined(CONFIG_IDF_TARGET_ESP32C6)
    #define ARSIN_CHIP "esp32c6"
    #define ARSIN_CHIP_USB_HOST 0
    #define ARSIN_CHIP_BLE 1
    #define ARSIN_CHIP_BT_SPP 0
  #else
    /* ESP32 / ESP32-D0WD / WROVER: dual radio, Bluetooth Classic + BLE. */
    #define ARSIN_CHIP "esp32"
    #define ARSIN_CHIP_USB_HOST 0
    #define ARSIN_CHIP_BLE 1
    #define ARSIN_CHIP_BT_SPP 1
  #endif
#elif defined(ARDUINO_ARCH_ESP8266)
  #define ARSIN_CHIP "esp8266"
  #define ARSIN_CHIP_USB_HOST 0
  #define ARSIN_CHIP_BLE 0
  #define ARSIN_CHIP_BT_SPP 0
#else
  #define ARSIN_CHIP "unknown"
  #define ARSIN_CHIP_USB_HOST 0
  #define ARSIN_CHIP_BLE 0
  #define ARSIN_CHIP_BT_SPP 0
#endif

/* ------------------------------------- feature flags derived from the variant */

#if defined(ARSIN_VARIANT_WIFI) || defined(ARSIN_VARIANT_HYBRID) || \
    defined(ARSIN_VARIANT_SERIAL) || defined(ARSIN_VARIANT_USBHOST) || \
    defined(ARSIN_VARIANT_BT) || defined(ARSIN_VARIANT_BLE)
  #define ARSIN_FEATURE_WIFI 1
#else
  #define ARSIN_FEATURE_WIFI 0
#endif

#if defined(ARSIN_VARIANT_SERIAL) || defined(ARSIN_VARIANT_HYBRID) || \
    defined(ARSIN_VARIANT_WIFI) || defined(ARSIN_VARIANT_BT) || \
    defined(ARSIN_VARIANT_BLE) || defined(ARSIN_VARIANT_USBHOST)
  #define ARSIN_FEATURE_SERIAL 1
#else
  #define ARSIN_FEATURE_SERIAL 0
#endif

#if defined(ARSIN_VARIANT_BT) || defined(ARSIN_VARIANT_HYBRID)
  #define ARSIN_FEATURE_BT_SPP 1
#else
  #define ARSIN_FEATURE_BT_SPP 0
#endif

#if defined(ARSIN_VARIANT_BLE) || defined(ARSIN_VARIANT_HYBRID)
  #define ARSIN_FEATURE_BLE 1
#else
  #define ARSIN_FEATURE_BLE 0
#endif

#if defined(ARSIN_VARIANT_USBHOST) || defined(ARSIN_VARIANT_HYBRID)
  #define ARSIN_FEATURE_USBHOST 1
#else
  #define ARSIN_FEATURE_USBHOST 0
#endif

/* ------------------------------------------------ per-chip feature pruning */

#if !ARSIN_CHIP_USB_HOST
  #undef ARSIN_FEATURE_USBHOST
  #define ARSIN_FEATURE_USBHOST 0
#endif

#if !ARSIN_CHIP_BLE
  #undef ARSIN_FEATURE_BLE
  #define ARSIN_FEATURE_BLE 0
#endif

#if !ARSIN_CHIP_BT_SPP
  /* ESP32-S3/S2/C3/C6 have no Bluetooth Classic radio: SPP is unavailable. */
  #undef ARSIN_FEATURE_BT_SPP
  #define ARSIN_FEATURE_BT_SPP 0
#endif

#if defined(ARDUINO_ARCH_ESP8266)
  #undef ARSIN_FEATURE_BT_SPP
  #undef ARSIN_FEATURE_BLE
  #undef ARSIN_FEATURE_USBHOST
  #define ARSIN_FEATURE_BT_SPP 0
  #define ARSIN_FEATURE_BLE 0
  #define ARSIN_FEATURE_USBHOST 0
  #define ARSIN_FEATURE_WIFI 1
  #define ARSIN_FEATURE_SERIAL 1
#endif

/* ---------------------------------------------------------------- board id */

#ifndef ARSIN_BOARD_ID
  #if defined(ARDUINO_ARCH_ESP8266)
    #if defined(ARDUINO_ESP8266_NODEMCU)
      #define ARSIN_BOARD_ID "esp8266-nodemcu-v3"
    #elif defined(ARDUINO_ESP8266_WEMOS_D1MINI)
      #define ARSIN_BOARD_ID "esp8266-d1-mini"
    #elif defined(ARDUINO_ESP8266_ESP01)
      #define ARSIN_BOARD_ID "esp8266-esp-01s"
    #else
      #define ARSIN_BOARD_ID "esp8266-nodemcu-v3"
    #endif
  #elif defined(CONFIG_IDF_TARGET_ESP32S3)
    #define ARSIN_BOARD_ID "esp32-s3-devkitc-1"
  #elif defined(CONFIG_IDF_TARGET_ESP32S2)
    #define ARSIN_BOARD_ID "esp32-s2-devkit"
  #elif defined(CONFIG_IDF_TARGET_ESP32C3)
    #define ARSIN_BOARD_ID "esp32-c3-devkitm-1"
  #elif defined(CONFIG_IDF_TARGET_ESP32C6)
    #define ARSIN_BOARD_ID "esp32-c6-devkitc-1"
  #elif defined(BOARD_HAS_PSRAM)
    #define ARSIN_BOARD_ID "esp32-wrover-devkit"
  #else
    #define ARSIN_BOARD_ID "esp32-devkit-v1"
  #endif
#endif

#endif /* ARSIN_VERSION_H */
