/*
 * Arsin Print Server - HTTP/REST layer implementation.
 */
#include "arsin_web.h"

#include <Arduino.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "arsin_assets.h"
#include "arsin_bt.h"
#include "arsin_commands.h"
#include "arsin_config.h"
#include "arsin_json.h"
#include "arsin_log.h"
#include "arsin_net.h"
#include "arsin_printer.h"
#include "arsin_store.h"
#include "arsin_version.h"

#if defined(ARDUINO_ARCH_ESP8266)
  #include <ESP8266WebServer.h>
  #include <Updater.h>
  #include <WiFiClient.h>
  #include <WiFiServer.h>
  using ArsinWebServer = ESP8266WebServer;
#else
  #include <Update.h>
  #include <WebServer.h>
  /* WiFiClient is used directly (raw 9100, telnet debug, SSE); the ESP32 core's
   * WiFiServer.h does not pull it in. */
  #include <WiFiClient.h>
  #include <WiFiServer.h>
  using ArsinWebServer = WebServer;
#endif

/* The ESP8266 core calls this "size unknown" with 0, the ESP32 core has a
 * dedicated constant. */
#ifndef UPDATE_SIZE_UNKNOWN
  #define UPDATE_SIZE_UNKNOWN 0
#endif

/* SSE (persistent event stream) needs arduino-esp32 core 3.x, which keeps a
 * client marked with setSSE() open and exposes chunked writes. */
#if defined(ARDUINO_ARCH_ESP32)
  #if __has_include(<esp_arduino_version.h>)
    #include <esp_arduino_version.h>
  #endif
  #if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
    #define ARSIN_SSE_SUPPORTED 1
  #else
    #define ARSIN_SSE_SUPPORTED 0
  #endif
#else
  #define ARSIN_SSE_SUPPORTED 0
#endif

/* Streaming request bodies need the "raw body" handler API of arduino-esp32
 * core 3.x: WebServer::_parseRequest() then hands a POST body over in
 * HTTP_RAW_BUFLEN slices instead of buffering all of it into arg("plain").
 * ESP32 core 2.x and the ESP8266 core have no equivalent, so there the body is
 * streamed from the socket whenever the core leaves it alone (chunked or close
 * delimited transfers) and the bounded buffered path stays in place otherwise -
 * see handlePrint() and ArsinPrintRawHandler below. */
#if ARSIN_SSE_SUPPORTED
  #define ARSIN_RAW_BODY_SUPPORTED 1
#else
  #define ARSIN_RAW_BODY_SUPPORTED 0
#endif

namespace {

#if defined(ARDUINO_ARCH_ESP8266)
const size_t kBodyMax = 4096;    /* largest body the ESP8266 core can buffer    */
const size_t kStreamChunk = 512; /* socket read window - ESP8266 RAM is tight   */
#else
const size_t kBodyMax = 65536;   /* largest body the ESP32 core buffers         */
const size_t kStreamChunk = 1024;
#endif
/* /api/print never holds more than one socket chunk.  The only other buffer is
 * the bounded repeat spool, and that is allocated per job solely for the
 * copies > 1 case, because a streamed body cannot be read a second time. */
const size_t kSpoolMax = kBodyMax;
const uint32_t kStreamIdleMs = 5000;    /* no byte from the peer for this long  */
const uint32_t kStreamTotalMs = 120000; /* whole job guard (512 kB ~ 45 s)      */
const uint32_t kPrintWriteMs = 4000;    /* printerWriteAll budget per chunk     */
const uint32_t kCutWriteMs = 1000;
const uint32_t kSseIntervalMs = 2000;
const size_t kSseMaxClients = 3;
const uint32_t kRawClientIdleMs = 15000;

ArsinWebServer g_server;
WiFiServer g_rawServer;
WiFiServer g_telnetServer;
WiFiClient g_rawClients[2];
uint32_t g_rawLast[2] = {0, 0};
WiFiClient g_telnetClient;

char g_json[ARSIN_CFG_JSON_MAX + 512];
char g_small[1024];

bool g_restartPending = false;
uint32_t g_restartAt = 0;
uint32_t g_jobSeq = 0;
char g_lastJobId[20] = "";
uint32_t g_webRequests = 0;

#if ARSIN_SSE_SUPPORTED
WiFiClient g_sseClients[kSseMaxClients];
uint32_t g_sseLastPush = 0;
#endif

const char* kJsonType = "application/json";
const char* kTextType = "text/plain";

/* ----------------------------------------------------------------- helpers */

void applyCors() {
  if (!g_config.allowCors) return;
  g_server.sendHeader("Access-Control-Allow-Origin", "*");
  g_server.sendHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");
  g_server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  g_server.sendHeader("Access-Control-Max-Age", "600");
}

void sendJson(int code, const char* body) {
  applyCors();
  g_server.sendHeader("Cache-Control", "no-store");
  g_server.send(code, kJsonType, body ? body : "{}");
  g_webRequests++;
}

void sendText(int code, const char* contentType, const char* body) {
  applyCors();
  g_server.sendHeader("Cache-Control", "no-store");
  g_server.send(code, contentType ? contentType : kTextType, body ? body : "");
  g_webRequests++;
}

void sendOk(const char* extraJson) {
  snprintf(g_small, sizeof(g_small), "{\"ok\":true%s%s}", (extraJson && extraJson[0]) ? "," : "",
           (extraJson && extraJson[0]) ? extraJson : "");
  sendJson(200, g_small);
}

void sendError(int code, const char* message) {
  char body[220];
  snprintf(body, sizeof(body), "{\"ok\":false,\"error\":\"%s\"}", message ? message : "error");
  sendJson(code, body);
}

bool apiKeyMatches(ArsinWebServer& server) {
  if (g_config.apiKey[0] == 0) return true;
  if (!server.hasHeader("X-Api-Key")) return false;
  return strcmp(server.header("X-Api-Key").c_str(), g_config.apiKey) == 0;
}

bool apiKeyOk() { return apiKeyMatches(g_server); }

/** State changing endpoints are protected by security.apiKey. */
bool requireWriteAuth() {
  if (apiKeyOk()) return true;
  sendError(401, "missing or invalid X-Api-Key");
  return false;
}

bool webAuthOk() {
  if (g_config.webPassword[0] == 0) return true;
  return g_server.authenticate("admin", g_config.webPassword);
}

/**
 * Content-Length of the current request.
 *
 * The ESP32 WebServer exposes clientContentLength(); the ESP8266 one does not,
 * so read the header instead. This file is shared by both sketches.
 */
size_t requestContentLength(ArsinWebServer& server) {
#if defined(ARDUINO_ARCH_ESP8266)
  return server.hasHeader("Content-Length") ? (size_t)server.header("Content-Length").toInt() : 0;
#else
  return server.hasHeader("Content-Length") ? (size_t)server.clientContentLength() : 0;
#endif
}

bool requireWebAuth() {
  if (webAuthOk()) return true;
  g_server.requestAuthentication(BASIC_AUTH, "Arsin Print Server", "Authentication required");
  return false;
}

const char* body() {
  if (g_server.hasArg("plain")) return g_server.arg("plain").c_str();
  return "";
}

size_t bodyLen() {
  if (g_server.hasArg("plain")) return (size_t)g_server.arg("plain").length();
  return 0;
}

void nextJobId(char* out, size_t cap) {
  g_jobSeq++;
  snprintf(out, cap, "j%06lu", (unsigned long)(g_jobSeq % 1000000));
  strncpy(g_lastJobId, out, sizeof(g_lastJobId) - 1);
  g_lastJobId[sizeof(g_lastJobId) - 1] = 0;
}

void scheduleRestart(uint32_t delayMs) {
  g_restartPending = true;
  g_restartAt = millis() + delayMs;
}

/* forward declarations for helpers used before their definition */
void webhookPost(const char* jobId, uint32_t bytes);

/* ----------------------------------------------------------- JSON builders */

}  // namespace

