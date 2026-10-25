/*
 * Arsin Print Server - Wi-Fi manager implementation (ESP32 + ESP8266).
 */
#include "arsin_net.h"

#include <Arduino.h>
#include <string.h>
#include <strings.h>

#include "arsin_config.h"
#include "arsin_json.h"
#include "arsin_log.h"
#include "arsin_version.h"

#if defined(ARDUINO_ARCH_ESP8266)
  #include <DNSServer.h>
  #include <ESP8266WiFi.h>
  #include <ESP8266mDNS.h>
#else
  #include <DNSServer.h>
  #include <ESPmDNS.h>
  #include <WiFi.h>
#endif

namespace {

const uint32_t kRetryIntervalMs = 15000;    /* 15 s reconnect retry          */
const uint32_t kStaWatchdogMs = 600000;     /* 10 min without STA -> open AP */
const uint32_t kStaConnectWaitMs = 20000;   /* per-attempt connect window    */

DNSServer g_dns;
bool g_dnsStarted = false;
bool g_mdnsStarted = false;
bool g_apActive = false;
bool g_scanning = false;
uint32_t g_lastAttempt = 0;
uint32_t g_attemptStarted = 0;
uint32_t g_staDownSince = 0;
int8_t g_attemptIndex = -1;   /* index into the saved network list */
bool g_watchdogTripped = false;
char g_mode[8] = "off";

void setMode(const char* mode) {
  strncpy(g_mode, mode, sizeof(g_mode) - 1);
  g_mode[sizeof(g_mode) - 1] = 0;
}

void applyHostname() {
  const char* host = g_config.hostname[0] ? g_config.hostname : ARSIN_MDNS_HOST;
#if defined(ARDUINO_ARCH_ESP8266)
  WiFi.hostname(host);
#else
  WiFi.setHostname(host);
#endif
}

void startAp() {
  if (!g_config.apEnabled) {
    if (g_apActive) {
      WiFi.softAPdisconnect(true);
      g_apActive = false;
    }
    return;
  }
  IPAddress ip, gateway, subnet;
  if (!ip.fromString(g_config.apIp)) ip = IPAddress(192, 168, 4, 1);
  gateway = ip;
  subnet = IPAddress(255, 255, 255, 0);
  WiFi.softAPConfig(ip, gateway, subnet);
  const bool ok = WiFi.softAP(g_config.apSsid, g_config.apPassword[0] ? g_config.apPassword : nullptr);
  g_apActive = ok;
  LOGI("ap: %s at %s (ssid \"%s\")", ok ? "up" : "failed", g_config.apIp, g_config.apSsid);

  if (!g_dnsStarted) {
    g_dns.setErrorReplyCode(DNSReplyCode::NoError);
    g_dnsStarted = g_dns.start(53, "*", ip);
    LOGI("ap: captive portal DNS %s", g_dnsStarted ? "running" : "failed");
  }
}

void stopAp() {
  if (g_dnsStarted) {
    g_dns.stop();
    g_dnsStarted = false;
  }
  if (g_apActive) {
    WiFi.softAPdisconnect(true);
    g_apActive = false;
  }
}

void startStaAttempt() {
  const char* ssid = nullptr;
  const char* password = nullptr;

  if (g_config.savedCount > 0) {
    if (g_attemptIndex < 0) {
      g_attemptIndex = (g_config.lastGoodIndex >= 0) ? g_config.lastGoodIndex : 0;
    } else {
      g_attemptIndex = (int8_t)((g_attemptIndex + 1) % g_config.savedCount);
    }
    ssid = g_config.saved[g_attemptIndex].ssid;
    password = g_config.saved[g_attemptIndex].password;
  } else if (g_config.staSsid[0]) {
    ssid = g_config.staSsid;
    password = g_config.staPassword;
  }

  if (!ssid || !ssid[0]) return;

  if (!g_config.staDhcp) {
    IPAddress ip, gateway, subnet, dns;
    if (ip.fromString(g_config.staIp) && gateway.fromString(g_config.staGateway)) {
      subnet.fromString(g_config.staSubnet[0] ? g_config.staSubnet : "255.255.255.0");
      if (g_config.staDns[0]) dns.fromString(g_config.staDns);
      WiFi.config(ip, gateway, subnet, g_config.staDns[0] ? dns : gateway);
    }
  }

  LOGI("sta: connecting to \"%s\"", ssid);
  WiFi.begin(ssid, password);
  g_attemptStarted = millis();
  g_lastAttempt = millis();
}

void startMdns() {
  if (g_mdnsStarted) return;
  const char* host = g_config.hostname[0] ? g_config.hostname : ARSIN_MDNS_HOST;
#if defined(ARDUINO_ARCH_ESP8266)
  g_mdnsStarted = MDNS.begin(host);
#else
  g_mdnsStarted = MDNS.begin(host);
#endif
  if (!g_mdnsStarted) {
    LOGW("mdns: begin failed for %s", host);
    return;
  }
  MDNS.addService("http", "tcp", g_config.webPort ? g_config.webPort : 80);
  MDNS.addService("pdl-datastream", "tcp", g_config.rawPort ? g_config.rawPort : 9100);
  MDNS.addServiceTxt("http", "tcp", "device", ARSIN_DEVICE_ID);
  MDNS.addServiceTxt("http", "tcp", "app", ARSIN_APP_ID);
  MDNS.addServiceTxt("pdl-datastream", "tcp", "ty", "Arsin Print Server");
  MDNS.setInstanceName(ARSIN_MDNS_HOST);
  LOGI("mdns: %s.local (http %u, pdl-datastream %u)", host, (unsigned)(g_config.webPort ? g_config.webPort : 80),
       (unsigned)(g_config.rawPort ? g_config.rawPort : 9100));
}

}  // namespace

