/*
 * Arsin Print Server - dependency free JSON helpers.
 *
 * The firmware intentionally does not depend on ArduinoJson: the ESP8266 build
 * has very little head room and the installer has to work with whatever library
 * set the user happens to have.  Two pieces are provided:
 *
 *   arsinJsonParse()  - a bounded, allocation free, event based parser.
 *   JsonOut           - a bounds checked JSON writer over a caller buffer.
 *
 * The parser never allocates: it walks the input and reports every leaf value
 * to a JsonSink together with its dotted path ("sta.saved[0].ssid").
 */
#ifndef ARSIN_JSON_H
#define ARSIN_JSON_H

#include <stddef.h>
#include <stdint.h>

/** Receives values while the document is walked.  Paths are dot separated,
 *  array items are reported as "key[index]". */
class JsonSink {
 public:
  virtual ~JsonSink() {}
  virtual void onObjectStart(const char* path) { (void)path; }
  virtual void onObjectEnd(const char* path) { (void)path; }
  virtual void onArrayStart(const char* path) { (void)path; }
  virtual void onArrayEnd(const char* path) { (void)path; }
  virtual void onKey(const char* path, const char* key) { (void)path; (void)key; }
  virtual void onString(const char* path, const char* value) { (void)path; (void)value; }
  virtual void onNumber(const char* path, double value) { (void)path; (void)value; }
  virtual void onBool(const char* path, bool value) { (void)path; (void)value; }
  virtual void onNull(const char* path) { (void)path; }
};

/** Parse `len` bytes of JSON.  Returns false and fills `err` on malformed
 *  input.  `err` may be NULL. */
bool arsinJsonParse(const char* text, size_t len, JsonSink& sink, char* err, size_t errCap);

/** Convenience sink: remembers one path and copies its string value out. */
class JsonPickString : public JsonSink {
 public:
  JsonPickString(const char* wanted, char* out, size_t cap)
      : _wanted(wanted), _out(out), _cap(cap), _found(false) {
    if (_cap) _out[0] = 0;
  }
  void onString(const char* path, const char* value) override;
  void onNumber(const char* path, double value) override;
  void onBool(const char* path, bool value) override;
  bool found() const { return _found; }

 private:
  void store(const char* path, const char* value);
  const char* _wanted;
  char* _out;
  size_t _cap;
  bool _found;
};

/** JSON writer with hard bounds checking - never overflows, never allocates. */
class JsonOut {
 public:
  JsonOut(char* buf, size_t cap);
  void beginObject();
  void endObject();
  void beginObjectAt(const char* key);
  void beginArrayAt(const char* key);
  void endArray();
  void kvString(const char* key, const char* value);
  void kvStringTrunc(const char* key, const char* value, size_t maxLen);
  void kvLong(const char* key, long value);
  void kvULong(const char* key, unsigned long value);
  void kvDouble(const char* key, double value, uint8_t decimals);
  void kvBool(const char* key, bool value);
  void kvNull(const char* key);
  void raw(const char* text);
  size_t length() const { return _len; }
  bool overflowed() const { return _overflow; }
  const char* c_str() const { return _buf; }

 private:
  void separate();
  void append(const char* text, size_t n);
  char* _buf;
  size_t _cap;
  size_t _len;
  bool _first;
  bool _overflow;
};

/** Escape a string into a JSON literal (without surrounding quotes). */
void arsinJsonEscape(const char* in, char* out, size_t cap);

/* ------------------------------------------------------------- hex helpers */

/** "1B 40" style encoder; `spaced` selects the separator. */
void arsinHexEncode(const uint8_t* data, size_t len, char* out, size_t cap, bool spaced);
/** Accepts "1B 40", "0x1B,0x40", "1b40" - returns the number of bytes written. */
size_t arsinHexDecode(const char* text, uint8_t* out, size_t cap);

#endif /* ARSIN_JSON_H */