size_t webInfoJson(char* out, size_t cap) {
  JsonOut json(out, cap);
  json.beginObject();
  json.kvString("device", ARSIN_DEVICE_ID);
  json.kvString("app", ARSIN_APP_ID);
  json.kvString("board", ARSIN_BOARD_ID);
  json.kvString("version", ARSIN_FW_VERSION);
  json.kvString("build", ARSIN_BUILD_DATE);
  json.kvString("variant", ARSIN_VARIANT_ID);
  json.kvString("mac", netMac());
  json.kvString("ip", netStaConnected() ? netStaIp() : netApIp());
  json.kvString("hostname", netHostname());
  json.kvString("transport", printerActiveTransport());
  json.kvString("language", g_config.language);
  json.kvULong("uptimeMs", millis());
  json.kvULong("freeHeap", ESP.getFreeHeap());
  json.kvLong("rssi", (long)netRssi());
  json.kvString("mdns", ARSIN_MDNS_NAME);
  json.kvString("wifiMode", netWifiMode());
  json.kvString("chip", ARSIN_CHIP);
  json.endObject();
  return json.length();
}

size_t webStatusJson(char* out, size_t cap) {
  JsonOut json(out, cap);
  json.beginObject();
  json.kvString("state", printerStateName());

  json.beginObjectAt("printer");
  json.kvBool("connected", printerConnected());
  json.kvString("status", printerHealthName());
  json.kvString("lastReply", printerLastReply());
  json.kvString("transport", printerActiveTransport());
  json.endObject();

  json.beginObjectAt("queue");
  json.kvULong("depth", (unsigned long)printerQueueDepth());
  json.kvULong("capacity", (unsigned long)printerQueueCapacity());
  json.kvString("lastJobId", g_lastJobId);
  json.endObject();

  json.beginObjectAt("counters");
  json.kvULong("jobs", printerJobs());
  json.kvULong("bytes", printerBytes());
  json.kvULong("errors", printerErrors());
  json.endObject();

  json.beginObjectAt("wifi");
  json.kvString("ssid", netStaConnected() ? netStaSsid() : "");
  json.kvString("ip", netStaConnected() ? netStaIp() : netApIp());
  json.kvLong("rssi", (long)netRssi());
  json.kvString("mode", netWifiMode());
  json.endObject();

  json.beginObjectAt("bt");
  json.kvBool("enabled", arsinBtEnabled());
  json.kvBool("connected", arsinBtConnected());
  json.kvString("name", printerBtName());
  json.kvString("mode", arsinBtMode());
  json.kvString("note", arsinBtNote());
  json.endObject();

  char vid[8] = "0x0000";
  char pid[8] = "0x0000";
  char manufacturer[40] = "";
  char product[40] = "";
  printerUsbDescribe(vid, sizeof(vid), pid, sizeof(pid), manufacturer, sizeof(manufacturer), product, sizeof(product));
  json.beginObjectAt("usb");
  json.kvBool("connected", printerUsbConnected());
  json.kvString("vid", vid);
  json.kvString("pid", pid);
  json.kvString("manufacturer", manufacturer);
  json.kvString("product", product);
  json.endObject();

  json.kvULong("heap", ESP.getFreeHeap());
  json.kvULong("uptimeMs", millis());
  json.endObject();
  return json.length();
}

