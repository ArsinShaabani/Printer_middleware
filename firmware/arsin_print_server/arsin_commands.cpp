/*
 * Arsin Print Server - maintenance command builder implementation.
 */
#include "arsin_commands.h"

#include <stdio.h>
#include <string.h>

#include "arsin_config.h"
#include "arsin_json.h"
#include "arsin_log.h"

namespace {

const uint8_t ESC = 0x1B;
const uint8_t GS = 0x1D;
const uint8_t DLE = 0x10;

/* ------------------------------------------------------------- parameters */

struct Params {
  int lines = 3;
  int copies = 1;
  int darkness = 8;
  int speed = 4;
  int height = 60;
  int width = 2;
  char media[16] = "gap";
  char cutter[16] = "full";
  char pattern[16] = "standard";
  char data[64] = "ARSIN-PS";
  char symbology[16] = "code128";
};

class ParamSink : public JsonSink {
 public:
  explicit ParamSink(Params& p) : _p(p) {}

  void onString(const char* path, const char* value) override {
    if (!path) return;
    if (!strcmp(path, "media")) copy(value, _p.media, sizeof(_p.media));
    else if (!strcmp(path, "cutter")) copy(value, _p.cutter, sizeof(_p.cutter));
    else if (!strcmp(path, "pattern")) copy(value, _p.pattern, sizeof(_p.pattern));
    else if (!strcmp(path, "data") || !strcmp(path, "text")) copy(value, _p.data, sizeof(_p.data));
    else if (!strcmp(path, "symbology")) copy(value, _p.symbology, sizeof(_p.symbology));
  }

  void onNumber(const char* path, double value) override {
    if (!path) return;
    const int v = (int)(value + (value < 0 ? -0.5 : 0.5));
    if (!strcmp(path, "lines") || !strcmp(path, "dots")) _p.lines = v;
    else if (!strcmp(path, "copies")) _p.copies = v;
    else if (!strcmp(path, "darkness") || !strcmp(path, "density")) _p.darkness = v;
    else if (!strcmp(path, "speed")) _p.speed = v;
    else if (!strcmp(path, "height")) _p.height = v;
    else if (!strcmp(path, "width")) _p.width = v;
  }

