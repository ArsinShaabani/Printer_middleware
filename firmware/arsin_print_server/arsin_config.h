/*
 * Arsin Print Server - configuration model.
 *
 * The struct mirrors the JSON schema shared with the web app
 * (see firmware/README.md).  All values are fixed size char arrays / integers
 * so the configuration never fragments the heap, and every value is clamped in
 * configClamp() before it reaches a driver.
 */
#ifndef ARSIN_CONFIG_H
#define ARSIN_CONFIG_H

#include <stddef.h>
#include <stdint.h>

#define ARSIN_MAX_SAVED_NETWORKS 5
#define ARSIN_CFG_JSON_MAX 2600

struct ArsinSavedNetwork {
  char ssid[33];
  char password[65];
};

struct ArsinConfig {
  /* device */
  char deviceName[33];
  char owner[33];
  char location[33];
  char notes[121];

  /* ap */
  bool apEnabled;
  char apSsid[33];
  char apPassword[65];
  char apIp[16];

  /* sta */
  bool staEnabled;
  char staSsid[33];
  char staPassword[65];
  bool staDhcp;
  char staIp[16];
  char staGateway[16];
  char staSubnet[16];
  char staDns[16];
  char hostname[33];
  bool alwaysReconnect;
  ArsinSavedNetwork saved[ARSIN_MAX_SAVED_NETWORKS];
  uint8_t savedCount;
  int8_t lastGoodIndex; /* -1 when unknown */

  /* printer */
  char printerName[33];
  char printerModel[33];
  char language[16];
  char profile[16];
  char transport[12];
  uint32_t baud;
  uint8_t dataBits;
  char parity[8];
  uint8_t stopBits;
  uint16_t widthMm;
  uint16_t dpi;
  bool cut;
  char charset[12];
  uint8_t darkness;
  uint8_t speed;
  char mediaType[16];
  uint16_t strobeDelayUs;

  /* bt */
  bool btEnabled;
  char btName[33];
  char btPin[8];
  bool ble;

  /* usbHost */
  bool usbHostEnabled;
  bool usbAutoDetect;
  uint16_t usbMaxPowerMa;

  /* network */
  uint16_t rawPort;
  uint16_t webPort;
  bool mdns;
  bool telnetDebug;
  bool keepAlive;

  /* security */
  char webPassword[33];
  char apiKey[65];
  bool allowCors;

  /* logging */
  char logLevel[8];
  uint16_t logBufferLines;

  /* cloud */
  char webhookUrl[161];
  bool webhookOnJob;
  char ntpServer[65];
  char timezone[33];
};

extern ArsinConfig g_config;

void configDefaults(ArsinConfig& cfg);
/** Bounds check every field (SSID length, baud whitelist, ports, ...). */
void configClamp(ArsinConfig& cfg);
/** Apply the defaults, load the persisted JSON, clamp.  Always succeeds. */
bool configLoad();
bool configSave();
void configWipe();
/** Serialise into `out` (schema order identical to the web app). */
size_t configToJson(const ArsinConfig& cfg, char* out, size_t cap);
/** Merge a partial JSON document into the live config.  Returns false when the
 *  document is malformed. */
bool configApplyJson(const char* json, size_t len, char* err, size_t errCap);
/** Compact fingerprint of the fields that need a reboot to take effect. */
void configCriticalFingerprint(const ArsinConfig& cfg, char* out, size_t cap);
/** Add/replace a Wi-Fi network in the saved list, newest last. */
int configRememberNetwork(ArsinConfig& cfg, const char* ssid, const char* password);
/** Restore factory defaults (used by /api/factory-reset). */
void configFactoryReset(ArsinConfig& cfg);

const char* configValidateBaud(uint32_t baud);
bool configValidateParity(const char* parity);
bool configValidateStopBits(uint8_t bits);

#endif /* ARSIN_CONFIG_H */
