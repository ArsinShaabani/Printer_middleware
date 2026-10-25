/*
 * Arsin Print Server - log ring + printer reply ring implementation.
 */
#include "arsin_log.h"

#include <Arduino.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "arsin_json.h"

namespace {

struct LogEntry {
  uint32_t seq;
  uint32_t t;
  uint8_t level;
  char msg[ARSIN_LOG_MSG];
};

LogEntry g_log[ARSIN_LOG_MAX];
uint16_t g_logCount = 0;   /* valid entries                          */
uint16_t g_logHead = 0;    /* next slot to write                     */
uint16_t g_logLimit = ARSIN_LOG_MAX;
uint32_t g_logSeq = 0;     /* total entries ever written             */
ArsinLogLevel g_level = ARSIN_LOG_INFO;

uint8_t g_serial[ARSIN_SERIAL_RING];
uint32_t g_serialWritten = 0; /* total bytes ever pushed */

const char* levelName(uint8_t level) {
  switch (level) {
    case ARSIN_LOG_DEBUG: return "debug";
    case ARSIN_LOG_INFO: return "info";
    case ARSIN_LOG_WARN: return "warn";
    default: return "error";
  }
}

ArsinLogLevel levelFromName(const char* name) {
  if (!name) return ARSIN_LOG_INFO;
  if (!strcasecmp(name, "debug")) return ARSIN_LOG_DEBUG;
  if (!strcasecmp(name, "warn") || !strcasecmp(name, "warning")) return ARSIN_LOG_WARN;
  if (!strcasecmp(name, "error")) return ARSIN_LOG_ERROR;
  return ARSIN_LOG_INFO;
}

}  // namespace

void arsinLogBegin(uint16_t bufferLines, const char* level) {
  memset(g_log, 0, sizeof(g_log));
  g_logCount = 0;
  g_logHead = 0;
  g_logSeq = 0;
  arsinLogSetBufferLines(bufferLines);
  arsinLogSetLevel(level);
}

void arsinLogSetLevel(const char* level) { g_level = levelFromName(level); }

void arsinLogSetBufferLines(uint16_t bufferLines) {
  if (bufferLines < 10) bufferLines = 10;
  if (bufferLines > ARSIN_LOG_MAX) bufferLines = ARSIN_LOG_MAX;
  g_logLimit = bufferLines;
  if (g_logCount > g_logLimit) g_logCount = g_logLimit;
}

void arsinLogRaw(const char* line) {
  if (!line) return;
  LogEntry& e = g_log[g_logHead];
  e.seq = ++g_logSeq;
  e.t = millis();
  e.level = (uint8_t)ARSIN_LOG_INFO;
  strncpy(e.msg, line, ARSIN_LOG_MSG - 1);
  e.msg[ARSIN_LOG_MSG - 1] = 0;
  g_logHead = (uint16_t)((g_logHead + 1) % g_logLimit);
  if (g_logCount < g_logLimit) g_logCount++;
}

void arsinLogWrite(ArsinLogLevel level, const char* fmt, ...) {
  char tmp[ARSIN_LOG_MSG];
  va_list args;
  va_start(args, fmt);
  vsnprintf(tmp, sizeof(tmp), fmt, args);
  va_end(args);

  if (level >= g_level) {
    LogEntry& e = g_log[g_logHead];
    e.seq = ++g_logSeq;
    e.t = millis();
    e.level = (uint8_t)level;
    strncpy(e.msg, tmp, ARSIN_LOG_MSG - 1);
    e.msg[ARSIN_LOG_MSG - 1] = 0;
    g_logHead = (uint16_t)((g_logHead + 1) % g_logLimit);
    if (g_logCount < g_logLimit) g_logCount++;
  }
  if (level >= ARSIN_LOG_WARN) {
    Serial.printf("[%s] %s\n", levelName((uint8_t)level), tmp);
  }
}

size_t arsinLogSince(uint32_t since, char* out, size_t cap, uint32_t* next) {
  JsonOut json(out, cap);
  json.beginObject();
  json.beginArrayAt("lines");
  size_t written = 0;
  uint32_t maxSeq = since;
  const uint16_t start = (uint16_t)((g_logHead + g_logLimit - g_logCount) % g_logLimit);
  for (uint16_t i = 0; i < g_logCount; i++) {
    const LogEntry& e = g_log[(start + i) % g_logLimit];
    if (e.seq <= since) continue;
    json.beginObject();
    json.kvULong("t", e.t);
    json.kvString("level", levelName(e.level));
    json.kvString("msg", e.msg);
    json.kvULong("seq", e.seq);
    json.endObject();
    written++;
    if (e.seq > maxSeq) maxSeq = e.seq;
  }
  json.endArray();
  json.kvULong("next", (written == 0) ? (unsigned long)since : (unsigned long)maxSeq);
  json.endObject();
  if (next) *next = (written == 0) ? since : maxSeq;
  return written;
}

uint32_t arsinLogCursor() { return g_logSeq; }
uint32_t arsinLogCount() { return g_logCount; }

/* ------------------------------------------------------- printer reply ring */

void arsinSerialRingReset() {
  memset(g_serial, 0, sizeof(g_serial));
  g_serialWritten = 0;
}

void arsinSerialRingPush(const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    g_serial[g_serialWritten % ARSIN_SERIAL_RING] = data[i];
    g_serialWritten++;
  }
}

size_t arsinSerialRingSince(uint32_t since, char* out, size_t cap, uint32_t* next) {
  const uint32_t oldest = (g_serialWritten > ARSIN_SERIAL_RING) ? (g_serialWritten - ARSIN_SERIAL_RING) : 0;
  uint32_t from = since;
  if (from < oldest) from = oldest;
  if (from > g_serialWritten) from = g_serialWritten;
  const size_t available = (size_t)(g_serialWritten - from);
  /* hex output needs 3 bytes per byte plus a terminator. */
  const size_t maxBytes = (cap > 1) ? ((cap - 1) / 3) : 0;
  const size_t n = (available < maxBytes) ? available : maxBytes;
  size_t o = 0;
  for (size_t i = 0; i < n; i++) {
    const uint8_t b = g_serial[(from + i) % ARSIN_SERIAL_RING];
    static const char* digits = "0123456789ABCDEF";
    if (o + 3 < cap) {
      out[o++] = digits[(b >> 4) & 0x0F];
      out[o++] = digits[b & 0x0F];
      out[o++] = ' ';
    }
  }
  if (o > 0) o--; /* trailing space */
  if (out && cap) out[o] = 0;
  if (next) *next = from + n;
  return n;
}

uint32_t arsinSerialRingCursor() { return g_serialWritten; }

size_t arsinSerialRingPending() {
  return (g_serialWritten > ARSIN_SERIAL_RING) ? ARSIN_SERIAL_RING : (size_t)g_serialWritten;
}
