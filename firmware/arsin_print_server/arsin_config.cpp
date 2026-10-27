/*
 * Arsin Print Server - configuration implementation.
 */
#include "arsin_config.h"

#include <Arduino.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "arsin_json.h"
#include "arsin_log.h"
#include "arsin_store.h"
#include "arsin_version.h"

ArsinConfig g_config;

namespace {

void copyStr(char* dst, size_t cap, const char* src) {
  if (!dst || cap == 0) return;
  if (!src) src = "";
  strncpy(dst, src, cap - 1);
  dst[cap - 1] = 0;
}

void trimStr(char* s) {
  if (!s) return;
  size_t len = strlen(s);
  while (len > 0 && (s[len - 1] == ' ' || s[len - 1] == '\t' || s[len - 1] == '\r' || s[len - 1] == '\n')) {
    s[--len] = 0;
  }
}

/**
 * Clamp an integral setting to a range.
 *
 * The config struct mixes uint16_t and uint32_t members, so the parameter has
 * to be a template - binding a uint16_t to a uint32_t& would not compile.
 */
template <typename T>
void clampU32(T& value, uint32_t lo, uint32_t hi) {
  if (value < (T)lo) value = (T)lo;
  if (value > (T)hi) value = (T)hi;
}

bool oneOf(const char* value, const char* const* options, size_t count) {
  if (!value) return false;
  for (size_t i = 0; i < count; i++) {
    if (!strcasecmp(value, options[i])) return true;
  }
  return false;
}

}  // namespace

void configDefaults(ArsinConfig& cfg) {
  memset(&cfg, 0, sizeof(cfg));
  copyStr(cfg.deviceName, sizeof(cfg.deviceName), "arsin-print-01");
  copyStr(cfg.owner, sizeof(cfg.owner), "");
  copyStr(cfg.location, sizeof(cfg.location), "");
  copyStr(cfg.notes, sizeof(cfg.notes), "");

  cfg.apEnabled = true;
  copyStr(cfg.apSsid, sizeof(cfg.apSsid), "arsin_print_server");
  copyStr(cfg.apPassword, sizeof(cfg.apPassword), "arsin1234");
  copyStr(cfg.apIp, sizeof(cfg.apIp), "192.168.4.1");

  cfg.staEnabled = true;
  copyStr(cfg.staSsid, sizeof(cfg.staSsid), "");
  copyStr(cfg.staPassword, sizeof(cfg.staPassword), "");
  cfg.staDhcp = true;
  copyStr(cfg.staIp, sizeof(cfg.staIp), "");
  copyStr(cfg.staGateway, sizeof(cfg.staGateway), "");
  copyStr(cfg.staSubnet, sizeof(cfg.staSubnet), "");
  copyStr(cfg.staDns, sizeof(cfg.staDns), "");
  copyStr(cfg.hostname, sizeof(cfg.hostname), ARSIN_MDNS_HOST);
  cfg.alwaysReconnect = true;
  cfg.savedCount = 0;
  cfg.lastGoodIndex = -1;

  copyStr(cfg.printerName, sizeof(cfg.printerName), "Generic ESC/POS");
  copyStr(cfg.printerModel, sizeof(cfg.printerModel), "");
  copyStr(cfg.language, sizeof(cfg.language), "escpos");
  copyStr(cfg.profile, sizeof(cfg.profile), "receipt");
  copyStr(cfg.transport, sizeof(cfg.transport), "uart");
  cfg.baud = 115200;
  cfg.dataBits = 8;
  copyStr(cfg.parity, sizeof(cfg.parity), "none");
  cfg.stopBits = 1;
  cfg.widthMm = 80;
  cfg.dpi = 203;
  cfg.cut = true;
  copyStr(cfg.charset, sizeof(cfg.charset), "cp437");
  cfg.darkness = 8;
  cfg.speed = 4;
  copyStr(cfg.mediaType, sizeof(cfg.mediaType), "gap");
  cfg.strobeDelayUs = 3;

  cfg.btEnabled = false;
  copyStr(cfg.btName, sizeof(cfg.btName), "arsin_print_server");
  copyStr(cfg.btPin, sizeof(cfg.btPin), "0000");
  cfg.ble = false;

  cfg.usbHostEnabled = false;
  cfg.usbAutoDetect = true;
  cfg.usbMaxPowerMa = 500;

  cfg.rawPort = 9100;
  cfg.webPort = 80;
  cfg.mdns = true;
  cfg.telnetDebug = false;
  cfg.keepAlive = true;

  copyStr(cfg.webPassword, sizeof(cfg.webPassword), "");
  copyStr(cfg.apiKey, sizeof(cfg.apiKey), "");
  cfg.allowCors = true;

  copyStr(cfg.logLevel, sizeof(cfg.logLevel), "info");
  cfg.logBufferLines = 120;

  copyStr(cfg.webhookUrl, sizeof(cfg.webhookUrl), "");
  cfg.webhookOnJob = false;
  copyStr(cfg.ntpServer, sizeof(cfg.ntpServer), "pool.ntp.org");
  copyStr(cfg.timezone, sizeof(cfg.timezone), "UTC");
}