 private:
  static void copy(const char* src, char* dst, size_t cap) {
    strncpy(dst, src ? src : "", cap - 1);
    dst[cap - 1] = 0;
  }
  Params& _p;
};

int clampInt(int value, int lo, int hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/* ---------------------------------------------------------------- builder */

class CmdBuilder {
 public:
  CmdBuilder(uint8_t* buf, size_t cap) : _buf(buf), _cap(cap), _len(0), _full(false) {}

  void add(uint8_t b) {
    if (_len < _cap) {
      _buf[_len++] = b;
    } else {
      _full = true;
    }
  }

  void add(const uint8_t* data, size_t n) {
    for (size_t i = 0; i < n; i++) add(data[i]);
  }

  void add(const char* text) {
    if (!text) return;
    for (const char* p = text; *p; ++p) add((uint8_t)*p);
  }

  void addStr(const char* text) { add(text); }

  void addInt(int value) {
    char buf[16];
    snprintf(buf, sizeof(buf), "%d", value);
    add(buf);
  }

  void fill(uint8_t value, size_t n) {
    for (size_t i = 0; i < n; i++) add(value);
  }

  size_t length() const { return _len; }
  bool full() const { return _full; }

 private:
  uint8_t* _buf;
  size_t _cap;
  size_t _len;
  bool _full;
};

/* --------------------------------------------------------- ESC/POS artwork */

/** Human readable test pattern drawn with ESC/POS text commands. */
void escposTestPattern(CmdBuilder& b, const char* title) {
  b.add(ESC); b.add(0x61); b.add(0x01);       /* centre          */
  b.add(ESC); b.add(0x21); b.add(0x10);       /* double height   */
  b.add(title); b.add('\n');
  b.add(ESC); b.add(0x21); b.add(0x00);
  b.add("--------------------------------\n");
  for (int row = 0; row < 6; row++) {
    b.add("|");
    for (int col = 0; col < 12; col++) b.add(((row % 2) == (col % 2)) ? "# " : ". ");
    b.add("|\n");
  }
  b.add("--------------------------------\n");
  b.add(ESC); b.add(0x64); b.add(0x04);
  b.add(ESC); b.add(0x61); b.add(0x00);
}

/** CODE39 + EAN13 + CODE128 + QR test sheet. */
void escposBarcodeSheet(CmdBuilder& b) {
  b.add(ESC); b.add(0x61); b.add(0x01);
  struct Entry { const char* hri; const char* data; uint8_t len; const uint8_t* cmd; };
  const uint8_t code39[] = {GS, 0x68, 0x28, GS, 0x77, 0x02, GS, 0x48, 0x02, GS, 0x6b, 0x04};
  const uint8_t ean13[] = {GS, 0x68, 0x50, GS, 0x77, 0x02, GS, 0x48, 0x02, GS, 0x6b, 0x02};
  const uint8_t code128[] = {GS, 0x68, 0x50, GS, 0x77, 0x02, GS, 0x48, 0x02, GS, 0x6b, 0x49};
  const Entry entries[3] = {
      {"CODE39\n", "ARSIN123", 11, code39},
      {"EAN13\n", "400638133393", 11, ean13},
      {"CODE128\n", "{BARSIN128", 11, code128},
  };
  for (int i = 0; i < 3; i++) {
    b.add(entries[i].hri);
    b.add(entries[i].cmd, entries[i].len);
    b.add(entries[i].data);
    b.add((uint8_t)0x00);
  }
  b.add("QR CODE\n");
  const uint8_t qr1[] = {GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00};
  const uint8_t qr2[] = {GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06};
  const uint8_t qr3[] = {GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31};
  b.add(qr1, sizeof(qr1));
  b.add(qr2, sizeof(qr2));
  b.add(qr3, sizeof(qr3));
  const uint8_t qr4[] = {GS, 0x28, 0x6b, 0x0a, 0x00, 0x31, 0x50, 0x30};
  b.add(qr4, sizeof(qr4));
  b.add("ARSIN-PS");
  b.add((uint8_t)0x00);
  const uint8_t qr5[] = {GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30};
  b.add(qr5, sizeof(qr5));
  b.add(ESC); b.add(0x64); b.add(0x04);
  b.add(ESC); b.add(0x61); b.add(0x00);
}

/* ------------------------------------------------------------------ ESC/POS */

bool buildEscPos(const char* action, const Params& p, CmdBuilder& b, char* note, size_t noteCap) {
  if (!strcmp(action, "selftest")) {
    const uint8_t seq[] = {ESC, 0x40, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x00};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "GS ( A execute printer test (self test + status sheet)");
  } else if (!strcmp(action, "status")) {
    const uint8_t seq[] = {DLE, 0x04, 0x01, GS, 0x72, 0x01};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "DLE EOT 1 + GS r 1, the reply lands in /api/serial");
  } else if (!strcmp(action, "config") || !strcmp(action, "counter")) {
    const uint8_t seq[] = {ESC, 0x40, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x01};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "GS ( A m=1 prints the status/configuration sheet");
  } else if (!strcmp(action, "initialize")) {
    b.add(ESC); b.add(0x40);
    snprintf(note, noteCap, "ESC @ initialise printer");
  } else if (!strcmp(action, "feed")) {
    b.add(ESC); b.add(0x64); b.add((uint8_t)clampInt(p.lines, 1, 255));
    snprintf(note, noteCap, "ESC d n feed %d line(s)", clampInt(p.lines, 1, 255));
  } else if (!strcmp(action, "cut")) {
    const bool partial = !strcmp(p.cutter, "partial");
    b.add(ESC); b.add(0x64); b.add(0x03);
    b.add(GS); b.add(0x56); b.add(partial ? 0x01 : 0x00);
    snprintf(note, noteCap, "%s cut (GS V %d)", partial ? "partial" : "full", partial ? 1 : 0);
  } else if (!strcmp(action, "drawer")) {
    const uint8_t seq[] = {ESC, 0x70, 0x00, 0x19, 0xFA};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "ESC p 0 25 250 drawer kick pulse (pin 2)");
  } else if (!strcmp(action, "headclean")) {
    b.add(ESC); b.add(0x40);
    escposTestPattern(b, "ESC/POS head test");
    snprintf(note, noteCap, "no cleaner on thermal heads: head-wear pattern, clean the head with IPA");
  } else if (!strcmp(action, "nozzlecheck")) {
    b.add(ESC); b.add(0x40);
    escposTestPattern(b, "Nozzle check");
    snprintf(note, noteCap, "12x6 nozzle grid (approximate on thermal units)");
  } else if (!strcmp(action, "align")) {
    b.add(ESC); b.add(0x40);
    escposTestPattern(b, "Alignment / paper sensor");
    snprintf(note, noteCap, "alignment / paper sensor pattern");
  } else if (!strcmp(action, "calibrate")) {
    const uint8_t media = (!strcmp(p.media, "blackmark")) ? 0x02 : 0x01;
    const uint8_t seq[] = {ESC, 0x40, GS, 0x28, 0x45, 0x02, 0x00, 0x00, media};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "media sensor preset (%s) where supported", p.media);
  } else if (!strcmp(action, "resetcounter")) {
    const uint8_t seq[] = {ESC, 0x40, GS, 0x28, 0x58, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "GS ( X resets trip counters on models that implement it");
  } else if (!strcmp(action, "density")) {
    const uint8_t seq[] = {ESC, 0x40, GS, 0x28, 0x4B, 0x02, 0x00, 0x30, (uint8_t)clampInt(p.darkness, 0, 15)};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "density %d (GS ( K style heat setting)", clampInt(p.darkness, 0, 15));
  } else if (!strcmp(action, "media")) {
    const uint8_t mode = !strcmp(p.media, "blackmark") ? 0x02 : (!strcmp(p.media, "continuous") ? 0x03 : 0x01);
    const uint8_t seq[] = {ESC, 0x40, GS, 0x28, 0x45, 0x02, 0x00, 0x00, mode};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "media type %s", p.media);
  } else if (!strcmp(action, "saveconfig")) {
    const uint8_t seq[] = {ESC, 0x40, GS, 0x28, 0x4B, 0x02, 0x00, 0x31, 0x01};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "stores the current settings in printer NV memory");
  } else if (!strcmp(action, "factoryreset")) {
    const uint8_t seq[] = {ESC, 0x40, GS, 0x28, 0x58, 0x04, 0x00, 0x00, 0x00};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "GS ( X restores printer parameters to factory values");
  } else if (!strcmp(action, "info")) {
    const uint8_t seq[] = {ESC, 0x40, GS, 0x49, 0x31, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x01};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "GS I 1 + GS ( A device id and configuration sheet");
  } else if (!strcmp(action, "barcode") || !strcmp(action, "barcodetest")) {
    b.add(ESC); b.add(0x40);
    escposBarcodeSheet(b);
    snprintf(note, noteCap, "CODE39 + EAN13 + CODE128 + QR verification sheet");
/* ---------------------------------------------------------------------- ZPL */

void zplPattern(CmdBuilder& b, const char* title, int rows) {
  b.add("^XA^CI28^PW600^LL400^FO30,30^A0N,32,32^FD");
  b.add(title);
  b.add("^FS");
  char line[96];
  for (int i = 0; i < rows; i++) {
    snprintf(line, sizeof(line), "^FO30,%d^A0N,24,24^FD%02d |................................|^FS", 80 + i * 32, i + 1);
    b.add(line);
  }
  b.add("^FO30,380^GB540,4,4^FS^PQ1^XZ");
}

bool buildZpl(const char* action, const Params& p, CmdBuilder& b, char* note, size_t noteCap) {
  if (!strcmp(action, "selftest") || !strcmp(action, "config")) {
    b.add("~WC");
    snprintf(note, noteCap, "~WC prints the configuration label (ZPL self test)");
  } else if (!strcmp(action, "status") || !strcmp(action, "info")) {
    b.add("~HS");
    snprintf(note, noteCap, "~HS host status query, the reply lands in /api/serial");
  } else if (!strcmp(action, "initialize")) {
    b.add("^XA^XZ");
    snprintf(note, noteCap, "^XA^XZ clears the format buffer");
  } else if (!strcmp(action, "feed")) {
    char cmd[48];
    snprintf(cmd, sizeof(cmd), "^XA^FO0,0^GB1,%d,1^FS^XZ", clampInt(p.lines, 1, 255) * 8);
    b.add(cmd);
    snprintf(note, noteCap, "blank label of %d dot(s) to advance the media", clampInt(p.lines, 1, 255) * 8);
  } else if (!strcmp(action, "cut")) {
    b.add("^XA^CN1^XZ");
    snprintf(note, noteCap, "^CN1 cut now (cutter equipped models)");
  } else if (!strcmp(action, "calibrate")) {
    b.add("^XA^JUC^XZ");
    snprintf(note, noteCap, "^JUC auto-calibrate media");
  } else if (!strcmp(action, "density")) {
    char cmd[48];
    snprintf(cmd, sizeof(cmd), "^XA^MD%d^XZ", (clampInt(p.darkness, 0, 15) - 8) * 2);
    b.add(cmd);
    snprintf(note, noteCap, "^MD darkness %d", (clampInt(p.darkness, 0, 15) - 8) * 2);
  } else if (!strcmp(action, "media")) {
    b.add(!strcmp(p.media, "blackmark") ? "^XA^MNM^XZ" : (!strcmp(p.media, "continuous") ? "^XA^MNY^XZ" : "^XA^MNN^XZ"));
    snprintf(note, noteCap, "^MN media tracking for %s media", p.media);
  } else if (!strcmp(action, "counter")) {
    b.add("~HQES");
    snprintf(note, noteCap, "~HQES status query returns the odometer on most models");
  } else if (!strcmp(action, "resetcounter") || !strcmp(action, "factoryreset")) {
    const bool factory = !strcmp(action, "factoryreset");
    b.add(factory ? "^XA^JUF^XZ" : "~JR");
    snprintf(note, noteCap, "%s", factory ? "^JUF factory defaults" : "~JR reset printer");
  } else if (!strcmp(action, "nozzlecheck") || !strcmp(action, "headclean") || !strcmp(action, "align") || !strcmp(action, "barcodetest")) {
    const char* title = !strcmp(action, "nozzlecheck") ? "NOZZLE CHECK"
                        : (!strcmp(action, "headclean") ? "HEAD TEST"
                                                        : (!strcmp(action, "align") ? "ALIGNMENT" : "BARCODE TEST"));
    zplPattern(b, title, 8);
    if (!strcmp(action, "barcodetest")) {
      b.add("^XA^FO40,60^BY3^BCN,80,Y,N,N^FDARSIN123^FS^FO40,200^BQN,2,6^FDLA,ARSIN-PS^FS^XZ");
    }
    snprintf(note, noteCap, "test label printed with native ZPL commands");
  } else if (!strcmp(action, "barcode")) {
    b.add("^XA^FO40,40^BY3^BCN,80,Y,N,N^FD");
    b.add(p.data);
    b.add("^FS^FO40,180^BQN,2,6^FDLA,");
    b.add(p.data);
    b.add("^FS^XZ");
    snprintf(note, noteCap, "Code128 + QR label");
  } else if (!strcmp(action, "drawer")) {
    b.add("^XA^XZ");
    snprintf(note, noteCap, "ZPL printers have no cash drawer port");
  } else {
    return false;
  }
  return true;
}

/* --------------------------------------------------------------------- TSPL */

bool buildTspl(const char* action, const Params& p, CmdBuilder& b, char* note, size_t noteCap) {
  const char* media = !strcmp(p.media, "blackmark") ? "BLINE 3 mm,0\r\n"
                     : (!strcmp(p.media, "continuous") ? "GAP 0,0\r\n" : "GAP 2 mm,0\r\n");
  if (!strcmp(action, "selftest") || !strcmp(action, "config")) {
    b.add("SELFTEST\r\n");
    snprintf(note, noteCap, "SELFTEST prints the TSPL configuration page");
  } else if (!strcmp(action, "status") || !strcmp(action, "info") || !strcmp(action, "counter")) {
    b.add((uint8_t)0x1B);
    b.add("!?");
    snprintf(note, noteCap, "ESC !? status query, the reply lands in /api/serial");
  } else if (!strcmp(action, "initialize")) {
    b.add("CLS\r\n");
    snprintf(note, noteCap, "CLS clears the image buffer");
  } else if (!strcmp(action, "feed")) {
    b.add("FEED ");
    b.addInt(clampInt(p.lines, 1, 255) * 8);
    b.add("\r\n");
    snprintf(note, noteCap, "FEED advances the media");
  } else if (!strcmp(action, "cut")) {
    b.add("CUT\r\n");
    snprintf(note, noteCap, "CUT (cutter equipped models)");
  } else if (!strcmp(action, "calibrate")) {
    b.add(media);
    b.add("GAPDETECT\r\n");
    snprintf(note, noteCap, "media calibration with the configured sensor");
  } else if (!strcmp(action, "density")) {
    b.add("DENSITY ");
    b.addInt(clampInt(p.darkness, 0, 15));
    b.add("\r\n");
    snprintf(note, noteCap, "DENSITY %d", clampInt(p.darkness, 0, 15));
  } else if (!strcmp(action, "media")) {
    b.add(media);
    snprintf(note, noteCap, "media sensor setup for %s media", p.media);
  } else if (!strcmp(action, "resetcounter") || !strcmp(action, "factoryreset")) {
    b.add("INITIALPRINTER\r\n");
    snprintf(note, noteCap, "INITIALPRINTER restores factory defaults (vendor specific)");
  } else if (!strcmp(action, "nozzlecheck") || !strcmp(action, "headclean") || !strcmp(action, "align")) {
    b.add("SIZE 80 mm,60 mm\r\nGAP 2 mm,0\r\nCLS\r\nTEXT 10,10,\"3\",0,1,1,\"");
    b.add(!strcmp(action, "nozzlecheck") ? "NOZZLE CHECK" : (!strcmp(action, "headclean") ? "HEAD TEST" : "ALIGNMENT"));
    b.add("\"\r\nBARCODE 10,60,\"128\",80,1,0,2,4,\"ARSIN123\"\r\nPRINT 1\r\n");
    snprintf(note, noteCap, "TSPL test label printed");
  } else if (!strcmp(action, "barcode") || !strcmp(action, "barcodetest")) {
    b.add("SIZE 80 mm,60 mm\r\nGAP 2 mm,0\r\nCLS\r\nBARCODE 10,10,\"128\",90,1,0,2,4,\"");
    b.add(p.data);
    b.add("\"\r\nQRCODE 10,140,L,6,A,0,M2,S7,\"");
    b.add(p.data);
    b.add("\"\r\nPRINT 1\r\n");
    snprintf(note, noteCap, "Code128 + QR label");
  } else if (!strcmp(action, "drawer")) {
    b.add((uint8_t)0x07);
    snprintf(note, noteCap, "BEL pulse, works on TSPL units with a drawer port");
  } else {
    return false;
  }
  return true;
}

/* ---------------------------------------------------------------------- EPL */

bool buildEpl(const char* action, const Params& p, CmdBuilder& b, char* note, size_t noteCap) {
  if (!strcmp(action, "selftest") || !strcmp(action, "config") || !strcmp(action, "info")) {
    b.add("N\r\nU\r\nP1\r\n");
    snprintf(note, noteCap, "N/U/P1 prints a blank label; EPL self test runs from the front panel");
  } else if (!strcmp(action, "status") || !strcmp(action, "counter")) {
    b.add((uint8_t)0x1B);
    b.add("!?");
    snprintf(note, noteCap, "ESC !? status query, the reply lands in /api/serial");
  } else if (!strcmp(action, "initialize")) {
    b.add("N\r\n");
    snprintf(note, noteCap, "N clears the image buffer");
  } else if (!strcmp(action, "feed")) {
    b.add("U\r\n");
    snprintf(note, noteCap, "U feeds one label");
  } else if (!strcmp(action, "cut")) {
    b.add("N\r\nP1\r\n");
    snprintf(note, noteCap, "print a blank label, the cutter fires when enabled in EPL");
  } else if (!strcmp(action, "density")) {
    char cmd[32];
    snprintf(cmd, sizeof(cmd), "D%d\r\n", clampInt(p.darkness, 0, 15));
    b.add(cmd);
    snprintf(note, noteCap, "D%d density", clampInt(p.darkness, 0, 15));
  } else if (!strcmp(action, "media") || !strcmp(action, "calibrate")) {
    b.add("Z\r\n");
    snprintf(note, noteCap, "Z auto-detects the label length (gap/black-mark)");
  } else if (!strcmp(action, "resetcounter") || !strcmp(action, "factoryreset")) {
    b.add("N\r\nZ\r\n");
    snprintf(note, noteCap, "clear the buffer and re-calibrate");
  } else if (!strcmp(action, "nozzlecheck") || !strcmp(action, "headclean") || !strcmp(action, "align")) {
    b.add("N\r\nA10,10,0,3,1,1,N,\"");
    b.add(!strcmp(action, "nozzlecheck") ? "NOZZLE CHECK" : (!strcmp(action, "headclean") ? "HEAD TEST" : "ALIGNMENT"));
    b.add("\"\r\nB10,60,0,1,2,4,60,B,\"ARSIN123\"\r\nP1\r\n");
    snprintf(note, noteCap, "EPL test label printed");
  } else if (!strcmp(action, "barcode") || !strcmp(action, "barcodetest")) {
    b.add("N\r\nB10,10,0,1,2,4,80,B,\"");
    b.add(p.data);
    b.add("\"\r\nP1\r\n");
    snprintf(note, noteCap, "EPL Code128 label");
  } else if (!strcmp(action, "drawer")) {
    snprintf(note, noteCap, "EPL printers have no cash drawer port");
  } else {
    return false;
  }
  return true;
}

/* --------------------------------------------------------------------- CPCL */

bool buildCpcl(const char* action, const Params& p, CmdBuilder& b, char* note, size_t noteCap) {
  const char* header = "! 0 200 200 300 1\r\n";
  if (!strcmp(action, "selftest") || !strcmp(action, "config") || !strcmp(action, "nozzlecheck") ||
      !strcmp(action, "headclean") || !strcmp(action, "align")) {
    b.add(header);
    b.add("T 4 0 20 40 ");
    b.add(!strcmp(action, "selftest") ? "SELF TEST"
          : (!strcmp(action, "config") ? "CONFIGURATION"
             : (!strcmp(action, "nozzlecheck") ? "NOZZLE CHECK"
                : (!strcmp(action, "headclean") ? "HEAD TEST" : "ALIGNMENT"))));
    b.add("\r\nT 4 0 20 90 ARSIN PRINT SERVER\r\nB 128 2 30 140 60 90 ARSIN123\r\nFORM\r\nPRINT\r\n");
    snprintf(note, noteCap, "CPCL test label printed");
  } else if (!strcmp(action, "status") || !strcmp(action, "info") || !strcmp(action, "counter")) {
    b.add((uint8_t)0x1B);
    b.add("!?");
    snprintf(note, noteCap, "ESC !? status query, the reply lands in /api/serial");
  } else if (!strcmp(action, "initialize")) {
    b.add("! 0 200 200 300 1\r\nFORM\r\n");
    snprintf(note, noteCap, "FORM clears the label");
  } else if (!strcmp(action, "feed")) {
    b.add(header);
    b.add("FORM\r\nPRINT\r\n");
    snprintf(note, noteCap, "PRINT a blank label to advance the media");
  } else if (!strcmp(action, "cut")) {
    b.add(header);
    b.add("CUT\r\nPRINT\r\n");
    snprintf(note, noteCap, "CUT command, requires a cutter");
  } else if (!strcmp(action, "density")) {
    b.add(header);
    b.add("TONE ");
    b.addInt(clampInt(p.darkness, 0, 15));
    b.add("\r\nPRINT\r\n");
    snprintf(note, noteCap, "TONE %d", clampInt(p.darkness, 0, 15));
  } else if (!strcmp(action, "media") || !strcmp(action, "calibrate")) {
    b.add(header);
    b.add(!strcmp(p.media, "continuous") ? "GAP 0\r\n" : "GAP-SENSE\r\n");
    b.add("FORM\r\nPRINT\r\n");
    snprintf(note, noteCap, "media sensor setup for %s media", p.media);
  } else if (!strcmp(action, "resetcounter") || !strcmp(action, "factoryreset")) {
    b.add("! U1 reset\r\n");
    snprintf(note, noteCap, "CPCL reset (vendor specific)");
  } else if (!strcmp(action, "barcode") || !strcmp(action, "barcodetest")) {
    b.add(header);
    b.add("B 128 2 30 40 80 120 ");
    b.add(p.data);
    b.add("\r\nB QR 30 160 M 2 U 6\r\nMA,");
    b.add(p.data);
    b.add("\r\nENDQR\r\nFORM\r\nPRINT\r\n");
    snprintf(note, noteCap, "CPCL Code128 + QR label");
  } else if (!strcmp(action, "drawer")) {
    b.add((uint8_t)0x07);
    snprintf(note, noteCap, "BEL pulse, works on CPCL units with a drawer port");
  } else {
    return false;
  }
  return true;
}

/* ---------------------------------------------------------------- StarPRNT */

bool buildStar(const char* action, const Params& p, CmdBuilder& b, char* note, size_t noteCap) {
  if (!strcmp(action, "selftest") || !strcmp(action, "config")) {
    const uint8_t seq[] = {0x1B, 0x40, 0x1B, 0x1E};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "ESC @ + ESC 0x1E Star test print / configuration page");
  } else if (!strcmp(action, "status") || !strcmp(action, "info") || !strcmp(action, "counter")) {
    const uint8_t seq[] = {0x1B, 0x40, 0x1B, 0x05, 0x01};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "ESC 0x05 status request, the reply lands in /api/serial");
  } else if (!strcmp(action, "initialize")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x40);
    snprintf(note, noteCap, "ESC @ initialise printer");
  } else if (!strcmp(action, "feed")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x61); b.add((uint8_t)clampInt(p.lines, 1, 255));
    snprintf(note, noteCap, "ESC a n feed");
  } else if (!strcmp(action, "cut")) {
    const uint8_t seq[] = {0x1B, 0x64, 0x02};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "ESC d 2 partial cut (Star line mode)");
  } else if (!strcmp(action, "drawer")) {
    const uint8_t seq[] = {0x1B, 0x07, 0x07, 0x07, 0x07};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "ESC BEL drawer kick pulse");
  } else if (!strcmp(action, "density")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x3D); b.add((uint8_t)clampInt(p.darkness, 0, 15));
    snprintf(note, noteCap, "ESC = n print density");
  } else if (!strcmp(action, "media") || !strcmp(action, "calibrate")) {
    const uint8_t seq[] = {0x1B, 0x40, 0x1B, 0x1D, 0x03};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "media sensor re-calibration (vendor specific)");
  } else if (!strcmp(action, "nozzlecheck") || !strcmp(action, "headclean") || !strcmp(action, "align") ||
             !strcmp(action, "barcode") || !strcmp(action, "barcodetest")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x40);
    const char* title = !strcmp(action, "nozzlecheck") ? "NOZZLE CHECK"
                        : (!strcmp(action, "headclean") ? "HEAD TEST"
                                                        : (!strcmp(action, "align") ? "ALIGNMENT" : "BARCODE TEST"));
    escposTestPattern(b, title);
    if (!strcmp(action, "barcode") || !strcmp(action, "barcodetest")) escposBarcodeSheet(b);
    snprintf(note, noteCap, "ESC/POS style test pattern (Star line mode)");
  } else if (!strcmp(action, "resetcounter") || !strcmp(action, "factoryreset")) {
    const uint8_t seq[] = {0x1B, 0x40, 0x1B, 0x23, 0x23};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "reset command (vendor specific)");
  } else {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------ ESC/P & plain */

bool buildEscP(const char* action, const Params& p, CmdBuilder& b, char* note, size_t noteCap) {
  if (!strcmp(action, "initialize")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x40);
    snprintf(note, noteCap, "ESC @ initialise");
  } else if (!strcmp(action, "feed")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x64); b.add((uint8_t)clampInt(p.lines, 1, 255));
    snprintf(note, noteCap, "ESC d n line feed");
  } else if (!strcmp(action, "cut")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x69);
    snprintf(note, noteCap, "ESC i cut / form feed on impact printers");
  } else if (!strcmp(action, "drawer")) {
    const uint8_t seq[] = {0x1B, 0x70, 0x00, 0x19, 0xFA};
    b.add(seq, sizeof(seq));
    snprintf(note, noteCap, "ESC p drawer kick");
  } else if (!strcmp(action, "density")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x45);
    snprintf(note, noteCap, "ESC E emphasised print as a darkness hint");
  } else if (!strcmp(action, "selftest") || !strcmp(action, "config") || !strcmp(action, "info") ||
             !strcmp(action, "nozzlecheck") || !strcmp(action, "headclean") || !strcmp(action, "align") ||
             !strcmp(action, "barcode") || !strcmp(action, "barcodetest")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x40);
    escposTestPattern(b, "ESC/P test page");
    b.add((uint8_t)0x0C);
    snprintf(note, noteCap, "ESC/P test page (impact printers have no sensor calibration)");
  } else if (!strcmp(action, "status") || !strcmp(action, "counter")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x40);
    b.add("STATUS\r\n");
    snprintf(note, noteCap, "text status page, impact printers rarely answer status queries");
  } else if (!strcmp(action, "media") || !strcmp(action, "calibrate") || !strcmp(action, "resetcounter") ||
             !strcmp(action, "factoryreset")) {
    b.add((uint8_t)0x1B); b.add((uint8_t)0x40);
    snprintf(note, noteCap, "not applicable on ESC/P: buffer reset only");
  } else {
    return false;
  }
  return true;
}

