/*
 * Arsin Print Server - persistence implementation (ESP32 NVS / ESP8266 EEPROM).
 */
#include "arsin_store.h"

#include <Arduino.h>
#include <string.h>

#include "arsin_log.h"

#if defined(ARDUINO_ARCH_ESP32)

#include <Preferences.h>

namespace {
Preferences g_prefs;
bool g_ready = false;
uint32_t g_generation = 0;
const char* kNamespace = "arsin-ps";
const char* kKeyCfg = "cfg";
const char* kKeyGen = "gen";
}  // namespace

bool storeBegin() {
  g_ready = g_prefs.begin(kNamespace, false);
  if (!g_ready) {
    LOGW("nvs: unable to open namespace %s", kNamespace);
    return false;
  }
  g_generation = g_prefs.getUInt(kKeyGen, 0);
  return true;
}

bool storeLoadText(char* out, size_t cap) {
  if (!g_ready || !out || cap == 0) return false;
  const String value = g_prefs.getString(kKeyCfg, String());
  if (value.length() == 0 || value.length() >= cap) return false;
  memcpy(out, value.c_str(), value.length());
  out[value.length()] = 0;
  return true;
}

bool storeSaveText(const char* text) {
  if (!g_ready || !text) return false;
  const size_t len = strlen(text);
  if (len == 0 || len >= ARSIN_STORE_TEXT_MAX) {
    LOGE("nvs: config too large (%u bytes)", (unsigned)len);
    return false;
  }
  const size_t written = g_prefs.putString(kKeyCfg, text);
  if (written != len) {
    LOGE("nvs: short write (%u/%u)", (unsigned)written, (unsigned)len);
    return false;
  }
  g_generation++;
  g_prefs.putUInt(kKeyGen, g_generation);
  return true;
}

void storeWipe() {
  if (!g_ready) return;
  g_prefs.remove(kKeyCfg);
  g_prefs.remove(kKeyGen);
  g_generation = 0;
}

uint32_t storeGeneration() { return g_generation; }

#else /* ESP8266 (and any other EEPROM based target) */

#include <EEPROM.h>

namespace {
const uint32_t kMagic = 0x41525331UL; /* "ARS1" */
const uint16_t kOffset = 16;
uint16_t g_size = 4096;
bool g_ready = false;
uint32_t g_generation = 0;

uint32_t crc32(const uint8_t* data, size_t len) {
  uint32_t crc = 0xFFFFFFFFUL;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++) {
      crc = (crc & 1) ? ((crc >> 1) ^ 0xEDB88320UL) : (crc >> 1);
    }
  }
  return ~crc;
}

void writeU32(uint16_t addr, uint32_t value) {
  for (int i = 0; i < 4; i++) EEPROM.write((int)(addr + i), (uint8_t)((value >> (8 * i)) & 0xFF));
}

uint32_t readU32(uint16_t addr) {
  uint32_t value = 0;
  for (int i = 0; i < 4; i++) value |= ((uint32_t)EEPROM.read((int)(addr + i)) << (8 * i));
  return value;
}

void writeU16(uint16_t addr, uint16_t value) {
  EEPROM.write((int)addr, (uint8_t)(value & 0xFF));
  EEPROM.write((int)(addr + 1), (uint8_t)((value >> 8) & 0xFF));
}

uint16_t readU16(uint16_t addr) {
  return (uint16_t)(EEPROM.read((int)addr) | ((uint16_t)EEPROM.read((int)(addr + 1)) << 8));
}
}  // namespace

bool storeBegin() {
#if defined(ARDUINO_ARCH_ESP8266)
  EEPROM.begin(g_size);
  g_ready = true;
#else
  g_ready = EEPROM.begin(g_size);
#endif
  if (!g_ready) {
    LOGW("eeprom: begin failed");
    return false;
  }
  g_generation = readU32(12);
  return true;
}

bool storeLoadText(char* out, size_t cap) {
  if (!g_ready || !out || cap == 0) return false;
  if (readU32(0) != kMagic) return false;
  const uint16_t len = readU16(4);
  if (len == 0 || len >= cap || (size_t)(kOffset + len) > g_size) return false;
  uint8_t* buf = (uint8_t*)out;
  for (uint16_t i = 0; i < len; i++) buf[i] = EEPROM.read((int)(kOffset + i));
  out[len] = 0;
  if (crc32(buf, len) != readU32(8)) {
    LOGW("eeprom: crc mismatch, ignoring stored config");
    return false;
  }
  return true;
}

bool storeSaveText(const char* text) {
  if (!g_ready || !text) return false;
  const size_t len = strlen(text);
  if (len == 0 || len >= ARSIN_STORE_TEXT_MAX || (size_t)(kOffset + len) > g_size) {
    LOGE("eeprom: config too large (%u bytes)", (unsigned)len);
    return false;
  }
  writeU32(0, kMagic);
  writeU16(4, (uint16_t)len);
  writeU32(8, crc32((const uint8_t*)text, len));
  for (size_t i = 0; i < len; i++) EEPROM.write((int)(kOffset + i), (uint8_t)text[i]);
  EEPROM.write((int)(kOffset + len), 0);
  g_generation++;
  writeU32(12, g_generation);
  if (!EEPROM.commit()) {
    LOGE("eeprom: commit failed");
    return false;
  }
  return true;
}

void storeWipe() {
  if (!g_ready) return;
  for (uint16_t i = 0; i < kOffset; i++) EEPROM.write((int)i, 0);
  EEPROM.commit();
  g_generation = 0;
}

uint32_t storeGeneration() { return g_generation; }

#endif
