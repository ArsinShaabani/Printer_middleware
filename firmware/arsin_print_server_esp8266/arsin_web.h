/*
 * Arsin Print Server - HTTP/REST layer.
 *
 * Implements the shared contract used by the web application (see
 * firmware/README.md): /api/health, /api/info, /api/status, /api/config,
 * /api/print, /api/command, /api/raw, /api/serial, /api/logs, /api/wifi*,
 * /api/ap, /api/reboot, /api/factory-reset, /api/ota, /api/backup,
 * /api/counters/reset, /events (SSE) plus the static web app and the raw
 * port-9100 print server.
 */
#ifndef ARSIN_WEB_H
#define ARSIN_WEB_H

#include <stddef.h>
#include <stdint.h>

void webBegin();
void webLoop();

/** The exact documents served by /api/status and /api/info (also used by SSE). */
size_t webStatusJson(char* out, size_t cap);
size_t webInfoJson(char* out, size_t cap);

/** Server-sent events are only available on arduino-esp32 core 3.x. */
bool webSseSupported();
const char* webSseNote();
bool webSseClients();

/** Raw TCP print server state (port network.rawPort). */
uint16_t webRawPort();
bool webRawClientConnected();

#endif /* ARSIN_WEB_H */