namespace {

size_t wifiJson(char* out, size_t cap) {
  JsonOut json(out, cap);
  json.beginObject();
  json.kvBool("ok", true);
  json.kvString("mode", netWifiMode());
  json.beginObjectAt("sta");
  json.kvBool("connected", netStaConnected());
  json.kvString("ssid", netStaSsid());
  json.kvString("ip", netStaIp());
  json.kvLong("rssi", (long)netRssi());
  json.kvString("hostname", netHostname());
  json.endObject();
  json.beginObjectAt("ap");
  json.kvBool("enabled", netApActive());
  json.kvString("ssid", g_config.apSsid);
  json.kvString("ip", netApIp());
  json.endObject();
  json.beginArrayAt("saved");
  for (uint8_t i = 0; i < g_config.savedCount; i++) {
    json.beginObject();
    json.kvString("ssid", g_config.saved[i].ssid);
    json.kvBool("lastGood", g_config.lastGoodIndex == (int8_t)i);
    json.endObject();
  }
  json.endArray();
  json.kvBool("mdns", netMdnsActive());
  json.endObject();
  return json.length();
}

/* ------------------------------------------------------------- API handlers */

void handleHealth() {
  applyCors();
  g_server.sendHeader("Cache-Control", "no-store");
  g_server.send(200, "text/plain", "arsin-print-server ok");
  g_webRequests++;
}

void handleInfo() {
  webInfoJson(g_json, sizeof(g_json));
  sendJson(200, g_json);
}

void handleStatus() {
  webStatusJson(g_json, sizeof(g_json));
  sendJson(200, g_json);
}

void handleConfigGet() {
  if (!requireWebAuth()) return;
  configToJson(g_config, g_json, sizeof(g_json));
  sendJson(200, g_json);
}

void handleConfigPost() {
  if (!requireWriteAuth()) return;
  const size_t len = bodyLen();
  if (len == 0) {
    sendError(400, "empty body");
    return;
  }
  char before[192];
  configCriticalFingerprint(g_config, before, sizeof(before));

  char err[64];
  if (!configApplyJson(body(), len, err, sizeof(err))) {
    char msg[128];
    snprintf(msg, sizeof(msg), "invalid JSON: %s", err);
    sendError(400, msg);
    return;
  }

  char after[192];
  configCriticalFingerprint(g_config, after, sizeof(after));
  const bool restartRequired = strcmp(before, after) != 0;
  configSave();
  arsinLogSetLevel(g_config.logLevel);
  arsinLogSetBufferLines(g_config.logBufferLines);
  if (!restartRequired) netApplyConfig();

  snprintf(g_small, sizeof(g_small), "{\"ok\":true,\"restartRequired\":%s}", restartRequired ? "true" : "false");
  sendJson(200, g_small);
}

/* ------------------------------------------------- streamed print uploads */

/* One /api/print job in flight.  /api/print never holds more than one socket
 * chunk (kStreamChunk); the only other buffer is the bounded repeat spool, and
 * that exists solely for the copies > 1 case.  A 512 kB label therefore costs
 * about 1 kB of RAM instead of the whole payload. */
struct PrintJob {
  bool active;       /* a body is being pushed to the printer right now     */
  bool coreStreamed; /* the ESP32 raw-body callback owns the socket         */
  bool authorised;   /* the request passed the X-Api-Key check              */
  bool stalled;      /* printer queue did not drain within kPrintWriteMs    */
  bool truncated;    /* body ended before Content-Length was satisfied      */
  bool overflow;     /* body larger than the repeat spool                   */
  uint32_t received; /* bytes read from the wire                            */
  uint32_t written;  /* bytes accepted by the printer queue                 */
  size_t spooled;    /* bytes kept for the extra copies                     */
  uint8_t* spool;
  char jobId[20];
  char lang[16];
  bool wantCut;
  int copies;
};

PrintJob g_job;

/** Release the job and its optional spool - safe to call at any time. */
void printJobClear() {
  if (g_job.spool) free(g_job.spool); /* free(nullptr) is a no-op */
  memset(&g_job, 0, sizeof(g_job));
  g_job.copies = 1;
}

/** Arm a job before its body arrives.  `coreStreamed` selects which code path
 *  finishes it: the ESP32 raw-body callback or handlePrint() itself. */
void printJobBegin(bool coreStreamed, const char* lang, bool wantCut, int copies, const char* jobId) {
  printJobClear();
  g_job.active = true;
  g_job.coreStreamed = coreStreamed;
  g_job.authorised = true;
  g_job.wantCut = wantCut;
  g_job.copies = (copies < 1) ? 1 : copies;
  snprintf(g_job.jobId, sizeof(g_job.jobId), "%s", jobId ? jobId : "");
  snprintf(g_job.lang, sizeof(g_job.lang), "%s", (lang && lang[0]) ? lang : "escpos");
  if (g_job.copies > 1) {
    /* A streamed body cannot be read a second time, so the extra copies are
     * replayed from this bounded spool.  When it cannot be allocated, or the
     * job turns out to be larger than the spool, the job is printed once -
     * see printJobFinish(). */
    g_job.spool = (uint8_t*)malloc(kSpoolMax);
    if (!g_job.spool) LOGW("print: no %u byte repeat spool - only one copy", (unsigned)kSpoolMax);
  }
}

/** Forward one chunk with the queue back-pressure behaviour of the buffered
 *  path.  Returns false when the printer queue refused the data. */
bool printJobPush(const uint8_t* data, size_t len) {
  if (!g_job.active) return false;
  if (!len) return true;
  const size_t sent = printerWriteAll(data, len, kPrintWriteMs);
  g_job.received += (uint32_t)len;
  g_job.written += (uint32_t)sent;
  if (sent < len) {
    g_job.stalled = true;
    printerSetError("printer queue stalled");
    LOGW("print: %u of %u byte(s) refused by the printer queue", (unsigned)(len - sent), (unsigned)len);
    return false;
  }
  if (g_job.spool) {
    if (g_job.spooled + len <= kSpoolMax) {
      memcpy(g_job.spool + g_job.spooled, data, len);
      g_job.spooled += len;
    } else {
      g_job.overflow = true;
    }
  }
  return true;
}

/** Read up to `want` bytes from the socket, waiting at most `idleMs` for the
 *  first one.  Returns the byte count; 0 means the peer went quiet or closed,
 *  which for a close delimited body is the end of the transfer. */
size_t streamReadChunk(WiFiClient& client, uint8_t* buf, size_t want, uint32_t idleMs) {
  const uint32_t started = millis();
  while ((uint32_t)(millis() - started) <= idleMs) {
    const int available = client.available();
    if (available > 0) {
      size_t n = (size_t)available;
      if (n > want) n = want;
      const int got = client.read(buf, n);
      return (got > 0) ? (size_t)got : 0;
    }
    if (!client.connected()) return 0;
    printerLoop(); /* keep the printer queue draining while we wait */
    yield();
    delay(1);      /* never longer than 50 ms, so the watchdog stays happy */
  }
  return 0;
}

/** Read one CRLF terminated line (chunk size line or trailer).  Returns the
 *  line length without CR/LF, or -1 when the peer stopped answering. */
int streamReadLine(WiFiClient& client, char* out, size_t cap, uint32_t idleMs) {
  size_t len = 0;
  const uint32_t started = millis();
  while ((uint32_t)(millis() - started) <= idleMs) {
    const int available = client.available();
    if (available > 0) {
      const int c = client.read();
      if (c < 0) break;
      if (c == '\n') {
        if (len && out[len - 1] == '\r') len--;
        out[len] = 0;
        return (int)len;
      }
      if (len + 1 < cap) out[len++] = (char)c; /* overlong line: keep reading */
    } else if (!client.connected()) {
      return -1;
    } else {
      printerLoop();
      yield();
      delay(1);
    }
  }
  if (len < cap) out[len] = 0;
  return -1;
}

/** Decode a `Transfer-Encoding: chunked` body and forward it chunk by chunk.
 *  The web application always sends a Content-Length, but a streaming client
 *  (browser ReadableStream body, `curl -T -`) does not, and forwarding the
 *  chunk framing to a printer would be worse than refusing the job. */
bool streamChunkedBody(WiFiClient& client, uint32_t started) {
  uint8_t buf[kStreamChunk];
  char line[24];
  for (;;) {
    if ((uint32_t)(millis() - started) > kStreamTotalMs) return false;
    const int n = streamReadLine(client, line, sizeof(line), kStreamIdleMs);
    if (n < 0) return false;
    if (n == 0) continue; /* tolerate a stray CRLF between chunks */
    char* end = nullptr;
    const unsigned long size = strtoul(line, &end, 16);
    if (end == line || size > 0x00400000UL) return false; /* not a chunk size */
    if (size == 0) {
      /* terminal chunk - swallow the bounded trailer section */
      for (int i = 0; i < 8; i++) {
        if (streamReadLine(client, line, sizeof(line), kStreamIdleMs) <= 0) break;
      }
      return true;
    }
    size_t remaining = (size_t)size;
    while (remaining) {
      size_t want = sizeof(buf);
      if (remaining < want) want = remaining;
      const size_t got = streamReadChunk(client, buf, want, kStreamIdleMs);
      if (got == 0) return false;
      if (!printJobPush(buf, got)) return false;
      printerLoop();
      yield();
      remaining -= got;
      if ((uint32_t)(millis() - started) > kStreamTotalMs) return false;
    }
    streamReadLine(client, line, sizeof(line), kStreamIdleMs); /* trailing CRLF */
  }
}

/** Forward the rest of the request body straight to the printer.
 *
 *  Bounded in every dimension: at most kStreamChunk bytes live in RAM at once,
 *  every chunk goes through printerWriteAll() (the same queue, back-pressure and
 *  timeout behaviour as the buffered path) and printerLoop()/yield() run between
 *  chunks so the watchdog and the Wi-Fi stack stay serviced.  Nothing here
 *  depends on the size of the job - the loop keeps going until Content-Length is
 *  satisfied (`expected`), the terminal chunk of a chunked body arrives, or the
 *  peer closes / goes quiet for kStreamIdleMs.
 *
 *  Returns true when the whole body reached the printer. */
bool streamPrintBody(WiFiClient& client, size_t expected, bool chunked) {
  const uint32_t started = millis();
  if (chunked) {
    if (streamChunkedBody(client, started)) return true;
    g_job.truncated = true;
    return false;
  }

  uint8_t buf[kStreamChunk];
  size_t remaining = expected;
  for (;;) {
    size_t want = sizeof(buf);
    if (expected) {
      if (remaining == 0) return true;
      if (remaining < want) want = remaining;
    }
    const size_t got = streamReadChunk(client, buf, want, kStreamIdleMs);
    if (got == 0) {
      /* Without Content-Length the transfer ends when the peer stops sending;
       * with it, a short read means the peer gave up in the middle of the job. */
      if (expected) g_job.truncated = true;
      return expected == 0;
    }
    if (!printJobPush(buf, got)) return false;
    printerLoop();
    yield();
    if (expected) remaining -= got;
    if ((uint32_t)(millis() - started) > kStreamTotalMs) {
      g_job.truncated = true;
      return false;
    }
  }
}

/** Cut once after the last copy, count the job and answer it.  Called exactly
 *  once per job - from handlePrint() for the buffered and socket-streamed
 *  paths, or after the ESP32 raw-body callback finished the transfer. */
void printJobFinish() {
  const bool complete = g_job.active && !g_job.stalled && !g_job.truncated;
  uint32_t bytes = g_job.written;

  if (complete && g_job.copies > 1) {
    if (g_job.spool && !g_job.overflow) {
      for (int copy = 1; copy < g_job.copies; copy++) {
        const size_t sent = printerWriteAll(g_job.spool, g_job.spooled, kPrintWriteMs);
        bytes += (uint32_t)sent;
        if (sent < g_job.spooled) {
          g_job.stalled = true;
          printerSetError("printer queue stalled");
          break;
        }
        printerLoop(); /* keep draining between copies */
      }
    } else {
      LOGW("print: job %s asked for %d copies but the body is larger than the %u byte spool - printed once",
           g_job.jobId, g_job.copies, (unsigned)kSpoolMax);
    }
  }

  const bool ok = complete && !g_job.stalled;
  if (ok && g_job.wantCut) {
    uint8_t cut[16];
    size_t cutLen = 0;
    char note[64];
    if (arsinBuildCommand(g_job.lang, "cut", nullptr, 0, cut, sizeof(cut), &cutLen, note, sizeof(note)) && cutLen) {
      bytes += (uint32_t)printerWriteAll(cut, cutLen, kCutWriteMs);
    }
  }

  if (ok) {
    printerCountJob(g_job.jobId);
    LOGI("api: print job %s (%s) %s %u byte(s) received, %u byte(s) sent", g_job.jobId, g_job.lang,
         g_job.coreStreamed ? "[raw body]" : "[socket]", (unsigned)g_job.received, (unsigned)bytes);
    webhookPost(g_job.jobId, bytes);
    snprintf(g_small, sizeof(g_small), "{\"ok\":true,\"jobId\":\"%s\",\"bytes\":%u}", g_job.jobId,
             (unsigned)bytes);
    sendJson(200, g_small);
  } else if (g_job.stalled) {
    char msg[192];
    snprintf(msg, sizeof(msg), "{\"ok\":false,\"error\":\"printer queue stalled\",\"jobId\":\"%s\",\"bytes\":%u}",
             g_job.jobId, (unsigned)bytes);
    sendJson(503, msg);
  } else {
    char msg[192];
    snprintf(msg, sizeof(msg), "{\"ok\":false,\"error\":\"print body incomplete\",\"jobId\":\"%s\",\"bytes\":%u}",
             g_job.jobId, (unsigned)bytes);
    sendJson(400, msg);
  }
  printJobClear();
}

void handlePrint() {
  const bool rawJob = g_job.active; /* armed by the ESP32 raw-body callback */

  if (!requireWriteAuth()) {
    /* The raw-body path runs before this handler, so the API key is checked
     * there as well (see printRawBody) - no byte ever reached the printer. */
    if (rawJob) printJobClear();
    return;
  }

  /* The ESP32 raw-body callback already pushed the whole body through the
   * printer queue: only cut, count and answer are left to do. */
  if (rawJob) {
    printJobFinish();
    return;
  }

  const char* lang = g_server.hasArg("lang") ? g_server.arg("lang").c_str() : g_config.language;
  const bool wantCut = g_server.hasArg("cut") ? (g_server.arg("cut").toInt() != 0) : g_config.cut;
  int copies = g_server.hasArg("copies") ? g_server.arg("copies").toInt() : 1;
  if (copies < 1) copies = 1;
  if (copies > 20) copies = 20;

  char jobId[20];
  nextJobId(jobId, sizeof(jobId));

  /* --- fallback: the core already buffered the body into arg("plain") -----
   * ESP32 core 2.x and the ESP8266 core always do that, and ESP32 core 3.x
   * does it for every body it is allowed to buffer - canRaw() in
   * ArsinPrintRawHandler only claims jobs above kBodyMax, because the raw path
   * cannot see the query string.  The bytes are in RAM here already, so they go
   * through the printer queue exactly as before and a job bigger than kBodyMax
   * is still refused with 413 (see firmware/README.md). */
  if (g_server.hasArg("plain")) {
    const char* payload = body();
    const size_t len = bodyLen();
    if (len == 0) {
      sendError(400, "no print data received (send the job as the request body)");
      return;
    }
    if (len > kBodyMax) {
      sendError(413, "job too large for this device - send it chunked or use the raw port 9100");
      return;
    }

    uint32_t bytes = 0;
    for (int copy = 0; copy < copies; copy++) {
      const size_t sent = printerWriteAll((const uint8_t*)payload, len, kPrintWriteMs);
      bytes += (uint32_t)sent;
      if (sent < len) {
        printerSetError("printer queue stalled");
        char msg[176];
        snprintf(msg, sizeof(msg),
                 "{\"ok\":false,\"error\":\"printer queue stalled\",\"jobId\":\"%s\",\"bytes\":%u}", jobId,
                 (unsigned)bytes);
        sendJson(503, msg);
        return;
      }
      printerLoop(); /* keep draining between copies */
    }

    if (wantCut) {
      uint8_t cut[16];
      size_t cutLen = 0;
      char note[64];
      if (arsinBuildCommand(lang, "cut", nullptr, 0, cut, sizeof(cut), &cutLen, note, sizeof(note)) && cutLen) {
        bytes += (uint32_t)printerWriteAll(cut, cutLen, kCutWriteMs);
      }
    }

    printerCountJob(jobId);
    LOGI("api: print job %s (%s) %u byte(s) x%d", jobId, lang, (unsigned)len, copies);
    webhookPost(jobId, bytes);
    snprintf(g_small, sizeof(g_small), "{\"ok\":true,\"jobId\":\"%s\",\"bytes\":%u}", jobId, (unsigned)bytes);
    sendJson(200, g_small);
    return;
  }

  /* --- stream the body from the socket straight to the printer ----------- */
  WiFiClient client = g_server.client(); /* shares the socket with the server */
  const bool hasContentLength = g_server.hasHeader("Content-Length");
  const size_t contentLength = hasContentLength ? requestContentLength(g_server) : 0;
  const bool chunked = g_server.hasHeader("Transfer-Encoding") &&
                       g_server.header("Transfer-Encoding").indexOf("chunked") >= 0;
  if (!chunked && hasContentLength && contentLength == 0) {
    /* An explicit empty body: answer at once instead of waiting for data that
     * will never arrive. */
    sendError(400, "no print data received (send the job as the request body)");
    return;
  }
  printJobBegin(false, lang, wantCut, copies, jobId);
  LOGI("api: print job %s (%s) streaming a %s body", jobId, lang,
       chunked ? "chunked" : (contentLength ? "Content-Length" : "close delimited"));
  const bool done = streamPrintBody(client, contentLength, chunked);
  if (!done) LOGW("print: job %s ended early after %u byte(s)", jobId, (unsigned)g_job.received);
  printJobFinish();
}

#if ARSIN_RAW_BODY_SUPPORTED
/** ESP32 core 3.x raw-body callback for /api/print (see ArsinPrintRawHandler).
 *
 *  WebServer::_parseRequest() calls it with RAW_START, then once per
 *  HTTP_RAW_BUFLEN (1436 byte) slice, then RAW_END, and it never holds more than
 *  one slice - which is what lets a 512 kB label through on a device with a few
 *  hundred kB of heap.  Every slice goes through the same printer queue as the
 *  buffered path; the job is cut, counted and answered by handlePrint(). */
void printRawBody(WebServer& server, HTTPRaw& raw) {
  switch (raw.status) {
    case RAW_START: {
      /* This path runs before the core parses the query string, so lang/cut/
       * copies fall back to the configured defaults (documented in
       * firmware/README.md).  The API key is checked here, before the first
       * byte can reach the printer. */
      char jobId[20];
      nextJobId(jobId, sizeof(jobId));
      printJobBegin(true, g_config.language, g_config.cut, 1, jobId);
      g_job.authorised = apiKeyMatches(server);
      if (!g_job.authorised) LOGW("api: refusing print job %s - missing or invalid X-Api-Key", jobId);
      LOGI("api: print job %s (%s) streaming the raw body", jobId, g_config.language);
      break;
    }
    case RAW_WRITE:
      if (!g_job.active || !g_job.authorised || g_job.stalled) break; /* drain only */
      printJobPush(raw.buf, raw.currentSize);
      printerLoop();
      yield();
      break;
    case RAW_END:
      break; /* handlePrint() takes over */
    case RAW_ABORTED:
      if (g_job.active) {
        LOGW("print: body aborted after %u byte(s)", (unsigned)g_job.received);
        printJobClear(); /* the core drops the connection, so no response follows */
      }
      break;
    default:
      break;
  }
}

/** Route POST /api/print through the raw-body path when - and only when - the
 *  core would otherwise buffer the whole job.
 *
 *  canRaw() claims bodies above kBodyMax.  The raw path runs before the core
 *  parses the query string, so `lang`, `cut` and `copies` are unavailable for
 *  those jobs: the configured defaults apply and the request is logged.  Every
 *  job the core is allowed to buffer keeps the full query-string behaviour, so
 *  ordinary receipts behave exactly as before.  handle() is called for both
 *  paths, so small jobs simply fall through to handlePrint(). */
class ArsinPrintRawHandler : public RequestHandler {
 public:
  bool canHandle(HTTPMethod method, const String& uri) override {
    return method == HTTP_POST && uri == "/api/print";
  }
  bool canHandle(WebServer& server, HTTPMethod method, const String& uri) override {
    (void)server;
    return canHandle(method, uri);
  }
  bool canRaw(WebServer& server, const String& uri) override {
    return uri == "/api/print" && requestContentLength(server) > (size_t)kBodyMax;
  }
  bool handle(WebServer& server, HTTPMethod method, const String& uri) override {
    (void)server;
    (void)method;
    (void)uri;
    handlePrint();
    return true;
  }
  void raw(WebServer& server, const String& uri, HTTPRaw& raw) override {
    (void)uri;
    printRawBody(server, raw);
  }
};
#endif /* ARSIN_RAW_BODY_SUPPORTED */

void handleCommand() {
  if (!requireWriteAuth()) return;
  const size_t len = bodyLen();
  if (len == 0) {
    sendError(400, "empty body");
    return;
  }

  char lang[16] = "";
  char action[24] = "";
  JsonPickString langPick("lang", lang, sizeof(lang));
  JsonPickString actionPick("action", action, sizeof(action));
  char err[48];
  if (!arsinJsonParse(body(), len, langPick, err, sizeof(err)) ||
      !arsinJsonParse(body(), len, actionPick, err, sizeof(err))) {
    char msg[128];
    snprintf(msg, sizeof(msg), "invalid JSON: %s", err);
    sendError(400, msg);
    return;
  }
  if (action[0] == 0) {
    sendError(400, "missing \"action\"");
    return;
  }
  if (lang[0] == 0) snprintf(lang, sizeof(lang), "%s", g_config.language);

  /* locate the params object inside the request */
  const char* params = strstr(body(), "\"params\"");
  size_t paramsLen = 0;
  if (params) {
    params = strchr(params, ':');
    if (params) {
      params++;
      while (*params == ' ') params++;
      if (*params != '{') {
        params = nullptr;
      } else {
        int depth = 0;
        bool inString = false;
        for (const char* p = params; *p; ++p) {
          if (*p == '"' && (p == params || *(p - 1) != '\\')) inString = !inString;
          if (inString) continue;
          if (*p == '{') depth++;
          if (*p == '}') {
            depth--;
            if (depth == 0) {
              paramsLen = (size_t)(p - params + 1);
              break;
            }
          }
        }
      }
    }
  }

  uint8_t out[512];
  size_t outLen = 0;
  char note[96];
  if (!arsinBuildCommand(lang, action, params, paramsLen, out, sizeof(out), &outLen, note, sizeof(note))) {
    char msg[224];
    snprintf(msg, sizeof(msg), "{\"ok\":false,\"error\":\"%s\",\"action\":\"%s\",\"lang\":\"%s\"}",
             note[0] ? note : "unsupported command", action, lang);
    sendJson(400, msg);
    return;
  }

  const size_t sent = printerWriteAll(out, outLen, 2000);
  if (sent < outLen) {
    printerSetError("printer queue stalled");
    sendError(503, "printer queue stalled");
    return;
  }

  /* static buffers: command hex dumps must not eat the (small) ESP8266 stack */
  static char hex[sizeof(out) * 3 + 4];
  arsinHexEncode(out, outLen, hex, sizeof(hex), true);
  JsonOut json(g_json, sizeof(g_json));
  json.beginObject();
  json.kvBool("ok", true);
  json.kvString("hex", hex);
  json.kvULong("bytes", (unsigned long)outLen);
  json.kvString("note", note);
  json.kvString("lang", lang);
  json.kvString("action", action);
  json.endObject();
  sendJson(200, g_json);
  LOGI("api: command %s/%s -> %u byte(s)", lang, action, (unsigned)outLen);
}

void handleRaw() {
  if (!requireWriteAuth()) return;
  const size_t len = bodyLen();
  if (len == 0) {
    sendError(400, "empty body");
    return;
  }
  char mode[8] = "hex";
  /* Static, not stack: a hex body of 2 kB decodes to 1 kB of printer data and
   * the ESP8266 loop task stack is only a few kB.  One request is served at a
   * time, and both fields are mandatory, so the buffers cannot go stale. */
  static char data[2052];
  static uint8_t out[1024];
  data[0] = 0;
  JsonPickString modePick("mode", mode, sizeof(mode));
  JsonPickString dataPick("data", data, sizeof(data));
  char err[48];
  if (!arsinJsonParse(body(), len, modePick, err, sizeof(err)) ||
      !arsinJsonParse(body(), len, dataPick, err, sizeof(err))) {
    sendError(400, "invalid JSON");
    return;
  }

  size_t outLen = 0;
  if (!strcasecmp(mode, "text")) {
    outLen = strlen(data);
    if (outLen > sizeof(out)) outLen = sizeof(out);
    memcpy(out, data, outLen);
  } else {
    outLen = arsinHexDecode(data, out, sizeof(out));
  }
  if (outLen == 0) {
    sendError(400, "no bytes to send");
    return;
  }

  const size_t sent = printerWriteAll(out, outLen, 2000);
  if (sent < outLen) {
    sendError(503, "printer queue stalled");
    return;
  }
  snprintf(g_small, sizeof(g_small), "{\"ok\":true,\"bytes\":%u}", (unsigned)sent);
  sendJson(200, g_small);
}

void handleSerial() {
  const uint32_t since = g_server.hasArg("since") ? (uint32_t)strtoul(g_server.arg("since").c_str(), nullptr, 10) : 0;
  static char hex[ARSIN_SERIAL_RING * 3 + 8];
  uint32_t next = since;
  const size_t n = arsinSerialRingSince(since, hex, sizeof(hex), &next);
  JsonOut json(g_json, sizeof(g_json));
  json.beginObject();
  json.kvString("data", hex);
  json.kvULong("next", next);
  json.kvULong("bytes", (unsigned long)n);
  json.endObject();
  sendJson(200, g_json);
}

void handleLogs() {
  const uint32_t since = g_server.hasArg("since") ? (uint32_t)strtoul(g_server.arg("since").c_str(), nullptr, 10) : 0;
  uint32_t next = since;
  arsinLogSince(since, g_json, sizeof(g_json), &next);
  sendJson(200, g_json);
}

void handleWifiGet() {
  if (!requireWebAuth()) return;
  wifiJson(g_json, sizeof(g_json));
  sendJson(200, g_json);
}

void handleWifiScan() {
  if (!requireWriteAuth()) return;
  if (netScanBusy()) {
    sendError(429, "a scan is already running");
    return;
  }
  netScanJson(g_json, sizeof(g_json));
  sendJson(200, g_json);
}

void handleWifiJoin() {
  if (!requireWriteAuth()) return;
  const size_t len = bodyLen();
  char ssid[33] = "";
  char password[65] = "";
  char save[8] = "true";
  JsonPickString ssidPick("ssid", ssid, sizeof(ssid));
  JsonPickString passPick("password", password, sizeof(password));
  JsonPickString savePick("save", save, sizeof(save));
  char err[48];
  if (!arsinJsonParse(body(), len, ssidPick, err, sizeof(err)) ||
      !arsinJsonParse(body(), len, passPick, err, sizeof(err)) ||
      !arsinJsonParse(body(), len, savePick, err, sizeof(err))) {
    sendError(400, "invalid JSON");
    return;
  }
  if (ssid[0] == 0) {
    sendError(400, "missing \"ssid\"");
    return;
  }
  const bool persist = strcasecmp(save, "false") != 0;
  const bool ok = netJoin(ssid, password, persist);
  snprintf(g_small, sizeof(g_small), "{\"ok\":%s,\"ssid\":\"%s\",\"ip\":\"%s\",\"rssi\":%ld,\"saved\":%s}",
           ok ? "true" : "false", ssid, netStaIp(), (long)netRssi(), persist ? "true" : "false");
  sendJson(ok ? 200 : 504, g_small);
}

void handleAp() {
  if (!requireWriteAuth()) return;
  const size_t len = bodyLen();
  char ssid[33] = "";
  char password[65] = "";
  char enabled[8] = "true";
  JsonPickString ssidPick("ssid", ssid, sizeof(ssid));
  JsonPickString passPick("password", password, sizeof(password));
  JsonPickString enabledPick("enabled", enabled, sizeof(enabled));
  char err[48];
  if (len > 0) {
    if (!arsinJsonParse(body(), len, ssidPick, err, sizeof(err)) ||
        !arsinJsonParse(body(), len, passPick, err, sizeof(err)) ||
        !arsinJsonParse(body(), len, enabledPick, err, sizeof(err))) {
      sendError(400, "invalid JSON");
      return;
    }
  }
  const bool on = strcasecmp(enabled, "false") != 0;
  netConfigureAp(ssid[0] ? ssid : nullptr, len > 0 ? password : nullptr, on);
  snprintf(g_small, sizeof(g_small), "{\"ok\":true,\"ap\":{\"enabled\":%s,\"ssid\":\"%s\",\"ip\":\"%s\"}}",
           netApActive() ? "true" : "false", g_config.apSsid, netApIp());
  sendJson(200, g_small);
}

void handleReboot() {
  if (!requireWriteAuth()) return;
  LOGW("api: reboot requested");
  scheduleRestart(600);
  sendJson(200, "{\"ok\":true,\"restarting\":true}");
}

void handleFactoryReset() {
  if (!requireWriteAuth()) return;
  LOGW("api: factory reset requested");
  configFactoryReset(g_config);
  configWipe();
  configSave();
  scheduleRestart(800);
  sendJson(200, "{\"ok\":true,\"restartRequired\":true,\"restarting\":true}");
}

void handleCountersReset() {
  if (!requireWriteAuth()) return;
  printerCountersReset();
  arsinSerialRingReset();
  sendOk(nullptr);
}

void handleBackupGet() {
  if (!requireWebAuth()) return;
  configToJson(g_config, g_json, sizeof(g_json));
  applyCors();
  g_server.sendHeader("Content-Disposition", "attachment; filename=\"arsin-print-server-config.json\"");
  g_server.sendHeader("Cache-Control", "no-store");
  g_server.send(200, kJsonType, g_json);
  g_webRequests++;
}

void handleBackupPost() {
  if (!requireWriteAuth()) return;
  const size_t len = bodyLen();
  if (len == 0) {
    sendError(400, "empty body");
    return;
  }
  char err[64];
  if (!configApplyJson(body(), len, err, sizeof(err))) {
    char msg[128];
    snprintf(msg, sizeof(msg), "invalid JSON: %s", err);
    sendError(400, msg);
    return;
  }
  configSave();
  sendJson(200, "{\"ok\":true,\"restartRequired\":true}");
}

/* --------------------------------------------------------------------- OTA */

uint32_t g_otaWritten = 0;
bool g_otaFailed = false;

void handleOtaUpload() {
  HTTPUpload& upload = g_server.upload();
  if (upload.status == UPLOAD_FILE_START) {
    g_otaWritten = 0;
    g_otaFailed = false;
    LOGI("ota: receiving %s", upload.filename.c_str());
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      g_otaFailed = true;
      LOGE("ota: Update.begin failed");
    }
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (g_otaFailed) return;
    if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
      g_otaFailed = true;
      LOGE("ota: write failed");
      return;
    }
    g_otaWritten += upload.currentSize;
  } else if (upload.status == UPLOAD_FILE_END) {
    if (g_otaFailed) return;
    if (!Update.end(true)) {
      g_otaFailed = true;
      LOGE("ota: Update.end failed");
      return;
    }
    LOGI("ota: %u byte(s) written", (unsigned)g_otaWritten);
  } else if (upload.status == UPLOAD_FILE_ABORTED) {
#if !defined(ARDUINO_ARCH_ESP8266)
    Update.abort();
#endif
    g_otaFailed = true;
    LOGE("ota: aborted");
  }
}

