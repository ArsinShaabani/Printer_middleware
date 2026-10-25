/*
 * Arsin Print Server - dependency free JSON parser / writer implementation.
 */
#include "arsin_json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ARSIN_JSON_PATH_MAX 192
#define ARSIN_JSON_STR_MAX 200
#define ARSIN_JSON_DEPTH 10

namespace {

struct PathFrame {
  size_t len;   /* length of the container path when the frame was pushed */
  unsigned idx; /* current array index                                    */
};

class Parser {
 public:
  Parser(const char* text, size_t len, JsonSink& sink, char* err, size_t errCap)
      : _s(text), _n(len), _i(0), _sink(sink), _err(err), _errCap(errCap), _depth(0) {
    _path[0] = 0;
    _pathLen = 0;
    if (_err && _errCap) _err[0] = 0;
  }

  bool run() {
    ws();
    if (!parseValue()) return false;
    ws();
    if (_i != _n) return fail("trailing data");
    return true;
  }

 private:
  /* -------------------------------------------------------------- plumbing */
  bool fail(const char* msg) {
    if (_err && _errCap) snprintf(_err, _errCap, "%s (offset %u)", msg, (unsigned)_i);
    return false;
  }

  void ws() {
    while (_i < _n) {
      const char c = _s[_i];
      if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
        _i++;
      } else {
        break;
      }
    }
  }

  void pathAppend(const char* text) {
    const size_t n = strlen(text);
    for (size_t k = 0; k < n && _pathLen + 1 < ARSIN_JSON_PATH_MAX; k++) {
      _path[_pathLen++] = text[k];
    }
    _path[_pathLen] = 0;
  }

  void pathAppendChar(char c) {
    if (_pathLen + 1 < ARSIN_JSON_PATH_MAX) {
      _path[_pathLen++] = c;
      _path[_pathLen] = 0;
    }
  }

  bool pushFrame() {
    if (_depth >= ARSIN_JSON_DEPTH) return false;
    _stack[_depth].len = _pathLen;
    _stack[_depth].idx = 0;
    _depth++;
    return true;
  }

  void popFrame() {
    if (_depth > 0) {
      _depth--;
      _pathLen = _stack[_depth].len;
      _path[_pathLen] = 0;
    }
  }

  void setObjectKey(const char* key) {
    _pathLen = (_depth > 0) ? _stack[_depth - 1].len : 0;
    _path[_pathLen] = 0;
    if (_depth > 1) pathAppendChar('.');
    pathAppend(key);
  }

  void setArrayIndex(unsigned index) {
    char idx[16];
    snprintf(idx, sizeof(idx), "[%u]", index);
    _pathLen = (_depth > 0) ? _stack[_depth - 1].len : 0;
    _path[_pathLen] = 0;
    pathAppend(idx);
  }

  /* ---------------------------------------------------------------- lexing */
  bool parseString(char* out, size_t cap) {
    if (_i >= _n || _s[_i] != '"') return fail("expected string");
    _i++;
    size_t o = 0;
    while (_i < _n) {
      const unsigned char c = (unsigned char)_s[_i++];
      if (c == '"') {
        if (cap) out[(o < cap) ? o : cap - 1] = 0;
        return true;
      }
      if (c == '\\') {
        if (_i >= _n) return fail("bad escape");
        const char e = _s[_i++];
        char decoded = 0;
        switch (e) {
          case '"': decoded = '"'; break;
          case '\\': decoded = '\\'; break;
          case '/': decoded = '/'; break;
          case 'b': decoded = '\b'; break;
          case 'f': decoded = '\f'; break;
          case 'n': decoded = '\n'; break;
          case 'r': decoded = '\r'; break;
          case 't': decoded = '\t'; break;
          case 'u': {
            if (_i + 4 > _n) return fail("bad \\u escape");
            unsigned code = 0;
            for (int k = 0; k < 4; k++) {
              const char h = _s[_i++];
              code <<= 4;
              if (h >= '0' && h <= '9') code |= (unsigned)(h - '0');
              else if (h >= 'a' && h <= 'f') code |= (unsigned)(h - 'a' + 10);
              else if (h >= 'A' && h <= 'F') code |= (unsigned)(h - 'A' + 10);
              else return fail("bad hex in \\u escape");
            }
            if (code < 0x80) {
              decoded = (char)code;
            } else {
              if (o + 1 < cap) out[o++] = (char)(0xC0 | (code >> 6));
              decoded = (char)(0x80 | (code & 0x3F));
            }
            break;
          }
          default: return fail("unknown escape");
        }
        if (o + 1 < cap) out[o++] = decoded;
        continue;
      }
      if (o + 1 < cap) out[o++] = (char)c;
    }
    return fail("unterminated string");
  }