bool netBegin() {
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);

  const bool wantAp = g_config.apEnabled;
  const bool wantSta = g_config.staEnabled && (g_config.savedCount > 0 || g_config.staSsid[0] != 0);

  if (wantAp && wantSta) {
    WiFi.mode(WIFI_AP_STA);
    setMode("ap+sta");
  } else if (wantAp) {
    WiFi.mode(WIFI_AP);
    setMode("ap");
  } else {
    WiFi.mode(WIFI_STA);
    setMode("sta");
  }

  applyHostname();
  if (wantAp) startAp();
  if (wantSta) startStaAttempt();
  g_staDownSince = millis();
  if (g_config.mdns) startMdns();
  LOGI("net: mode %s, hostname %s", g_mode, netHostname());
  return true;
}

void netApplyConfig() {
  applyHostname();
  if (g_config.apEnabled && !g_apActive) {
    WiFi.mode(WIFI_AP_STA);
    startAp();
  } else if (!g_config.apEnabled && g_apActive) {
    stopAp();
  }
  if (g_config.staEnabled) {
    g_attemptIndex = -1;
    startStaAttempt();
  }
  if (g_config.mdns && !g_mdnsStarted) {
    startMdns();
  } else if (!g_config.mdns && g_mdnsStarted) {
    MDNS.end();
    g_mdnsStarted = false;
  }
}

void netReconnect() {
  g_attemptIndex = -1;
  g_watchdogTripped = false;
  g_staDownSince = millis();
  startStaAttempt();
}

void netLoop() {
  if (g_dnsStarted) g_dns.processNextRequest();

  const bool connected = (WiFi.status() == WL_CONNECTED);
  if (connected) {
    g_staDownSince = 0;
    g_watchdogTripped = false;
    if (!g_mdnsStarted && g_config.mdns) startMdns();
#if defined(ARDUINO_ARCH_ESP8266)
    if (g_mdnsStarted) MDNS.update();
#endif
    return;
  }

  if (g_staDownSince == 0) g_staDownSince = millis();

  /* 15 s retry while the STA link is down. */
  if (g_config.staEnabled && (g_config.savedCount > 0 || g_config.staSsid[0]) && g_config.alwaysReconnect) {
    if (millis() - g_lastAttempt > kRetryIntervalMs) {
      startStaAttempt();
    }
  }

  /* 10 minute watchdog: never got a link, so make sure the AP stays reachable. */
  if (!g_watchdogTripped && g_staDownSince && (millis() - g_staDownSince) > kStaWatchdogMs) {
    g_watchdogTripped = true;
    LOGW("sta: no connection for %u s - opening the setup AP", (unsigned)(kStaWatchdogMs / 1000));
    if (!g_apActive) {
      if (WiFi.getMode() == WIFI_STA) WiFi.mode(WIFI_AP_STA);
      startAp();
    }
  }
}