const char* configValidateBaud(uint32_t baud) {
  static const uint32_t allowed[] = {4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 921600};
  for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
    if (allowed[i] == baud) return "ok";
  }
  return "unsupported";
}

bool configValidateParity(const char* parity) {
  static const char* const allowed[] = {"none", "even", "odd", "mark", "space"};
  return oneOf(parity, allowed, sizeof(allowed) / sizeof(allowed[0]));
}

bool configValidateStopBits(uint8_t bits) { return bits == 1 || bits == 2 || bits == 15; }

void configClamp(ArsinConfig& cfg) {
  trimStr(cfg.deviceName);
  if (cfg.deviceName[0] == 0) copyStr(cfg.deviceName, sizeof(cfg.deviceName), "arsin-print-01");
  trimStr(cfg.hostname);
  if (cfg.hostname[0] == 0) copyStr(cfg.hostname, sizeof(cfg.hostname), ARSIN_MDNS_HOST);

  /* AP: keep the SSID usable and the password WPA2 valid (>= 8 chars). */
  if (strlen(cfg.apSsid) < 3) copyStr(cfg.apSsid, sizeof(cfg.apSsid), "arsin_print_server");
  const size_t apPassLen = strlen(cfg.apPassword);
  if (apPassLen > 0 && apPassLen < 8) copyStr(cfg.apPassword, sizeof(cfg.apPassword), "arsin1234");
  if (apPassLen > 63) cfg.apPassword[63] = 0;
  if (cfg.apIp[0] == 0) copyStr(cfg.apIp, sizeof(cfg.apIp), "192.168.4.1");

  if (strlen(cfg.staPassword) > 63) cfg.staPassword[63] = 0;

  if (cfg.savedCount > ARSIN_MAX_SAVED_NETWORKS) cfg.savedCount = ARSIN_MAX_SAVED_NETWORKS;
  for (uint8_t i = 0; i < cfg.savedCount; i++) {
    trimStr(cfg.saved[i].ssid);
    if (cfg.saved[i].ssid[0] == 0) {
      for (uint8_t k = i; k + 1 < cfg.savedCount; k++) cfg.saved[k] = cfg.saved[k + 1];
      cfg.savedCount--;
      memset(&cfg.saved[cfg.savedCount], 0, sizeof(ArsinSavedNetwork));
      if (i > 0) i--;
    }
  }
  if (cfg.lastGoodIndex >= (int8_t)cfg.savedCount) cfg.lastGoodIndex = -1;

  static const char* const langs[] = {"escpos", "zpl", "tspl", "epl", "cpcl", "starprnt", "escp", "ipl", "dpl", "plain"};
  if (!oneOf(cfg.language, langs, sizeof(langs) / sizeof(langs[0]))) {
    copyStr(cfg.language, sizeof(cfg.language), "escpos");
  }
  static const char* const transports[] = {"uart", "usbhost", "bt", "ble", "network"};
  if (!oneOf(cfg.transport, transports, sizeof(transports) / sizeof(transports[0]))) {
    copyStr(cfg.transport, sizeof(cfg.transport), "uart");
  }
  static const char* const media[] = {"gap", "blackmark", "continuous"};
  if (!oneOf(cfg.mediaType, media, sizeof(media) / sizeof(media[0]))) {
    copyStr(cfg.mediaType, sizeof(cfg.mediaType), "gap");
  }

  if (strcmp(configValidateBaud(cfg.baud), "ok") != 0) cfg.baud = 115200;
  if (cfg.dataBits < 5 || cfg.dataBits > 8) cfg.dataBits = 8;
  if (!configValidateParity(cfg.parity)) copyStr(cfg.parity, sizeof(cfg.parity), "none");
  if (!configValidateStopBits(cfg.stopBits)) cfg.stopBits = 1;

  clampU32(cfg.widthMm, 40, 220);
  clampU32(cfg.dpi, 180, 600);
  if (cfg.darkness > 15) cfg.darkness = 8;
  if (cfg.speed < 1 || cfg.speed > 14) cfg.speed = 4;
  clampU32(cfg.strobeDelayUs, 1, 1000);
  clampU32(cfg.usbMaxPowerMa, 100, 1500);

  if (cfg.rawPort < 1) cfg.rawPort = 9100;
  if (cfg.webPort < 1) cfg.webPort = 80;

  static const char* const levels[] = {"debug", "info", "warn", "error"};
  if (!oneOf(cfg.logLevel, levels, sizeof(levels) / sizeof(levels[0]))) {
    copyStr(cfg.logLevel, sizeof(cfg.logLevel), "info");
  }
  if (cfg.logBufferLines < 10) cfg.logBufferLines = 10;
  if (cfg.logBufferLines > ARSIN_LOG_MAX) cfg.logBufferLines = ARSIN_LOG_MAX;

  if (strlen(cfg.btPin) > 0 && strlen(cfg.btPin) < 4) copyStr(cfg.btPin, sizeof(cfg.btPin), "0000");
  if (strlen(cfg.btPin) > 16) cfg.btPin[16] = 0;
  if (cfg.btName[0] == 0) copyStr(cfg.btName, sizeof(cfg.btName), "arsin_print_server");
}