  bool parseNumber() {
    char buf[40];
    size_t o = 0;
    while (_i < _n) {
      const char c = _s[_i];
      if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') {
        if (o + 1 < sizeof(buf)) buf[o++] = c;
        _i++;
      } else {
        break;
      }
    }
    if (o == 0) return fail("expected number");
    buf[o] = 0;
    _sink.onNumber(_path, strtod(buf, nullptr));
    return true;
  }

  bool parseLiteral(const char* lit, size_t len) {
    if (_i + len > _n || strncmp(_s + _i, lit, len) != 0) return fail("bad literal");
    _i += len;
    return true;
  }

  /* --------------------------------------------------------------- grammar */
  bool parseValue() {
    ws();
    if (_i >= _n) return fail("unexpected end");
    const char c = _s[_i];
    switch (c) {
      case '{': return parseObject();
      case '[': return parseArray();
      case '"': {
        char value[ARSIN_JSON_STR_MAX];
        if (!parseString(value, sizeof(value))) return false;
        _sink.onString(_path, value);
        return true;
      }
      case 't':
        if (!parseLiteral("true", 4)) return false;
        _sink.onBool(_path, true);
        return true;
      case 'f':
        if (!parseLiteral("false", 5)) return false;
        _sink.onBool(_path, false);
        return true;
      case 'n':
        if (!parseLiteral("null", 4)) return false;
        _sink.onNull(_path);
        return true;
      default: return parseNumber();
    }
  }

  bool parseObject() {
    _i++; /* '{' */
    if (!pushFrame()) return fail("too deeply nested");
    _sink.onObjectStart(_path);
    ws();
    if (_i < _n && _s[_i] == '}') {
      _i++;
      popFrame();
      _sink.onObjectEnd(_path);
      return true;
    }
    while (true) {
      ws();
      char key[64];
      if (!parseString(key, sizeof(key))) return false;
      setObjectKey(key);
      _sink.onKey(_path, key);
      ws();
      if (_i >= _n || _s[_i] != ':') return fail("expected ':'");
      _i++;
      if (!parseValue()) return false;
      ws();
      if (_i >= _n) return fail("unexpected end in object");
      if (_s[_i] == ',') {
        _i++;
        continue;
      }
      if (_s[_i] == '}') {
        _i++;
        break;
      }
      return fail("expected ',' or '}'");
    }
    popFrame();
    _sink.onObjectEnd(_path);
    return true;
  }

  bool parseArray() {
    _i++; /* '[' */
    if (!pushFrame()) return fail("too deeply nested");
    _sink.onArrayStart(_path);
    ws();
    if (_i < _n && _s[_i] == ']') {
      _i++;
      popFrame();
      _sink.onArrayEnd(_path);
      return true;
    }
    while (true) {
      setArrayIndex(_stack[_depth - 1].idx++);
      if (!parseValue()) return false;
      ws();
      if (_i >= _n) return fail("unexpected end in array");
      if (_s[_i] == ',') {
        _i++;
        continue;
      }
      if (_s[_i] == ']') {
        _i++;
        break;
      }
      return fail("expected ',' or ']'");
    }
    popFrame();
    _sink.onArrayEnd(_path);
    return true;
  }

  const char* _s;
  size_t _n;
  size_t _i;
  JsonSink& _sink;
  char* _err;
  size_t _errCap;
  char _path[ARSIN_JSON_PATH_MAX];
  size_t _pathLen;
  PathFrame _stack[ARSIN_JSON_DEPTH];
  int _depth;
};

}  // namespace

bool arsinJsonParse(const char* text, size_t len, JsonSink& sink, char* err, size_t errCap) {
  if (!text) {
    if (err && errCap) snprintf(err, errCap, "empty body");
    return false;
  }
  Parser parser(text, len, sink, err, errCap);
  return parser.run();
}

/* ------------------------------------------------------------ JsonPickString */

void JsonPickString::store(const char* path, const char* value) {
  if (_found || !path || !_wanted || strcmp(path, _wanted) != 0) return;
  _found = true;
  if (!_out || _cap == 0) return;
  strncpy(_out, value, _cap - 1);
  _out[_cap - 1] = 0;
}

void JsonPickString::onString(const char* path, const char* value) { store(path, value); }

void JsonPickString::onNumber(const char* path, double value) {
  char buf[40];
  snprintf(buf, sizeof(buf), "%.0f", value);
  store(path, buf);
}

void JsonPickString::onBool(const char* path, bool value) { store(path, value ? "true" : "false"); }

/* ------------------------------------------------------------------ JsonOut */

JsonOut::JsonOut(char* buf, size_t cap) : _buf(buf), _cap(cap), _len(0), _first(true), _overflow(false) {
  if (_buf && _cap) _buf[0] = 0;
}

void JsonOut::append(const char* text, size_t n) {
  if (!_buf || _cap == 0) return;
  if (_len + n + 1 > _cap) {
    _overflow = true;
    n = (_cap > _len + 1) ? (_cap - _len - 1) : 0;
  }
  if (n) {
    memcpy(_buf + _len, text, n);
    _len += n;
  }
  _buf[_len] = 0;
}

void JsonOut::separate() {
  if (_first) {
    _first = false;
  } else {
    append(",", 1);
  }
}