bool buildPlain(const char* action, const Params& p, CmdBuilder& b, char* note, size_t noteCap) {
  if (!strcmp(action, "feed")) {
    b.fill('\n', (size_t)clampInt(p.lines, 1, 255));
    snprintf(note, noteCap, "line feeds");
  } else if (!strcmp(action, "cut")) {
    b.add((uint8_t)0x0C);
    snprintf(note, noteCap, "form feed");
  } else if (!strcmp(action, "status") || !strcmp(action, "info")) {
    b.add("ARSIN PRINT SERVER STATUS\n");
    snprintf(note, noteCap, "plain text status block");
  } else if (!strcmp(action, "selftest") || !strcmp(action, "config") || !strcmp(action, "nozzlecheck") ||
             !strcmp(action, "headclean") || !strcmp(action, "align") || !strcmp(action, "barcode") ||
             !strcmp(action, "barcodetest")) {
    b.add("ARSIN PRINT SERVER\n==================\n");
    b.add("device : ");
    b.add(g_config.deviceName);
    b.add("\nprinter: ");
    b.add(g_config.printerName);
    b.add("\nlang   : ");
    b.add(g_config.language);
    b.add("\nwidth  : ");
    b.addInt((int)g_config.widthMm);
    b.add(" mm\ndpi    : ");
    b.addInt((int)g_config.dpi);
    b.add("\n\n");
    for (int i = 0; i < 12; i++) b.add("|..........|\n");
    b.add("\n");
    b.add((uint8_t)0x0C);
    snprintf(note, noteCap, "plain text test page");
  } else if (!strcmp(action, "initialize") || !strcmp(action, "density") || !strcmp(action, "media") ||
             !strcmp(action, "calibrate") || !strcmp(action, "resetcounter") || !strcmp(action, "counter") ||
             !strcmp(action, "factoryreset") || !strcmp(action, "drawer")) {
    snprintf(note, noteCap, "no byte sequence defined for plain text printers");
  } else {
    return false;
  }
  return true;
}

