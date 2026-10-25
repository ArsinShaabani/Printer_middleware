/*
 * Arsin Print Server - Wi-Fi / network manager.
 *
 * AP+STA with a captive portal on the soft-AP, mDNS advertisement, a 15 s
 * reconnect retry and a 10 minute STA watchdog that re-opens the AP when the
 * configured network never comes up (so a phone can always reach the wizard).
 */
#ifndef ARSIN_NET_H
#define ARSIN_NET_H

#include <stddef.h>
#include <stdint.h>

bool netBegin();
void netLoop();
/** Apply the network section of the config (reconnect / re-open the AP). */
void netApplyConfig();

/** "ap+sta" | "ap" | "sta" | "off" */
const char* netWifiMode();
bool netStaConnected();
bool netApActive();
const char* netStaSsid();
int32_t netRssi();
const char* netStaIp();
const char* netApIp();
const char* netHostname();
const char* netMac();
bool netMdnsActive();

/** Join a network; persists it (up to 5) when `save` is true. */
bool netJoin(const char* ssid, const char* password, bool save);
/** Configure and (re)start the soft-AP. */
bool netConfigureAp(const char* ssid, const char* password, bool enabled);
/** Reconnect to the last known good network. */
void netReconnect();

/** Fill `out` with {"networks":[{"ssid":..,"rssi":N,"secure":bool}]}. */
size_t netScanJson(char* out, size_t cap);

/** True while a Wi-Fi scan is running. */
bool netScanBusy();

#endif /* ARSIN_NET_H */