void JsonOut::beginObject() {
  _first = true;
  append("{", 1);
}

void JsonOut::endObject() {
  _first = false;
  append("}", 1);
}

void JsonOut::beginObjectAt(const char* key) {
  separate();
  append("\"", 1);
  append(key, strlen(key));
  append("\":{", 3);
  _first = true;
}

void JsonOut::beginArrayAt(const char* key) {
  separate();
  append("\"", 1);
  append(key, strlen(key));
  append("\":[", 3);
  _first = true;
}

void JsonOut::endArray() {
  _first = false;
  append("]", 1);
}

void JsonOut::raw(const char* text) { append(text, strlen(text)); }

void JsonOut::kvString(const char* key, const char* value) {
  separate();
  append("\"", 1);
  append(key, strlen(key));
  append("\":\"", 3);
  char esc[8];
  for (const char* p = value ? value : ""; *p; ++p) {
    const unsigned char c = (unsigned char)*p;
    switch (c) {
      case '"': append("\\\"", 2); break;
      case '\\': append("\\\\", 2); break;
      case '\n': append("\\n", 2); break;
      case '\r': append("\\r", 2); break;
      case '\t': append("\\t", 2); break;
      default:
        if (c < 0x20) {
          snprintf(esc, sizeof(esc), "\\u%04x", c);
          append(esc, 6);
        } else {
          append((const char*)&c, 1);
        }
    }
  }
  append("\"", 1);
}

void JsonOut::kvStringTrunc(const char* key, const char* value, size_t maxLen) {
  char tmp[96];
  if (!value) {
    kvString(key, "");
    return;
  }
  if (strlen(value) <= maxLen) {
    kvString(key, value);
    return;
  }
  const size_t n = (maxLen < sizeof(tmp) - 1) ? maxLen : sizeof(tmp) - 1;
  memcpy(tmp, value, n);
  tmp[n] = 0;
  kvString(key, tmp);
}

void JsonOut::kvLong(const char* key, long value) {
  char buf[24];
  snprintf(buf, sizeof(buf), "%ld", value);
  separate();
  append("\"", 1);
  append(key, strlen(key));
  append("\":", 2);
  append(buf, strlen(buf));
}

void JsonOut::kvULong(const char* key, unsigned long value) {
  char buf[24];
  snprintf(buf, sizeof(buf), "%lu", value);
  separate();
  append("\"", 1);
  append(key, strlen(key));
  append("\":", 2);
  append(buf, strlen(buf));
}

void JsonOut::kvDouble(const char* key, double value, uint8_t decimals) {
  char buf[40];
  snprintf(buf, sizeof(buf), "%.*f", (int)decimals, value);
  separate();
  append("\"", 1);
  append(key, strlen(key));
  append("\":", 2);
  append(buf, strlen(buf));
}

void JsonOut::kvBool(const char* key, bool value) {
  separate();
  append("\"", 1);
  append(key, strlen(key));
  append("\":", 2);
  append(value ? "true" : "false", value ? 4 : 5);
}

void JsonOut::kvNull(const char* key) {
  separate();
  append("\"", 1);
  append(key, strlen(key));
  append("\":null", 6);
}

/* ------------------------------------------------------------------ helpers */

void arsinJsonEscape(const char* in, char* out, size_t cap) {
  if (!out || cap == 0) return;
  size_t o = 0;
  for (const char* p = in ? in : ""; *p && o + 1 < cap; ++p) {
    const unsigned char c = (unsigned char)*p;
    if (c == '"' || c == '\\') {
      if (o + 2 >= cap) break;
      out[o++] = '\\';
      out[o++] = (char)c;
    } else if (c < 0x20) {
      out[o++] = ' ';
    } else {
      out[o++] = (char)c;
    }
  }
  out[o] = 0;
}

void arsinHexEncode(const uint8_t* data, size_t len, char* out, size_t cap, bool spaced) {
  static const char* digits = "0123456789ABCDEF";
  size_t o = 0;
  if (!out || cap == 0) return;
  for (size_t i = 0; i < len; i++) {
    const size_t need = spaced ? 3 : 2;
    if (o + need >= cap) break;
    out[o++] = digits[(data[i] >> 4) & 0x0F];
    out[o++] = digits[data[i] & 0x0F];
    if (spaced) out[o++] = ' ';
  }
  if (o > 0 && spaced) o--; /* drop the trailing separator */
  out[o] = 0;
}

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

size_t arsinHexDecode(const char* text, uint8_t* out, size_t cap) {
  if (!text || !out) return 0;
  size_t written = 0;
  int high = -1;
  for (const char* p = text; *p && written < cap; ++p) {
    const int nib = hexNibble(*p);
    if (nib < 0) {
      high = -1; /* a separator or a lone nibble: restart the pair */
      continue;
    }
    if (high < 0) {
      high = nib;
    } else {
      out[written++] = (uint8_t)((high << 4) | nib);
      high = -1;
    }
  }
  return written;
}
