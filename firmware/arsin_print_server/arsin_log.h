/*
 * Arsin Print Server - bounded log ring + printer reply ring.
 *
 * Everything is preallocated: no heap churn, no String in the hot paths.  Both
 * rings expose a monotonically increasing cursor so the REST API can hand out
 * "give me everything since N" without copying the whole buffer.
 */
#ifndef ARSIN_LOG_H
#define ARSIN_LOG_H

#include <stddef.h>
#include <stdint.h>

#if defined(ARDUINO_ARCH_ESP8266)
  #define ARSIN_LOG_MAX 40
  #define ARSIN_LOG_MSG 88
  #define ARSIN_SERIAL_RING 256
#else
  #define ARSIN_LOG_MAX 96
  #define ARSIN_LOG_MSG 96
  #define ARSIN_SERIAL_RING 1024
#endif

enum ArsinLogLevel { ARSIN_LOG_DEBUG = 0, ARSIN_LOG_INFO = 1, ARSIN_LOG_WARN = 2, ARSIN_LOG_ERROR = 3 };

void arsinLogBegin(uint16_t bufferLines, const char* level);
void arsinLogSetLevel(const char* level);
void arsinLogSetBufferLines(uint16_t bufferLines);
/** printf style logger; also mirrors to the USB console. */
void arsinLogWrite(ArsinLogLevel level, const char* fmt, ...);
void arsinLogRaw(const char* line);

#define LOGD(...) arsinLogWrite(ARSIN_LOG_DEBUG, __VA_ARGS__)
#define LOGI(...) arsinLogWrite(ARSIN_LOG_INFO, __VA_ARGS__)
#define LOGW(...) arsinLogWrite(ARSIN_LOG_WARN, __VA_ARGS__)
#define LOGE(...) arsinLogWrite(ARSIN_LOG_ERROR, __VA_ARGS__)

/** Serialise the entries newer than `since` into `out` as a JSON array.
 *  Returns the number of entries written; `next` receives the new cursor. */
size_t arsinLogSince(uint32_t since, char* out, size_t cap, uint32_t* next);
uint32_t arsinLogCursor();
uint32_t arsinLogCount();

/* ------------------------------------------------------- printer reply ring */

void arsinSerialRingReset();
void arsinSerialRingPush(const uint8_t* data, size_t len);
/** Hex encode every byte received after `since` (window limited to the ring). */
size_t arsinSerialRingSince(uint32_t since, char* out, size_t cap, uint32_t* next);
uint32_t arsinSerialRingCursor();
size_t arsinSerialRingPending();

#endif /* ARSIN_LOG_H */