int configRememberNetwork(ArsinConfig& cfg, const char* ssid, const char* password) {
  if (!ssid || ssid[0] == 0) return -1;
  int found = -1;
  for (uint8_t i = 0; i < cfg.savedCount; i++) {
    if (!strcmp(cfg.saved[i].ssid, ssid)) {
      found = (int)i;
      break;
    }
  }
  if (found < 0) {
    if (cfg.savedCount >= ARSIN_MAX_SAVED_NETWORKS) {
      /* Oldest entry (index 0) makes room. */
      for (uint8_t k = 0; k + 1 < cfg.savedCount; k++) cfg.saved[k] = cfg.saved[k + 1];
      found = cfg.savedCount - 1;
    } else {
      found = cfg.savedCount++;
    }
  }
  copyStr(cfg.saved[found].ssid, sizeof(cfg.saved[found].ssid), ssid);
  copyStr(cfg.saved[found].password, sizeof(cfg.saved[found].password), password ? password : "");
  cfg.lastGoodIndex = (int8_t)found;
  return found;
}

size_t configToJson(const ArsinConfig& cfg, char* out, size_t cap) {
  JsonOut json(out, cap);
  json.beginObject();

  json.beginObjectAt("device");
  json.kvString("name", cfg.deviceName);
  json.kvString("owner", cfg.owner);
  json.kvString("location", cfg.location);
  json.kvString("notes", cfg.notes);
  json.endObject();

  json.beginObjectAt("ap");
  json.kvBool("enabled", cfg.apEnabled);
  json.kvString("ssid", cfg.apSsid);
  json.kvString("password", cfg.apPassword);
  json.kvString("ip", cfg.apIp);
  json.endObject();

  json.beginObjectAt("sta");
  json.kvBool("enabled", cfg.staEnabled);
  json.kvString("ssid", cfg.staSsid);
  json.kvString("password", cfg.staPassword);
  json.kvBool("dhcp", cfg.staDhcp);
  json.kvString("ip", cfg.staIp);
  json.kvString("gateway", cfg.staGateway);
  json.kvString("subnet", cfg.staSubnet);
  json.kvString("dns", cfg.staDns);
  json.kvString("hostname", cfg.hostname);
  json.kvBool("alwaysReconnect", cfg.alwaysReconnect);
  json.beginArrayAt("saved");
  for (uint8_t i = 0; i < cfg.savedCount; i++) {
    json.beginObject();
    json.kvString("ssid", cfg.saved[i].ssid);
    json.kvString("password", cfg.saved[i].password);
    json.endObject();
  }
  json.endArray();
  json.endObject();

  json.beginObjectAt("printer");
  json.kvString("name", cfg.printerName);
  json.kvString("model", cfg.printerModel);
  json.kvString("language", cfg.language);
  json.kvString("profile", cfg.profile);
  json.kvString("transport", cfg.transport);
  json.kvULong("baud", cfg.baud);
  json.kvULong("dataBits", cfg.dataBits);
  json.kvString("parity", cfg.parity);
  json.kvULong("stopBits", cfg.stopBits);
  json.kvULong("widthMm", cfg.widthMm);
  json.kvULong("dpi", cfg.dpi);
  json.kvBool("cut", cfg.cut);
  json.kvString("charset", cfg.charset);
  json.kvULong("darkness", cfg.darkness);
  json.kvULong("speed", cfg.speed);
  json.kvString("mediaType", cfg.mediaType);
  json.kvULong("strobeDelayUs", cfg.strobeDelayUs);
  json.endObject();

  json.beginObjectAt("bt");
  json.kvBool("enabled", cfg.btEnabled);
  json.kvString("name", cfg.btName);
  json.kvString("pin", cfg.btPin);
  json.kvBool("ble", cfg.ble);
  json.endObject();

  json.beginObjectAt("usbHost");
  json.kvBool("enabled", cfg.usbHostEnabled);
  json.kvBool("autoDetect", cfg.usbAutoDetect);
  json.kvULong("maxPowerMa", cfg.usbMaxPowerMa);
  json.endObject();

  json.beginObjectAt("network");
  json.kvULong("rawPort", cfg.rawPort);
  json.kvULong("webPort", cfg.webPort);
  json.kvBool("mdns", cfg.mdns);
  json.kvBool("telnetDebug", cfg.telnetDebug);
  json.kvBool("keepAlive", cfg.keepAlive);
  json.endObject();

  json.beginObjectAt("security");
  json.kvString("webPassword", cfg.webPassword);
  json.kvString("apiKey", cfg.apiKey);
  json.kvBool("allowCors", cfg.allowCors);
  json.endObject();

  json.beginObjectAt("logging");
  json.kvString("level", cfg.logLevel);
  json.kvULong("bufferLines", cfg.logBufferLines);
  json.endObject();

  json.beginObjectAt("cloud");
  json.kvString("webhookUrl", cfg.webhookUrl);
  json.kvBool("onJob", cfg.webhookOnJob);
  json.kvString("ntpServer", cfg.ntpServer);
  json.kvString("timezone", cfg.timezone);
  json.endObject();

  json.endObject();
  return json.length();
}