/* ----------------------------------------------------------------- dispatch */

struct LangEntry {
  const char* id;
  bool (*build)(const char* action, const Params& p, CmdBuilder& b, char* note, size_t noteCap);
};

const LangEntry kLanguages[] = {
    {"escpos", buildEscPos},
    {"zpl", buildZpl},
    {"tspl", buildTspl},
    {"epl", buildEpl},
    {"cpcl", buildCpcl},
    {"starprnt", buildStar},
    {"escp", buildEscP},
    {"plain", buildPlain},
};

const char* const kActions[] = {
    "selftest", "status", "config", "initialize", "feed", "cut", "drawer", "calibrate",
    "density", "media", "counter", "resetcounter", "factoryreset", "info", "barcode",
    "nozzlecheck", "headclean", "align", "saveconfig", "barcodetest",
};

const char* normalizeLanguage(const char* lang) {
  if (!lang || !lang[0]) return "escpos";
  if (!strcasecmp(lang, "escpos") || !strcasecmp(lang, "epson")) return "escpos";
  if (!strcasecmp(lang, "zpl") || !strcasecmp(lang, "zebra")) return "zpl";
  if (!strcasecmp(lang, "tspl") || !strcasecmp(lang, "tspl2")) return "tspl";
  if (!strcasecmp(lang, "epl")) return "epl";
  if (!strcasecmp(lang, "cpcl")) return "cpcl";
  if (!strcasecmp(lang, "starprnt") || !strcasecmp(lang, "star")) return "starprnt";
  if (!strcasecmp(lang, "escp") || !strcasecmp(lang, "esc/p")) return "escp";
  if (!strcasecmp(lang, "plain") || !strcasecmp(lang, "text")) return "plain";
  return nullptr;
}

}  // namespace

