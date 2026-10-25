/*
 * Arsin Print Server - Bluetooth front end.
 *
 * ESP32 (classic)  : BluetoothSerial SPP, name/PIN from config.bt.
 * ESP32-S3/S2/C3/C6: BLE GATT UART (Nordic UART Service compatible) with
 *                    reassembly of fragmented writes.
 * ESP8266          : Wi-Fi only - every entry point is a no-op and the API
 *                    reports bt.enabled=false with a note.
 */
#ifndef ARSIN_BT_H
#define ARSIN_BT_H

#include <stddef.h>
#include <stdint.h>

bool arsinBtBegin();
void arsinBtLoop();
bool arsinBtEnabled();
bool arsinBtConnected();
/** "spp" | "ble" | "off" */
const char* arsinBtMode();
/** Human readable reason when Bluetooth is unavailable on this build. */
const char* arsinBtNote();
/** Bytes received over the Bluetooth link since boot. */
uint32_t arsinBtRxBytes();

#endif /* ARSIN_BT_H */