void handleOtaFinish() {
  if (!requireWriteAuth()) return;
  if (g_otaFailed || Update.hasError()) {
    sendError(500, "OTA update failed");
    return;
  }
  if (g_otaWritten == 0) {
    /* Raw (non multipart) body: accepted only while it fits in RAM. */
    const size_t len = bodyLen();
    if (len == 0) {
      sendError(400, "no firmware received - POST the .bin as multipart/form-data field \"firmware\"");
      return;
    }
    if (len > kBodyMax) {
      sendError(413, "raw firmware body too large - use multipart/form-data (curl -F firmware=@app.bin)");
      return;
    }
    if (!Update.begin(len)) {
      sendError(500, "Update.begin failed");
      return;
    }
    if (Update.write((uint8_t*)body(), len) != len || !Update.end(true)) {
      sendError(500, "Update failed");
      return;
    }
    g_otaWritten = (uint32_t)len;
  }
  snprintf(g_small, sizeof(g_small), "{\"ok\":true,\"bytes\":%u,\"restarting\":true}", (unsigned)g_otaWritten);
  sendJson(200, g_small);
  scheduleRestart(900);
}

/* -------------------------------------------------------------- SSE /events */

bool webSseSupported() { return ARSIN_SSE_SUPPORTED != 0; }

