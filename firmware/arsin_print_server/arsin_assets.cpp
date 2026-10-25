/*
 * Arsin Print Server - asset table + lookup.
 */
#include "arsin_assets.h"

#include <stdio.h>
#include <string.h>

#if !ARSIN_HAS_GENERATED_ASSETS
/* Fallback table: the built-in single page, served for every unknown path. */
const WebAsset WEB_ASSETS[] = {
    {"/", "text/html; charset=utf-8", (const uint8_t*)ARSIN_BUILTIN_INDEX, (unsigned int)(sizeof(ARSIN_BUILTIN_INDEX) - 1), false},
};
const unsigned int WEB_ASSETS_COUNT = sizeof(WEB_ASSETS) / sizeof(WEB_ASSETS[0]);
#endif

bool arsinAssetsGenerated() { return ARSIN_HAS_GENERATED_ASSETS != 0; }

const WebAsset* arsinAssetIndex() {
  const WebAsset* byIndex = arsinAssetFind("/index.html");
  if (byIndex) return byIndex;
  return arsinAssetFind("/");
}

const WebAsset* arsinAssetFind(const char* path) {
  if (!path) return nullptr;
  if (path[0] == 0 || !strcmp(path, "/")) {
    path = "/index.html";
  }
  /* strip a query string, the web app never needs it for static files */
  char clean[96];
  size_t i = 0;
  while (path[i] && path[i] != '?' && i < sizeof(clean) - 1) {
    clean[i] = path[i];
    i++;
  }
  clean[i] = 0;

  for (unsigned int a = 0; a < WEB_ASSETS_COUNT; a++) {
    if (!strcmp(WEB_ASSETS[a].path, clean)) return &WEB_ASSETS[a];
  }
  /* allow "/app" style requests to resolve to "/app.html" or "/app/index.html" */
  char alt[112];
  snprintf(alt, sizeof(alt), "%s.html", clean);
  for (unsigned int a = 0; a < WEB_ASSETS_COUNT; a++) {
    if (!strcmp(WEB_ASSETS[a].path, alt)) return &WEB_ASSETS[a];
  }
  snprintf(alt, sizeof(alt), "%s/index.html", clean);
  for (unsigned int a = 0; a < WEB_ASSETS_COUNT; a++) {
    if (!strcmp(WEB_ASSETS[a].path, alt)) return &WEB_ASSETS[a];
  }
  return nullptr;
}