void configCriticalFingerprint(const ArsinConfig& cfg, char* out, size_t cap) {
  if (!out || cap == 0) return;
  snprintf(out, cap, "%d|%s|%s|%s|%d|%d|%s|%u|%u|%s|%s|%s|%u|%u|%s|%u|%s|%d|%s|%s|%d|%d|%d|%u|%s",
           (int)cfg.apEnabled, cfg.apSsid, cfg.apPassword, cfg.apIp,
           (int)cfg.staEnabled, (int)cfg.staDhcp, cfg.hostname,
           (unsigned)cfg.baud, (unsigned)cfg.dataBits, cfg.parity, cfg.transport,
           cfg.staSubnet, (unsigned)cfg.webPort, (unsigned)cfg.rawPort, cfg.staIp,
           (unsigned)cfg.staDns, cfg.staGateway, (int)cfg.stopBits,
           cfg.logLevel, cfg.deviceName, (int)cfg.btEnabled, (int)cfg.ble,
           (int)cfg.usbHostEnabled, (unsigned)cfg.mdns, cfg.btName);
}

/* --------------------------------------------------------------- JSON apply */

namespace {

class ConfigSink : public JsonSink {
 public:
  explicit ConfigSink(ArsinConfig& cfg) : _cfg(cfg) {}