const char* webSseNote() {
#if ARSIN_SSE_SUPPORTED
  return "text/event-stream, one status document every 2 s";
#else
  return "server-sent events need arduino-esp32 core 3.x - poll /api/status instead";
#endif
}

bool webSseClients() {
#if ARSIN_SSE_SUPPORTED
  for (size_t i = 0; i < kSseMaxClients; i++) {
    if (g_sseClients[i]) return true;
  }
#endif
  return false;
}

void handleEvents() {
#if ARSIN_SSE_SUPPORTED
  g_server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  g_server.sendHeader("Cache-Control", "no-cache");
  g_server.sendHeader("Access-Control-Allow-Origin", "*");
  g_server.client().setSSE(true);
  g_server.send(200, "text/event-stream", "");

  WiFiClient client = g_server.client();
  bool attached = false;
  for (size_t i = 0; i < kSseMaxClients; i++) {
    if (!g_sseClients[i]) {
      g_sseClients[i] = client;
      attached = true;
      break;
    }
  }
  if (!attached) {
    /* recycle the oldest slot */
    g_sseClients[0] = client;
  }
  client.print("retry: 2000\r\n\r\n");
  webStatusJson(g_json, sizeof(g_json));
  char header[16];
  snprintf(header, sizeof(header), "%x\r\n", (unsigned)strlen(g_json));
  client.print(header);
  client.print(g_json);
  client.print("\r\n");
  g_sseLastPush = millis();
  LOGI("sse: client attached");
#else
  applyCors();
  g_server.sendHeader("Cache-Control", "no-store");
  g_server.send(501, "text/plain", "arsin-print-server: SSE not supported on this build; poll /api/status every 2 s");
#endif
}

