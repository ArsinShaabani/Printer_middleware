/*
 * Arsin Print Server - persistence.
 *
 * ESP32  : Preferences / NVS (namespace "arsin-ps", keys "cfg" + "gen").
 * ESP8266: EEPROM with a magic + CRC32 envelope (the core has no Preferences).
 *
 * The configuration is persisted as JSON text, exactly the same document the
 * REST API exchanges, which keeps loading migration safe: unknown keys are
 * ignored and missing keys keep their defaults.
 */
#ifndef ARSIN_STORE_H
#define ARSIN_STORE_H

#include <stddef.h>
#include <stdint.h>

#define ARSIN_STORE_TEXT_MAX 2600

bool storeBegin();
/** Copy the persisted document into `out`; false when nothing is stored. */
bool storeLoadText(char* out, size_t cap);
bool storeSaveText(const char* text);
/** Erase the persisted document (factory reset). */
void storeWipe();
/** Bumped on every successful write - handy for diagnostics. */
uint32_t storeGeneration();

#endif /* ARSIN_STORE_H */