  void onString(const char* path, const char* value) override {
    if (is(path, "device.name")) copyStr(_cfg.deviceName, sizeof(_cfg.deviceName), value);
    else if (is(path, "device.owner")) copyStr(_cfg.owner, sizeof(_cfg.owner), value);
    else if (is(path, "device.location")) copyStr(_cfg.location, sizeof(_cfg.location), value);
    else if (is(path, "device.notes")) copyStr(_cfg.notes, sizeof(_cfg.notes), value);
    else if (is(path, "ap.ssid")) copyStr(_cfg.apSsid, sizeof(_cfg.apSsid), value);
    else if (is(path, "ap.password")) copyStr(_cfg.apPassword, sizeof(_cfg.apPassword), value);
    else if (is(path, "ap.ip")) copyStr(_cfg.apIp, sizeof(_cfg.apIp), value);
    else if (is(path, "sta.ssid")) copyStr(_cfg.staSsid, sizeof(_cfg.staSsid), value);
    else if (is(path, "sta.password")) copyStr(_cfg.staPassword, sizeof(_cfg.staPassword), value);
    else if (is(path, "sta.ip")) copyStr(_cfg.staIp, sizeof(_cfg.staIp), value);
    else if (is(path, "sta.gateway")) copyStr(_cfg.staGateway, sizeof(_cfg.staGateway), value);
    else if (is(path, "sta.subnet")) copyStr(_cfg.staSubnet, sizeof(_cfg.staSubnet), value);
    else if (is(path, "sta.dns")) copyStr(_cfg.staDns, sizeof(_cfg.staDns), value);
    else if (is(path, "sta.hostname")) copyStr(_cfg.hostname, sizeof(_cfg.hostname), value);
    else if (is(path, "printer.name")) copyStr(_cfg.printerName, sizeof(_cfg.printerName), value);
    else if (is(path, "printer.model")) copyStr(_cfg.printerModel, sizeof(_cfg.printerModel), value);
    else if (is(path, "printer.language")) copyStr(_cfg.language, sizeof(_cfg.language), value);
    else if (is(path, "printer.profile")) copyStr(_cfg.profile, sizeof(_cfg.profile), value);
    else if (is(path, "printer.transport")) copyStr(_cfg.transport, sizeof(_cfg.transport), value);
    else if (is(path, "printer.parity")) copyStr(_cfg.parity, sizeof(_cfg.parity), value);
    else if (is(path, "printer.charset")) copyStr(_cfg.charset, sizeof(_cfg.charset), value);
    else if (is(path, "printer.mediaType")) copyStr(_cfg.mediaType, sizeof(_cfg.mediaType), value);
    else if (is(path, "bt.name")) copyStr(_cfg.btName, sizeof(_cfg.btName), value);
    else if (is(path, "bt.pin")) copyStr(_cfg.btPin, sizeof(_cfg.btPin), value);
    else if (is(path, "security.webPassword")) copyStr(_cfg.webPassword, sizeof(_cfg.webPassword), value);
    else if (is(path, "security.apiKey")) copyStr(_cfg.apiKey, sizeof(_cfg.apiKey), value);
    else if (is(path, "logging.level")) copyStr(_cfg.logLevel, sizeof(_cfg.logLevel), value);
    else if (is(path, "cloud.webhookUrl")) copyStr(_cfg.webhookUrl, sizeof(_cfg.webhookUrl), value);
    else if (is(path, "cloud.ntpServer")) copyStr(_cfg.ntpServer, sizeof(_cfg.ntpServer), value);
    else if (is(path, "cloud.timezone")) copyStr(_cfg.timezone, sizeof(_cfg.timezone), value);
    else if (isSaved(path, "ssid")) savedSsid(value);
    else if (isSaved(path, "password")) savedPassword(value);
  }

  void onNumber(const char* path, double value) override {
    const long v = (long)(value + (value < 0 ? -0.5 : 0.5));
    if (is(path, "printer.baud")) _cfg.baud = (uint32_t)v;
    else if (is(path, "printer.dataBits")) _cfg.dataBits = (uint8_t)v;
    else if (is(path, "printer.stopBits")) _cfg.stopBits = (uint8_t)v;
    else if (is(path, "printer.widthMm")) _cfg.widthMm = (uint16_t)v;
    else if (is(path, "printer.dpi")) _cfg.dpi = (uint16_t)v;
    else if (is(path, "printer.darkness")) _cfg.darkness = (uint8_t)v;
    else if (is(path, "printer.speed")) _cfg.speed = (uint8_t)v;
    else if (is(path, "printer.strobeDelayUs")) _cfg.strobeDelayUs = (uint16_t)v;
    else if (is(path, "usbHost.maxPowerMa")) _cfg.usbMaxPowerMa = (uint16_t)v;
    else if (is(path, "network.rawPort")) _cfg.rawPort = (uint16_t)v;
    else if (is(path, "network.webPort")) _cfg.webPort = (uint16_t)v;
    else if (is(path, "logging.bufferLines")) _cfg.logBufferLines = (uint16_t)v;
  }

