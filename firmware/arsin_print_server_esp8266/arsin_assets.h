/*
 * Arsin Print Server - static web assets.
 *
 * The browser installer / build pipeline generates "web_assets.h" into the
 * sketch folder (see firmware/README.md, npm run build:web-assets).  When that
 * header is missing - a plain arduino-cli build of this repository - a small
 * built-in page is served instead so the device is never unreachable.
 */
#ifndef ARSIN_ASSETS_H
#define ARSIN_ASSETS_H

#include <stddef.h>
#include <stdint.h>

#if __has_include("web_assets.h")
  #include "web_assets.h"
  #define ARSIN_HAS_GENERATED_ASSETS 1
#else
  #include "web_assets_builtin.h"
  #define ARSIN_HAS_GENERATED_ASSETS 0
#endif

/** Find an asset by request path ("" and "/" resolve to the index page). */
const WebAsset* arsinAssetFind(const char* path);
/** The index document, always available. */
const WebAsset* arsinAssetIndex();
bool arsinAssetsGenerated();

#endif /* ARSIN_ASSETS_H */