/* ---------------------------------------------------------------- static UI */

void handleStatic() {
  if (!requireWebAuth()) return;
  String path = g_server.uri();
  const WebAsset* asset = arsinAssetFind(path.c_str());
  if (!asset) {
    /* SPA fallback: unknown paths return the index document */
    asset = arsinAssetIndex();
  }
  if (!asset) {
    sendText(404, kTextType, "not found");
    return;
  }

  const bool wantsGzip = asset->gz && g_server.hasHeader("Accept-Encoding") &&
                         (g_server.header("Accept-Encoding").indexOf("gzip") >= 0);
  if (asset->gz) {
    g_server.sendHeader("Content-Encoding", "gzip");
    if (!wantsGzip) {
      LOGD("web: client did not advertise gzip, serving compressed asset anyway");
    }
  }
  g_server.sendHeader("Vary", "Accept-Encoding");
  if (!asset->gz) {
    g_server.sendHeader("Cache-Control", "no-cache");
  } else {
    g_server.sendHeader("Cache-Control", "public, max-age=600");
  }
  g_server.send_P(200, asset->mime, (PGM_P)asset->data, (size_t)asset->len);
  g_webRequests++;
}

void handleOptions() {
  applyCors();
  g_server.send(204, kTextType, "");
}

void handleNotFound() {
  if (g_server.method() == HTTP_OPTIONS) {
    handleOptions();
    return;
  }
  if (g_server.uri().startsWith("/api/")) {
    sendError(404, "unknown endpoint");
    return;
  }
  handleStatic();
}