  void onBool(const char* path, bool value) override {
    if (is(path, "ap.enabled")) _cfg.apEnabled = value;
    else if (is(path, "sta.enabled")) _cfg.staEnabled = value;
    else if (is(path, "sta.dhcp")) _cfg.staDhcp = value;
    else if (is(path, "sta.alwaysReconnect")) _cfg.alwaysReconnect = value;
    else if (is(path, "printer.cut")) _cfg.cut = value;
    else if (is(path, "bt.enabled")) _cfg.btEnabled = value;
    else if (is(path, "bt.ble")) _cfg.ble = value;
    else if (is(path, "usbHost.enabled")) _cfg.usbHostEnabled = value;
    else if (is(path, "usbHost.autoDetect")) _cfg.usbAutoDetect = value;
    else if (is(path, "network.mdns")) _cfg.mdns = value;
    else if (is(path, "network.telnetDebug")) _cfg.telnetDebug = value;
    else if (is(path, "network.keepAlive")) _cfg.keepAlive = value;
    else if (is(path, "security.allowCors")) _cfg.allowCors = value;
    else if (is(path, "cloud.onJob")) _cfg.webhookOnJob = value;
  }

  void onArrayStart(const char* path) override {
    if (is(path, "sta.saved")) {
      _savedIndex = 0;
      _inSaved = true;
    }
  }

  void onArrayEnd(const char* path) override {
    if (is(path, "sta.saved")) {
      _inSaved = false;
      if (_savedIndex > ARSIN_MAX_SAVED_NETWORKS) _savedIndex = ARSIN_MAX_SAVED_NETWORKS;
      _cfg.savedCount = (uint8_t)_savedIndex;
      for (int i = _savedIndex; i < ARSIN_MAX_SAVED_NETWORKS; i++) {
        memset(&_cfg.saved[i], 0, sizeof(ArsinSavedNetwork));
      }
    }
  }

 private:
  static bool is(const char* path, const char* wanted) { return path && !strcmp(path, wanted); }

  bool isSaved(const char* path, const char* leaf) {
    if (!path || !_inSaved) return false;
    char want[48];
    snprintf(want, sizeof(want), "sta.saved[%d].%s", _savedIndex, leaf);
    return !strcmp(path, want);
  }

  void savedSsid(const char* value) {
    if (_savedIndex >= ARSIN_MAX_SAVED_NETWORKS) return;
    copyStr(_cfg.saved[_savedIndex].ssid, sizeof(_cfg.saved[_savedIndex].ssid), value);
    _savedIndex++;
  }

  void savedPassword(const char* value) {
    const int index = (_savedIndex > 0) ? (_savedIndex - 1) : 0;
    if (index >= ARSIN_MAX_SAVED_NETWORKS) return;
    copyStr(_cfg.saved[index].password, sizeof(_cfg.saved[index].password), value);
  }

  ArsinConfig& _cfg;
  bool _inSaved = false;
  int _savedIndex = 0;
};

}  // namespace

bool configApplyJson(const char* json, size_t len, char* err, size_t errCap) {
  ConfigSink sink(g_config);
  if (!arsinJsonParse(json, len, sink, err, errCap)) return false;
  configClamp(g_config);
  return true;
}

/* ------------------------------------------------------------- persistence */

bool configLoad() {
  configDefaults(g_config);
  char buf[ARSIN_STORE_TEXT_MAX];
  if (!storeLoadText(buf, sizeof(buf))) {
    LOGI("config: no stored configuration, using defaults");
    return false;
  }
  char err[64];
  if (!configApplyJson(buf, strlen(buf), err, sizeof(err))) {
    LOGW("config: stored document rejected (%s), using defaults", err);
    configDefaults(g_config);
    return false;
  }
  LOGI("config: loaded %u bytes from flash", (unsigned)strlen(buf));
  return true;
}

bool configSave() {
  configClamp(g_config);
  char buf[ARSIN_CFG_JSON_MAX];
  const size_t len = configToJson(g_config, buf, sizeof(buf));
  if (len == 0) {
    LOGE("config: serialisation failed");
    return false;
  }
  if (!storeSaveText(buf)) {
    LOGE("config: unable to persist configuration");
    return false;
  }
  LOGI("config: saved %u bytes", (unsigned)len);
  return true;
}

void configWipe() { storeWipe(); }