const char* const* arsinCommandActions(size_t* count) {
  if (count) *count = sizeof(kActions) / sizeof(kActions[0]);
  return kActions;
}

bool arsinCommandActionKnown(const char* action) {
  if (!action) return false;
  for (size_t i = 0; i < sizeof(kActions) / sizeof(kActions[0]); i++) {
    if (!strcmp(action, kActions[i])) return true;
  }
  return false;
}

const char* const* arsinCommandLanguages(size_t* count) {
  static const char* langs[] = {"escpos", "zpl", "tspl", "epl", "cpcl", "starprnt", "escp", "plain"};
  if (count) *count = sizeof(langs) / sizeof(langs[0]);
  return langs;
}

bool arsinRepeatBytes(const uint8_t* src, size_t len, uint8_t copies, uint8_t* out, size_t cap, size_t* outLen) {
  if (!src || !out || copies == 0) return false;
  if ((size_t)copies * len > cap) return false;
  size_t o = 0;
  for (uint8_t c = 0; c < copies; c++) {
    for (size_t i = 0; i < len; i++) out[o++] = src[i];
  }
  if (outLen) *outLen = o;
  return true;
}

bool arsinBuildCommand(const char* lang,
                       const char* action,
                       const char* paramsJson,
                       size_t paramsLen,
                       uint8_t* out,
                       size_t cap,
                       size_t* outLen,
                       char* note,
                       size_t noteCap) {
  if (note && noteCap) note[0] = 0;
  if (outLen) *outLen = 0;
  if (!out || cap == 0 || !action) return false;

  const char* resolved = normalizeLanguage(lang);
  if (!resolved) {
    if (note && noteCap) snprintf(note, noteCap, "unsupported language '%s'", lang ? lang : "");
    return false;
  }

  Params params;
  if (paramsJson && paramsLen > 0) {
    ParamSink sink(params);
    char err[48];
    if (!arsinJsonParse(paramsJson, paramsLen, sink, err, sizeof(err))) {
      LOGW("command: ignoring malformed params (%s)", err);
    }
  }
  params.lines = clampInt(params.lines, 1, 255);
  params.copies = clampInt(params.copies, 1, 20);
  params.darkness = clampInt(params.darkness, 0, 15);
  params.speed = clampInt(params.speed, 1, 14);
  params.height = clampInt(params.height, 8, 512);
  params.width = clampInt(params.width, 1, 10);

  bool handled = false;
  for (size_t i = 0; i < sizeof(kLanguages) / sizeof(kLanguages[0]); i++) {
    if (strcmp(kLanguages[i].id, resolved) != 0) continue;
    CmdBuilder builder(out, cap);
    handled = kLanguages[i].build(action, params, builder, note, noteCap);
    if (handled) {
      size_t len = builder.length();
      if (params.copies > 1 && len > 0) {
        static uint8_t scratch[512];
        const size_t copyLen = (len < sizeof(scratch)) ? len : sizeof(scratch);
        memcpy(scratch, out, copyLen);
        size_t repeated = 0;
        if (arsinRepeatBytes(scratch, copyLen, (uint8_t)params.copies, out, cap, &repeated)) {
          len = repeated;
        } else {
          LOGW("command: copies=%u does not fit the buffer", (unsigned)params.copies);
        }
      }
      if (builder.full()) {
        if (note && noteCap) snprintf(note, noteCap, "buffer full: command truncated");
        LOGE("command: %s/%s truncated", resolved, action);
      }
      if (outLen) *outLen = len;
    }
    break;
  }

  if (!handled) {
    if (note && noteCap) snprintf(note, noteCap, "action '%s' is not defined for %s", action, resolved);
    return false;
  }
  return true;
}