/* ------------------------------------------------------------- raw 9100 server */

void rawServerLoop() {
  WiFiClient incoming = g_rawServer.available();
  if (incoming) {
    for (size_t i = 0; i < 2; i++) {
      if (!g_rawClients[i]) {
        g_rawClients[i] = incoming;
        g_rawLast[i] = millis();
        LOGI("raw: client %u connected on port %u", (unsigned)i, (unsigned)webRawPort());
        break;
      }
    }
  }

  for (size_t i = 0; i < 2; i++) {
    if (!g_rawClients[i]) continue;
    if (!g_rawClients[i].connected()) {
      LOGI("raw: client %u disconnected", (unsigned)i);
      g_rawClients[i].stop();
      continue;
    }
    const size_t room = printerQueueCapacity() - printerQueueDepth();
    const size_t available = (size_t)g_rawClients[i].available();
    if (available == 0 || room == 0) {
      if (millis() - g_rawLast[i] > kRawClientIdleMs) {
        g_rawClients[i].stop();
        LOGW("raw: client %u idle timeout", (unsigned)i);
      }
      continue;
    }
    uint8_t buf[256];
    size_t toRead = available;
    if (toRead > sizeof(buf)) toRead = sizeof(buf);
    if (toRead > room) toRead = room;
    const size_t read = g_rawClients[i].read(buf, toRead);
    if (read == 0) continue;
    const size_t accepted = printerWrite(buf, read);
    if (accepted < read) {
      printerSetError("raw client overflow");
      LOGW("raw: dropped %u byte(s) from client %u", (unsigned)(read - accepted), (unsigned)i);
    }
    g_rawLast[i] = millis();
  }
}

/* --------------------------------------------------------------- telnet debug */

void telnetLoop() {
  if (!g_config.telnetDebug) return;
  if (!g_telnetClient || !g_telnetClient.connected()) {
    WiFiClient incoming = g_telnetServer.available();
    if (incoming) {
      g_telnetClient = incoming;
      g_telnetClient.print("arsin-print-server telnet debug\r\n");
      g_telnetClient.print("status: ");
      g_telnetClient.print(printerStateName());
      g_telnetClient.print("  transport: ");
      g_telnetClient.print(printerActiveTransport());
      g_telnetClient.print("\r\n");
      LOGI("telnet: debug client connected");
    }
    return;
  }

  static uint32_t cursor = 0;
  static uint32_t lastPoll = 0;
  if (millis() - lastPoll < 1000) return;
  lastPoll = millis();
  uint32_t next = cursor;
  const size_t lines = arsinLogSince(cursor, g_small, sizeof(g_small), &next);
  if (lines > 0) {
    g_telnetClient.print(g_small);
    g_telnetClient.print("\r\n");
    cursor = next;
  }
}