const char* netWifiMode() { return g_mode; }
bool netStaConnected() { return WiFi.status() == WL_CONNECTED; }
bool netApActive() { return g_apActive; }
bool netMdnsActive() { return g_mdnsStarted; }
bool netScanBusy() { return g_scanning; }
const char* netHostname() { return g_config.hostname[0] ? g_config.hostname : ARSIN_MDNS_HOST; }

const char* netStaSsid() {
  static char ssid[33];
  strncpy(ssid, WiFi.SSID().c_str(), sizeof(ssid) - 1);
  ssid[sizeof(ssid) - 1] = 0;
  return ssid;
}

int32_t netRssi() { return netStaConnected() ? (int32_t)WiFi.RSSI() : 0; }

const char* netStaIp() {
  static char ip[16];
  if (netStaConnected()) {
    strncpy(ip, WiFi.localIP().toString().c_str(), sizeof(ip) - 1);
    ip[sizeof(ip) - 1] = 0;
  } else {
    ip[0] = 0;
  }
  return ip;
}

const char* netApIp() {
  static char ip[16];
  strncpy(ip, WiFi.softAPIP().toString().c_str(), sizeof(ip) - 1);
  ip[sizeof(ip) - 1] = 0;
  return ip;
}

const char* netMac() {
  static char mac[20];
  strncpy(mac, WiFi.macAddress().c_str(), sizeof(mac) - 1);
  mac[sizeof(mac) - 1] = 0;
  return mac;
}

bool netJoin(const char* ssid, const char* password, bool save) {
  if (!ssid || !ssid[0]) return false;
  LOGI("sta: join request for \"%s\"", ssid);
  g_watchdogTripped = false;
  g_staDownSince = millis();

  if (WiFi.getMode() == WIFI_AP) WiFi.mode(WIFI_AP_STA);
  WiFi.disconnect(true);
  delay(50);

  strncpy(g_config.staSsid, ssid, sizeof(g_config.staSsid) - 1);
  g_config.staSsid[sizeof(g_config.staSsid) - 1] = 0;
  strncpy(g_config.staPassword, password ? password : "", sizeof(g_config.staPassword) - 1);
  g_config.staPassword[sizeof(g_config.staPassword) - 1] = 0;
  g_config.staEnabled = true;
  if (save) {
    configRememberNetwork(g_config, ssid, password);
    configSave();
  }

  g_attemptIndex = -1;
  startStaAttempt();

  /* Wait up to 20 s in 100 ms slices so printing keeps running meanwhile. */
  const uint32_t started = millis();
  while (millis() - started < kStaConnectWaitMs) {
    if (WiFi.status() == WL_CONNECTED) {
      if (save && g_config.lastGoodIndex >= 0) configSave();
      LOGI("sta: connected to \"%s\" (%s)", ssid, netStaIp());
      return true;
    }
    delay(100);
  }
  LOGW("sta: connection to \"%s\" timed out", ssid);
  return false;
}

bool netConfigureAp(const char* ssid, const char* password, bool enabled) {
  if (ssid && ssid[0]) {
    strncpy(g_config.apSsid, ssid, sizeof(g_config.apSsid) - 1);
    g_config.apSsid[sizeof(g_config.apSsid) - 1] = 0;
  }
  if (password) {
    strncpy(g_config.apPassword, password, sizeof(g_config.apPassword) - 1);
    g_config.apPassword[sizeof(g_config.apPassword) - 1] = 0;
  }
  g_config.apEnabled = enabled;
  configClamp(g_config);
  configSave();

  if (enabled) {
    if (WiFi.getMode() == WIFI_STA) WiFi.mode(WIFI_AP_STA);
    startAp();
  } else {
    stopAp();
    if (!g_config.staEnabled) WiFi.mode(WIFI_OFF);
  }
  return true;
}

size_t netScanJson(char* out, size_t cap) {
  JsonOut json(out, cap);
  json.beginObject();
  json.beginArrayAt("networks");

  g_scanning = true;
  const int found = WiFi.scanNetworks(false, true);
  if (found <= 0) LOGW("wifi: scan returned %d network(s)", found);
  for (int i = 0; i < found; i++) {
    json.beginObject();
    json.kvString("ssid", WiFi.SSID(i).c_str());
    json.kvLong("rssi", (long)WiFi.RSSI(i));
    json.kvBool("secure", WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
    json.kvLong("channel", (long)WiFi.channel(i));
    json.endObject();
  }
  WiFi.scanDelete();
  g_scanning = false;

  json.endArray();
  json.endObject();
  return json.length();
}