/* ------------------------------------------------------------------- webhook */

void webhookPost(const char* jobId, uint32_t bytes) {
  if (g_config.webhookUrl[0] == 0 || !g_config.webhookOnJob) return;
  const char* url = g_config.webhookUrl;
  if (strncmp(url, "http://", 7) != 0) {
    LOGW("webhook: only http:// URLs are supported");
    return;
  }
  const char* hostStart = url + 7;
  const char* pathStart = strchr(hostStart, '/');
  char host[80];
  size_t hostLen = pathStart ? (size_t)(pathStart - hostStart) : strlen(hostStart);
  if (hostLen >= sizeof(host)) hostLen = sizeof(host) - 1;
  memcpy(host, hostStart, hostLen);
  host[hostLen] = 0;
  const char* path = pathStart ? pathStart : "/";

  uint16_t port = 80;
  char* colon = strchr(host, ':');
  if (colon) {
    *colon = 0;
    port = (uint16_t)atoi(colon + 1);
  }

  WiFiClient client;
  if (!client.connect(host, port, 2000)) {
    LOGW("webhook: cannot reach %s:%u", host, (unsigned)port);
    return;
  }
  char body[220];
  snprintf(body, sizeof(body),
           "{\"device\":\"%s\",\"jobId\":\"%s\",\"bytes\":%u,\"state\":\"%s\",\"transport\":\"%s\"}",
           g_config.deviceName, jobId ? jobId : "", (unsigned)bytes, printerStateName(), printerActiveTransport());
  client.print("POST ");
  client.print(path);
  client.print(" HTTP/1.1\r\nHost: ");
  client.print(host);
  client.print("\r\nContent-Type: application/json\r\nContent-Length: ");
  client.print(strlen(body));
  client.print("\r\nConnection: close\r\n\r\n");
  client.print(body);
  client.flush();
  client.stop();
  LOGI("webhook: job %s reported", jobId ? jobId : "?");
}

/* ------------------------------------------------------------------ SSE pump */

void sseLoop() {
#if ARSIN_SSE_SUPPORTED
  if (millis() - g_sseLastPush < kSseIntervalMs) return;
  g_sseLastPush = millis();

  bool anyClient = false;
  for (size_t i = 0; i < kSseMaxClients; i++) {
    if (g_sseClients[i]) {
      anyClient = true;
      break;
    }
  }
  if (!anyClient) return;

  webStatusJson(g_json, sizeof(g_json));
  static char event[ARSIN_CFG_JSON_MAX + 576];
  snprintf(event, sizeof(event), "data: %s\n\n", g_json);
  char header[16];
  snprintf(header, sizeof(header), "%x\r\n", (unsigned)strlen(event));

  for (size_t i = 0; i < kSseMaxClients; i++) {
    if (!g_sseClients[i]) continue;
    if (!g_sseClients[i].connected()) {
      g_sseClients[i].stop();
      LOGI("sse: client %u gone", (unsigned)i);
      continue;
    }
    g_sseClients[i].print(header);
    g_sseClients[i].print(event);
    g_sseClients[i].print("\r\n");
  }
#endif
}

/* ----------------------------------------------------------------- bootstrap */

void setupRoutes() {
#if ARSIN_RAW_BODY_SUPPORTED
  /* Registered before every other /api/print route: ArsinPrintRawHandler is the
   * only handler that can keep WebServer from buffering a big body, and it
   * falls back to handlePrint() for the jobs it does not claim (see canRaw()).
   * WebServer::addHandler() appends, so it has to come first. */
  g_server.addHandler(new ArsinPrintRawHandler());
#else
  g_server.on("/api/print", HTTP_POST, handlePrint);
#endif
  g_server.on("/api/health", HTTP_GET, handleHealth);
  g_server.on("/api/info", HTTP_GET, handleInfo);
  g_server.on("/api/status", HTTP_GET, handleStatus);
  g_server.on("/api/config", HTTP_GET, handleConfigGet);
  g_server.on("/api/config", HTTP_POST, handleConfigPost);
  g_server.on("/api/command", HTTP_POST, handleCommand);
  g_server.on("/api/raw", HTTP_POST, handleRaw);
  g_server.on("/api/serial", HTTP_GET, handleSerial);
  g_server.on("/api/logs", HTTP_GET, handleLogs);
  g_server.on("/api/wifi", HTTP_GET, handleWifiGet);
  g_server.on("/api/wifi", HTTP_POST, handleWifiJoin);
  g_server.on("/api/wifi/scan", HTTP_POST, handleWifiScan);
  g_server.on("/api/ap", HTTP_POST, handleAp);
  g_server.on("/api/reboot", HTTP_POST, handleReboot);
  g_server.on("/api/factory-reset", HTTP_POST, handleFactoryReset);
  g_server.on("/api/counters/reset", HTTP_POST, handleCountersReset);
  g_server.on("/api/backup", HTTP_GET, handleBackupGet);
  g_server.on("/api/backup", HTTP_POST, handleBackupPost);
  g_server.on("/api/ota", HTTP_POST, handleOtaFinish, handleOtaUpload);
  g_server.on("/events", HTTP_GET, handleEvents);
  g_server.on("/", HTTP_GET, handleStatic);
  g_server.onNotFound(handleNotFound);

  /* Transfer-Encoding decides whether /api/print has to decode a chunked body. */
  static const char* kCollected[] = {"Content-Length", "X-Api-Key", "Accept-Encoding", "Content-Type",
                                     "Transfer-Encoding"};
  g_server.collectHeaders(kCollected, sizeof(kCollected) / sizeof(kCollected[0]));
}

}  // namespace

uint16_t webRawPort() { return g_config.rawPort ? g_config.rawPort : 9100; }

bool webRawClientConnected() {
  for (size_t i = 0; i < 2; i++) {
    if (g_rawClients[i] && g_rawClients[i].connected()) return true;
  }
  return false;
}

void webBegin() {
  setupRoutes();
#if !defined(ARDUINO_ARCH_ESP8266)
  g_server.enableDelay(false);
#endif
  g_server.begin((uint16_t)(g_config.webPort ? g_config.webPort : 80));
  g_rawServer.begin(webRawPort());
  g_rawServer.setNoDelay(true);
  if (g_config.telnetDebug) {
    g_telnetServer.begin(23);
    g_telnetServer.setNoDelay(true);
  }
  LOGI("web: HTTP on %u, raw print server on %u%s", (unsigned)(g_config.webPort ? g_config.webPort : 80),
       (unsigned)webRawPort(), arsinAssetsGenerated() ? "" : " (built-in page, web_assets.h missing)");
}

void webLoop() {
  g_server.handleClient();
  rawServerLoop();
  telnetLoop();
  sseLoop();

  if (g_restartPending && (int32_t)(millis() - g_restartAt) >= 0) {
    LOGI("web: restarting");
    delay(20);
    ESP.restart();
  }
}
