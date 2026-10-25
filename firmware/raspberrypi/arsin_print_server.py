#!/usr/bin/env python3
"""Arsin Print Server - Raspberry Pi / Linux print bridge.

A dependency free (standard library only, Python 3.9+) print server that exposes
exactly the same REST contract as the ESP32 and ESP8266 firmware, so the web
application in this repository can talk to any of the three builds:

    GET  /api/health           GET  /api/info            GET  /api/status
    GET  /api/config           POST /api/config          POST /api/print
    POST /api/command          POST /api/raw             GET  /api/serial
    GET  /api/logs             POST /api/wifi/scan       GET  /api/wifi
    POST /api/wifi             POST /api/ap              POST /api/reboot
    POST /api/factory-reset    POST /api/ota             GET  /api/backup
    POST /api/backup           POST /api/counters/reset  GET  /events
    GET  /                     static web application + raw TCP print server

Printer transports: serial (termios), USB device files (/dev/usb/lp*), CUPS
(`lp -o raw`) and network (raw socket).  Run with --no-printer for a dry run
that accepts jobs and reports a simulated printer.

Usage:
    python3 arsin_print_server.py --config config.example.json --port 8099 --no-printer
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import re
import select
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import termios
import threading
import time
import urllib.parse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Deque, Dict, List, Optional, Tuple

VERSION = "1.0.0"
DEVICE = "arsin_print_server"
APP_ID = "print-server-cups"
MDNS_NAME = "arsin_print_server.local"
MDNS_HOST = "arsin-print-server"
DEFAULT_CONFIG_PATHS = (
    "/etc/arsin-print-server/config.json",
    "/opt/arsin-print-server/config.json",
    "config.json",
)

# --------------------------------------------------------------------- config

DEFAULT_CONFIG: Dict[str, Any] = {
    "device": {"name": "arsin-print-01", "owner": "", "location": "", "notes": ""},
    "ap": {"enabled": False, "ssid": "arsin_print_server", "password": "arsin1234", "ip": "192.168.4.1"},
    "sta": {
        "enabled": True,
        "ssid": "",
        "password": "",
        "dhcp": True,
        "ip": "",
        "gateway": "",
        "subnet": "",
        "dns": "",
        "hostname": MDNS_HOST,
        "alwaysReconnect": True,
        "saved": [],
    },
    "printer": {
        "name": "Generic ESC/POS",
        "model": "",
        "language": "escpos",
        "profile": "receipt",
        "transport": "usbhost",
        "device": "/dev/usb/lp0",
        "cupsQueue": "",
        "networkHost": "",
        "networkPort": 9100,
        "baud": 115200,
        "dataBits": 8,
        "parity": "none",
        "stopBits": 1,
        "flowControl": "none",
        "widthMm": 80,
        "dpi": 203,
        "cut": True,
        "charset": "cp437",
        "darkness": 8,
        "speed": 4,
        "mediaType": "gap",
        "strobeDelayUs": 3,
    },
    "bt": {"enabled": False, "name": "arsin_print_server", "pin": "0000", "ble": False},
    "usbHost": {"enabled": True, "autoDetect": True, "maxPowerMa": 500},
    "network": {"rawPort": 9100, "webPort": 80, "mdns": True, "telnetDebug": False, "keepAlive": True},
    "security": {"webPassword": "", "apiKey": "", "allowCors": True},
    "logging": {"level": "info", "bufferLines": 200},
    "cloud": {"webhookUrl": "", "onJob": False, "ntpServer": "pool.ntp.org", "timezone": "UTC"},
}

BAUD_RATES = (4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 921600)
LANGUAGES = ("escpos", "zpl", "tspl", "epl", "cpcl", "starprnt", "escp", "ipl", "dpl", "plain")
TRANSPORTS = ("serial", "usbhost", "cups", "network", "uart")
MEDIA_TYPES = ("gap", "blackmark", "continuous")
LOG_LEVELS = ("debug", "info", "warn", "error")


def _deep_merge(base: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    """Merge `extra` into a copy of `base`, keeping unknown keys (forward compat)."""
    out = dict(base)
    for key, value in (extra or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _clamp_number(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def _as_bool(value: Any, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(value, (int, float)):
        return bool(value)
    return fallback


def _as_str(value: Any, max_len: int = 64) -> str:
    if value is None:
        return ""
    return str(value)[:max_len]


def validate_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Clamp every value so a bad config file can never break a driver."""
    printer = cfg["printer"]
    printer["language"] = printer.get("language") if printer.get("language") in LANGUAGES else "escpos"
    if printer.get("transport") not in TRANSPORTS:
        printer["transport"] = "usbhost"
    if printer.get("mediaType") not in MEDIA_TYPES:
        printer["mediaType"] = "gap"
    if int(_clamp_number(printer.get("baud"), 1200, 1000000, 115200)) not in BAUD_RATES:
        printer["baud"] = 115200
    else:
        printer["baud"] = int(printer["baud"])
    printer["dataBits"] = int(_clamp_number(printer.get("dataBits"), 5, 8, 8))
    if str(printer.get("parity")) not in ("none", "even", "odd", "mark", "space"):
        printer["parity"] = "none"
    printer["stopBits"] = int(_clamp_number(printer.get("stopBits"), 1, 2, 1))
    if str(printer.get("flowControl")) not in ("none", "rtscts", "xonxoff"):
        printer["flowControl"] = "none"
    printer["widthMm"] = int(_clamp_number(printer.get("widthMm"), 40, 220, 80))
    printer["dpi"] = int(_clamp_number(printer.get("dpi"), 180, 600, 203))
    printer["darkness"] = int(_clamp_number(printer.get("darkness"), 0, 15, 8))
    printer["speed"] = int(_clamp_number(printer.get("speed"), 1, 14, 4))
    printer["strobeDelayUs"] = int(_clamp_number(printer.get("strobeDelayUs"), 1, 1000, 3))
    printer["networkPort"] = int(_clamp_number(printer.get("networkPort"), 1, 65535, 9100))
    printer["device"] = _as_str(printer.get("device"), 120) or "/dev/usb/lp0"
    printer["cupsQueue"] = _as_str(printer.get("cupsQueue"), 120)
    printer["networkHost"] = _as_str(printer.get("networkHost"), 120)
    printer["cut"] = _as_bool(printer.get("cut"), True)

    network = cfg["network"]
    network["rawPort"] = int(_clamp_number(network.get("rawPort"), 1, 65535, 9100))
    network["webPort"] = int(_clamp_number(network.get("webPort"), 1, 65535, 80))
    for key in ("mdns", "telnetDebug", "keepAlive"):
        network[key] = _as_bool(network.get(key), key != "telnetDebug")

    logging_cfg = cfg["logging"]
    if logging_cfg.get("level") not in LOG_LEVELS:
        logging_cfg["level"] = "info"
    logging_cfg["bufferLines"] = int(_clamp_number(logging_cfg.get("bufferLines"), 20, 2000, 200))

    sta = cfg["sta"]
    sta["hostname"] = _as_str(sta.get("hostname"), 64) or MDNS_HOST
    saved = sta.get("saved")
    if not isinstance(saved, list):
        saved = []
    cleaned: List[Dict[str, str]] = []
    for entry in saved:
        if not isinstance(entry, dict):
            continue
        ssid = _as_str(entry.get("ssid"), 32)
        if not ssid:
            continue
        cleaned.append({"ssid": ssid, "password": _as_str(entry.get("password"), 64)})
    sta["saved"] = cleaned[-5:]
    for key in ("enabled", "dhcp", "alwaysReconnect"):
        sta[key] = _as_bool(sta.get(key), True)

    ap = cfg["ap"]
    ap["enabled"] = _as_bool(ap.get("enabled"), False)
    ap["ssid"] = _as_str(ap.get("ssid"), 32) or "arsin_print_server"
    password = _as_str(ap.get("password"), 63)
    ap["password"] = password if (not password or len(password) >= 8) else "arsin1234"
    ap["ip"] = _as_str(ap.get("ip"), 15) or "192.168.4.1"

    for key in ("enabled", "autoDetect"):
        cfg["usbHost"][key] = _as_bool(cfg["usbHost"].get(key), True)
    cfg["usbHost"]["maxPowerMa"] = int(_clamp_number(cfg["usbHost"].get("maxPowerMa"), 100, 1500, 500))
    cfg["bt"]["enabled"] = False  # the Pi build has no Bluetooth front end
    cfg["security"]["allowCors"] = _as_bool(cfg["security"].get("allowCors"), True)
    cfg["cloud"]["onJob"] = _as_bool(cfg["cloud"].get("onJob"), False)
    for section, keys in (("device", ("name", "owner", "location", "notes")),
                          ("cloud", ("webhookUrl", "ntpServer", "timezone")),
                          ("security", ("webPassword", "apiKey")),
                          ("printer", ("name", "model", "profile"))):
        for key in keys:
            cfg[section][key] = _as_str(cfg[section].get(key), 160)
    if not cfg["device"]["name"]:
        cfg["device"]["name"] = "arsin-print-01"
    return cfg


class ConfigStore:
    """Loads / saves the shared config schema, migration safe and atomic."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.config = validate_config(_deep_merge(DEFAULT_CONFIG, {}))
        self.loaded_from: Optional[str] = None

    def load(self) -> Dict[str, Any]:
        with self.lock:
            candidates = [self.path] if self.path else list(DEFAULT_CONFIG_PATHS)
            for candidate in candidates:
                if not candidate or not os.path.isfile(candidate):
                    continue
                try:
                    with open(candidate, "r", encoding="utf-8") as handle:
                        raw = json.load(handle)
                    if not isinstance(raw, dict):
                        raise ValueError("config root must be an object")
                except (OSError, ValueError) as exc:
                    log("warn", f"config {candidate} rejected: {exc}")
                    continue
                self.config = validate_config(_deep_merge(DEFAULT_CONFIG, raw))
                self.loaded_from = candidate
                log("info", f"config loaded from {candidate}")
                return self.config
            log("info", "no config file found, using defaults")
            return self.config

    def save(self) -> bool:
        with self.lock:
            target = self.path or "/etc/arsin-print-server/config.json"
            try:
                directory = os.path.dirname(target) or "."
                os.makedirs(directory, exist_ok=True)
                tmp = f"{target}.tmp"
                with open(tmp, "w", encoding="utf-8") as handle:
                    json.dump(self.config, handle, indent=2)
                    handle.write("\n")
                os.replace(tmp, target)
                log("info", f"config saved to {target}")
                return True
            except OSError as exc:
                log("error", f"cannot save config: {exc}")
                return False

    def apply(self, document: Any) -> Tuple[bool, str]:
        if not isinstance(document, dict):
            return False, "config must be a JSON object"
        with self.lock:
            self.config = validate_config(_deep_merge(self.config, document))
        return True, ""

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            return json.loads(json.dumps(self.config))


# ------------------------------------------------------------------ log ring

_log_lock = threading.Lock()
_log_entries: Deque[Dict[str, Any]] = deque(maxlen=2000)
_log_seq = 0
_log_level = 1
_log_console = True

_LEVELS = {"debug": 0, "info": 1, "warn": 2, "error": 3}


def log(level: str, message: str) -> None:
    """Append to the in-memory ring buffer (served by /api/logs) + stdout."""
    global _log_seq
    if _LEVELS.get(level, 1) < _log_level:
        return
    with _log_lock:
        _log_seq += 1
        entry = {"t": int(time.time() * 1000), "level": level, "msg": message[:400], "seq": _log_seq}
        _log_entries.append(entry)
    if _log_console:
        print(f"[{level}] {message}", flush=True)


def set_log_level(level: str) -> None:
    global _log_level
    _log_level = _LEVELS.get(level, 1)


def set_log_buffer(lines: int) -> None:
    global _log_entries
    with _log_lock:
        entries = list(_log_entries)[-lines:]
        _log_entries = deque(entries, maxlen=max(20, lines))


def logs_since(cursor: int) -> Tuple[List[Dict[str, Any]], int]:
    with _log_lock:
        entries = [entry for entry in _log_entries if entry["seq"] > cursor]
    next_cursor = entries[-1]["seq"] if entries else cursor
    return entries, next_cursor


# ------------------------------------------------------------ serial ring

_serial_lock = threading.Lock()
_serial_ring = bytearray()
_serial_cursor = 0
SERIAL_RING_MAX = 8192


def serial_push(data: bytes) -> None:
    global _serial_cursor
    if not data:
        return
    with _serial_lock:
        _serial_ring.extend(data)
        if len(_serial_ring) > SERIAL_RING_MAX:
            del _serial_ring[: len(_serial_ring) - SERIAL_RING_MAX]
        _serial_cursor += len(data)


def serial_since(cursor: int) -> Tuple[str, int]:
    with _serial_lock:
        total = _serial_cursor
        available = len(_serial_ring)
        oldest = total - available
        start = max(cursor, oldest)
        if start > total:
            start = total
        chunk = bytes(_serial_ring[start - oldest :])
    return " ".join(f"{byte:02X}" for byte in chunk), start + len(chunk)


def serial_reset() -> None:
    global _serial_cursor
    with _serial_lock:
        _serial_ring.clear()
        _serial_cursor = 0


# ---------------------------------------------------------------- transports


class Transport:
    """Base class for every printer transport (serial, USB, CUPS, network)."""

    name = "none"
    can_read = False

    def open(self) -> bool:
        return False

    def close(self) -> None:
        pass

    def write(self, data: bytes) -> int:
        return 0

    def read(self, max_bytes: int = 256) -> bytes:
        return b""

    def describe(self) -> str:
        return self.name


_BAUD_CONSTANTS = {
    4800: termios.B4800,
    9600: termios.B9600,
    19200: termios.B19200,
    38400: termios.B38400,
    57600: termios.B57600,
    115200: termios.B115200,
    230400: getattr(termios, "B230400", termios.B115200),
    460800: getattr(termios, "B460800", termios.B115200),
    921600: getattr(termios, "B921600", termios.B115200),
}


class NullTransport(Transport):
    """--no-printer: accepts everything, prints nothing (used by the tests)."""

    name = "simulated"
    can_read = True

    def open(self) -> bool:
        return True

    def write(self, data: bytes) -> int:
        return len(data)

    def read(self, max_bytes: int = 256) -> bytes:
        return b""

    def describe(self) -> str:
        return "simulated (--no-printer)"


class SerialTransport(Transport):
    """Raw termios serial port (no pyserial dependency)."""

    name = "uart"
    can_read = True

    def __init__(self, printer_cfg: Dict[str, Any]) -> None:
        self.cfg = printer_cfg
        self.fd: Optional[int] = None
        self.path = printer_cfg.get("device") or "/dev/ttyUSB0"

    def open(self) -> bool:
        if self.fd is not None:
            return True
        try:
            fd = os.open(self.path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        except OSError as exc:
            log("warn", f"serial: cannot open {self.path}: {exc}")
            return False
        try:
            self._configure(fd)
        except OSError as exc:
            log("warn", f"serial: cannot configure {self.path}: {exc}")
            os.close(fd)
            return False
        self.fd = fd
        log("info", f"serial: {self.path} open at {self.cfg.get('baud')} baud")
        return True

    def _configure(self, fd: int) -> None:
        data_bits = int(self.cfg.get("dataBits", 8))
        parity = str(self.cfg.get("parity", "none"))
        stop_bits = int(self.cfg.get("stopBits", 1))
        flow = str(self.cfg.get("flowControl", "none"))
        baud = int(self.cfg.get("baud", 115200))

        attrs = termios.tcgetattr(fd)
        iflag, oflag, cflag, lflag = attrs[0], attrs[1], attrs[2], attrs[3]
        cc = attrs[6]
        iflag = termios.IGNPAR
        oflag = 0
        lflag = 0
        cflag = termios.CREAD | termios.CLOCAL
        cflag |= {5: termios.CS5, 6: termios.CS6, 7: termios.CS7, 8: termios.CS8}.get(data_bits, termios.CS8)
        if parity == "even":
            cflag |= termios.PARENB
        elif parity == "odd":
            cflag |= termios.PARENB | termios.PARODD
        if stop_bits == 2:
            cflag |= termios.CSTOPB
        if flow == "rtscts":
            cflag |= termios.CRTSCTS
        elif flow == "xonxoff":
            iflag |= termios.IXON | termios.IXOFF
        speed = _BAUD_CONSTANTS.get(baud, termios.B115200)
        cc = list(cc)
        cc[termios.VMIN] = 0
        cc[termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, speed, speed, cc])

    def close(self) -> None:
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None

    def write(self, data: bytes) -> int:
        if self.fd is None:
            return 0
        total = 0
        while total < len(data):
            try:
                total += os.write(self.fd, data[total:])
            except BlockingIOError:
                select.select([], [self.fd], [], 0.5)
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    select.select([], [self.fd], [], 0.5)
                    continue
                log("warn", f"serial: write failed: {exc}")
                break
        return total

    def read(self, max_bytes: int = 256) -> bytes:
        if self.fd is None:
            return b""
        try:
            ready, _, _ = select.select([self.fd], [], [], 0)
            if not ready:
                return b""
            return os.read(self.fd, max_bytes)
        except OSError:
            return b""

    def describe(self) -> str:
        return f"{self.path} @ {self.cfg.get('baud')} baud"


class UsbTransport(Transport):
    """USB printer via the kernel's usblp character device (/dev/usb/lp0)."""

    name = "usbhost"
    can_read = True

    def __init__(self, printer_cfg: Dict[str, Any]) -> None:
        self.cfg = printer_cfg
        self.fd: Optional[int] = None
        self.path = printer_cfg.get("device") or "/dev/usb/lp0"

    @staticmethod
    def autodetect() -> Optional[str]:
        for index in range(4):
            candidate = f"/dev/usb/lp{index}"
            if os.path.exists(candidate):
                return candidate
        return None

    def open(self) -> bool:
        if self.fd is not None:
            return True
        if bool(self.cfg.get("autoDetect", True)) and not os.path.exists(self.path):
            detected = self.autodetect()
            if detected:
                log("info", f"usb: {self.path} missing, using detected {detected}")
                self.path = detected
        try:
            self.fd = os.open(self.path, os.O_RDWR | os.O_NONBLOCK)
        except OSError as exc:
            log("warn", f"usb: cannot open {self.path}: {exc}")
            return False
        log("info", f"usb: printer open on {self.path}")
        return True

    def close(self) -> None:
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None

    def write(self, data: bytes) -> int:
        if self.fd is None:
            return 0
        total = 0
        while total < len(data):
            try:
                total += os.write(self.fd, data[total:])
            except BlockingIOError:
                select.select([], [self.fd], [], 1.0)
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    select.select([], [self.fd], [], 1.0)
                    continue
                log("warn", f"usb: write failed: {exc}")
                break
        return total

    def read(self, max_bytes: int = 256) -> bytes:
        if self.fd is None:
            return b""
        try:
            ready, _, _ = select.select([self.fd], [], [], 0)
            if not ready:
                return b""
            return os.read(self.fd, max_bytes)
        except OSError:
            return b""

    def describe(self) -> str:
        return self.path


class CupsTransport(Transport):
    """Hand the job to CUPS with `lp -d <queue> -o raw -` (optional install)."""

    name = "cups"

    def __init__(self, printer_cfg: Dict[str, Any]) -> None:
        self.queue = printer_cfg.get("cupsQueue") or ""
        self.available = shutil.which("lp") is not None
        self.process: Optional[subprocess.Popen] = None

    def open(self) -> bool:
        if not self.available:
            log("warn", "cups: the `lp` client is not installed")
            return False
        if not self.queue:
            self.queue = self._default_queue()
            if not self.queue:
                log("warn", "cups: no CUPS queue configured or discoverable")
                return False
        log("info", f"cups: using queue {self.queue}")
        return True

    @staticmethod
    def _default_queue() -> str:
        try:
            output = subprocess.run(["lpstat", "-a"], capture_output=True, text=True, timeout=5)
            for line in output.stdout.splitlines():
                name = line.split(" ", 1)[0].strip()
                if name:
                    return name
        except (OSError, subprocess.SubprocessError):
            return ""
        return ""

    def close(self) -> None:
        if self.process and self.process.poll() is None:
            try:
                if self.process.stdin:
                    self.process.stdin.close()
                self.process.wait(timeout=5)
            except (OSError, subprocess.SubprocessError):
                pass
        self.process = None

    def write(self, data: bytes) -> int:
        if not self.available or not self.queue:
            return 0
        if self.process is None or self.process.poll() is not None:
            try:
                self.process = subprocess.Popen(
                    ["lp", "-d", self.queue, "-o", "raw", "-t", "arsin-print-server", "-"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except OSError as exc:
                log("warn", f"cups: cannot start lp: {exc}")
                return 0
        if self.process.stdin is None:
            return 0
        try:
            self.process.stdin.write(data)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            log("warn", f"cups: job failed: {exc}")
            self.process = None
            return 0
        return len(data)

    def describe(self) -> str:
        return f"cups queue {self.queue or '(auto)'}"


class NetworkTransport(Transport):
    """Raw socket to a network attached printer (usually port 9100)."""

    name = "network"
    can_read = True

    def __init__(self, printer_cfg: Dict[str, Any]) -> None:
        self.host = printer_cfg.get("networkHost") or ""
        self.port = int(printer_cfg.get("networkPort", 9100))
        self.sock: Optional[socket.socket] = None

    def open(self) -> bool:
        if self.sock is not None:
            return True
        if not self.host:
            return False
        try:
            sock = socket.create_connection((self.host, self.port), timeout=4)
            sock.setblocking(False)
            self.sock = sock
        except OSError as exc:
            log("warn", f"network: cannot reach {self.host}:{self.port}: {exc}")
            return False
        log("info", f"network: printer {self.host}:{self.port} connected")
        return True

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def write(self, data: bytes) -> int:
        if self.sock is None:
            return 0
        total = 0
        while total < len(data):
            try:
                total += self.sock.send(data[total:])
            except BlockingIOError:
                select.select([], [self.sock], [], 1.0)
            except OSError as exc:
                log("warn", f"network: write failed: {exc}")
                self.close()
                break
        return total

    def read(self, max_bytes: int = 256) -> bytes:
        if self.sock is None:
            return b""
        try:
            ready, _, _ = select.select([self.sock], [], [], 0)
            if not ready:
                return b""
            return self.sock.recv(max_bytes)
        except OSError:
            return b""

    def describe(self) -> str:
        return f"{self.host}:{self.port}"


def build_transport(cfg: Dict[str, Any], no_printer: bool) -> Transport:
    """Map printer.transport onto a concrete driver."""
    if no_printer:
        return NullTransport()
    printer = cfg["printer"]
    transport = str(printer.get("transport", "usbhost"))
    if transport in ("usbhost", "usb"):
        if bool(printer.get("autoDetect", True)) and not os.path.exists(str(printer.get("device", ""))):
            detected = UsbTransport.autodetect()
            if detected:
                printer["device"] = detected
        return UsbTransport(printer)
    if transport == "cups":
        return CupsTransport(printer)
    if transport == "network":
        return NetworkTransport(printer)
    return SerialTransport(printer)


# ------------------------------------------------------------- printer worker


class Printer:
    """Non blocking print queue plus a worker thread that drives the transport."""

    MAX_QUEUE_BYTES = 1 << 20  # 1 MiB of back pressure, the same idea as the firmware ring

    def __init__(self, store: ConfigStore, no_printer: bool = False) -> None:
        self.store = store
        self.no_printer = no_printer
        self.lock = threading.RLock()
        self.cv = threading.Condition(self.lock)
        self.queue: Deque[bytes] = deque()
        self.queue_bytes = 0
        self.transport: Transport = build_transport(store.config, no_printer)
        self.opened = False
        self.state = "idle"
        self.health = "offline"
        self.last_reply = ""
        self.last_job = ""
        self.jobs = 0
        self.bytes = 0
        self.errors = 0
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.last_write = 0.0
        self.last_open_attempt = 0.0
        self.last_reply_at = 0.0

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self.running:
            return
        self.running = True
        self.thread = threading.Thread(target=self._worker, name="arsin-printer", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.running = False
        with self.cv:
            self.cv.notify_all()
        if self.thread:
            self.thread.join(timeout=3)
        self.transport.close()
        self.opened = False

    def reconfigure(self) -> None:
        with self.lock:
            self.transport.close()
            self.transport = build_transport(self.store.config, self.no_printer)
            self.opened = False
            self.last_open_attempt = 0.0

    # ------------------------------------------------------------- queueing
    def submit(self, data: bytes) -> int:
        """Queue as much of `data` as fits; returns the accepted byte count."""
        if not data:
            return 0
        with self.cv:
            room = self.MAX_QUEUE_BYTES - self.queue_bytes
            accepted = min(room, len(data))
            if accepted > 0:
                self.queue.append(bytes(data[:accepted]))
                self.queue_bytes += accepted
                self.state = "printing"
                self.cv.notify_all()
        if accepted < len(data):
            with self.lock:
                self.errors += 1
            log("warn", f"printer: queue full, dropped {len(data) - accepted} byte(s)")
        return accepted

    def submit_all(self, data: bytes, timeout: float = 10.0) -> int:
        """Queue everything, waiting for back pressure to clear."""
        sent = 0
        deadline = time.time() + timeout
        while sent < len(data):
            sent += self.submit(data[sent:])
            if sent >= len(data) or time.time() > deadline:
                break
            with self.cv:
                self.cv.wait(0.05)
        return sent

    def flush(self, timeout: float = 10.0) -> bool:
        """Wait until everything queued has been handed to the printer."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                if self.queue_bytes == 0:
                    return True
            time.sleep(0.02)
        with self.lock:
            return self.queue_bytes == 0

    def queue_depth(self) -> int:
        with self.lock:
            return self.queue_bytes

    # ---------------------------------------------------------------- state
    def connected(self) -> bool:
        with self.lock:
            return self.opened

    def transport_name(self) -> str:
        with self.lock:
            return self.transport.name

    def transport_description(self) -> str:
        with self.lock:
            return self.transport.describe()

    def counters(self) -> Dict[str, int]:
        with self.lock:
            return {"jobs": self.jobs, "bytes": self.bytes, "errors": self.errors}

    def reset_counters(self) -> None:
        with self.lock:
            self.jobs = 0
            self.bytes = 0
            self.errors = 0
        log("info", "printer: counters reset")

    def note_job(self, job_id: str) -> None:
        with self.lock:
            self.jobs += 1
            self.last_job = job_id

    def clear_error(self) -> None:
        with self.lock:
            if self.state == "error" and self.queue_bytes == 0:
                self.state = "idle"

    def request_status(self) -> None:
        """ESC/POS status query - harmless for every other language."""
        if self.store.config["printer"].get("language") == "escpos":
            self.submit(bytes([0x10, 0x04, 0x01, 0x1D, 0x72, 0x01]))

    # --------------------------------------------------------------- worker
    def _ensure_open(self) -> bool:
        with self.lock:
            if self.opened:
                return True
            if time.time() - self.last_open_attempt < 2.0:
                return False
            self.last_open_attempt = time.time()
            opened = self.transport.open()
            self.opened = opened
            self.health = "ok" if opened else "offline"
            if not opened and self.queue_bytes == 0:
                self.state = "idle"
            return opened

    def _poll_replies(self) -> None:
        if not self.transport.can_read:
            return
        try:
            data = self.transport.read(256)
        except Exception:  # pragma: no cover - defensive
            data = b""
        if not data:
            return
        serial_push(data)
        with self.lock:
            self.last_reply = " ".join(f"{byte:02X}" for byte in data[-12:])
            self.last_reply_at = time.time()
            self.health = self._classify(data)

    @staticmethod
    def _classify(data: bytes) -> str:
        """Best effort DLE EOT 1 parsing (bit 6 paper, bit 3 offline, bit 2 cover)."""
        for index in range(max(0, len(data) - 3)):
            if data[index : index + 3] == b"\x10\x04\x01":
                status = data[index + 3]
                if status & 0x40:
                    return "paper-out"
                if status & 0x08:
                    return "offline"
                if status & 0x04:
                    return "cover-open"
                return "ok"
        return "ok"

    def _worker(self) -> None:  # pragma: no cover - thread body
        while self.running:
            chunk: Optional[bytes] = None
            with self.cv:
                if self.queue:
                    chunk = self.queue.popleft()
                    self.queue_bytes -= len(chunk)
                    self.cv.notify_all()
            if chunk is None:
                self._poll_replies()
                with self.cv:
                    self.cv.wait(0.2)
                self._ensure_open()
                with self.lock:
                    if self.queue_bytes == 0 and self.state == "printing" and time.time() - self.last_write > 0.4:
                        self.state = "idle"
                continue

            if not self._ensure_open():
                with self.cv:
                    self.queue.appendleft(chunk)
                    self.queue_bytes += len(chunk)
                    self.cv.wait(0.5)
                continue

            sent = 0
            try:
                sent = self.transport.write(chunk)
            except Exception as exc:  # pragma: no cover - defensive
                log("error", f"printer: transport error: {exc}")
            with self.lock:
                if sent > 0:
                    self.bytes += sent
                    self.last_write = time.time()
                    self.state = "printing"
                    if self.health == "offline":
                        self.health = "ok"
                else:
                    self.errors += 1
                    self.health = "offline"
                    self.opened = False
                    self.transport.close()
                    if self.queue_bytes == 0:
                        self.state = "error"
                if sent < len(chunk):
                    self.queue.appendleft(chunk[sent:])
                    self.queue_bytes += len(chunk) - sent
            self._poll_replies()


# --------------------------------------------------------- command builder

ESC = 0x1B
GS = 0x1D
DLE = 0x10

ACTIONS = (
    "selftest", "status", "config", "initialize", "feed", "cut", "drawer", "calibrate",
    "density", "media", "counter", "resetcounter", "factoryreset", "info", "barcode",
    "nozzlecheck", "headclean", "align", "saveconfig", "barcodetest",
)


def _escpos_test_pattern(title: str) -> bytes:
    out = bytearray([ESC, 0x61, 0x01, ESC, 0x21, 0x10])
    out += (title + "\n").encode("ascii", "replace")
    out += bytes([ESC, 0x21, 0x00])
    out += b"--------------------------------\n"
    for row in range(6):
        out += b"|"
        for col in range(12):
            out += b"# " if (row % 2) == (col % 2) else b". "
        out += b"|\n"
    out += b"--------------------------------\n"
    out += bytes([ESC, 0x64, 0x04, ESC, 0x61, 0x00])
    return bytes(out)


def _escpos_barcode_sheet() -> bytes:
    out = bytearray([ESC, 0x61, 0x01])
    codes = (
        ("CODE39\n", b"ARSIN123", bytes([GS, 0x68, 0x28, GS, 0x77, 0x02, GS, 0x48, 0x02, GS, 0x6B, 0x04])),
        ("EAN13\n", b"400638133393", bytes([GS, 0x68, 0x50, GS, 0x77, 0x02, GS, 0x48, 0x02, GS, 0x6B, 0x02])),
        ("CODE128\n", b"{BARSIN128", bytes([GS, 0x68, 0x50, GS, 0x77, 0x02, GS, 0x48, 0x02, GS, 0x6B, 0x49])),
    )
    for hri, data, command in codes:
        out += hri.encode("ascii")
        out += command
        out += data + b"\x00"
    out += b"QR CODE\n"
    out += bytes([GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00])
    out += bytes([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x06])
    out += bytes([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31])
    out += bytes([GS, 0x28, 0x6B, 0x0A, 0x00, 0x31, 0x50, 0x30]) + b"ARSIN-PS\x00"
    out += bytes([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30])
    out += bytes([ESC, 0x64, 0x04, ESC, 0x61, 0x00])
    return bytes(out)


def _params(raw: Any) -> Dict[str, Any]:
    values: Dict[str, Any] = {
        "lines": 3,
        "copies": 1,
        "darkness": 8,
        "speed": 4,
        "media": "gap",
        "cutter": "full",
        "pattern": "standard",
        "data": "ARSIN-PS",
    }
    if isinstance(raw, dict):
        for key in ("lines", "dots", "copies", "darkness", "density", "speed", "height", "width"):
            if key in raw:
                try:
                    values["lines" if key == "dots" else key] = int(raw[key])
                except (TypeError, ValueError):
                    pass
        for key in ("media", "cutter", "pattern", "data", "text", "symbology"):
            if key in raw:
                values["data" if key == "text" else key] = str(raw[key])[:64]
    values["lines"] = max(1, min(255, values["lines"]))
    values["copies"] = max(1, min(20, values["copies"]))
    values["darkness"] = max(0, min(15, values["darkness"]))
    return values


def _escpos(action: str, p: Dict[str, Any]) -> Tuple[Optional[bytes], str]:
    if action == "selftest":
        return bytes([ESC, 0x40, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x00]), "GS ( A execute printer test"
    if action == "status":
        return bytes([DLE, 0x04, 0x01, GS, 0x72, 0x01]), "DLE EOT 1 + GS r 1, reply in /api/serial"
    if action in ("config", "counter"):
        return bytes([ESC, 0x40, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x01]), "GS ( A m=1 status sheet"
    if action == "initialize":
        return bytes([ESC, 0x40]), "ESC @ initialise printer"
    if action == "feed":
        return bytes([ESC, 0x64, p["lines"]]), f"ESC d {p['lines']} feed"
    if action == "cut":
        mode = 0x01 if p["cutter"] == "partial" else 0x00
        return bytes([ESC, 0x64, 0x03, GS, 0x56, mode]), f"{p['cutter']} cut (GS V {mode})"
    if action == "drawer":
        return bytes([ESC, 0x70, 0x00, 0x19, 0xFA]), "ESC p 0 25 250 drawer kick"
    if action == "headclean":
        return bytes([ESC, 0x40]) + _escpos_test_pattern("ESC/POS head test"), "head-wear test pattern"
    if action == "nozzlecheck":
        return bytes([ESC, 0x40]) + _escpos_test_pattern("Nozzle check"), "12x6 nozzle grid"
    if action == "align":
        return bytes([ESC, 0x40]) + _escpos_test_pattern("Alignment / paper sensor"), "alignment pattern"
    if action == "calibrate":
        mode = 0x02 if p["media"] == "blackmark" else 0x01
        return bytes([ESC, 0x40, GS, 0x28, 0x45, 0x02, 0x00, 0x00, mode]), f"media sensor preset ({p['media']})"
    if action == "resetcounter":
        return bytes([ESC, 0x40, GS, 0x28, 0x58, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00]), "GS ( X reset trip counters"
    if action == "density":
        return bytes([ESC, 0x40, GS, 0x28, 0x4B, 0x02, 0x00, 0x30, p["darkness"]]), f"density {p['darkness']}"
    if action == "media":
        mode = {"blackmark": 0x02, "continuous": 0x03}.get(p["media"], 0x01)
        return bytes([ESC, 0x40, GS, 0x28, 0x45, 0x02, 0x00, 0x00, mode]), f"media type {p['media']}"
    if action == "saveconfig":
        return bytes([ESC, 0x40, GS, 0x28, 0x4B, 0x02, 0x00, 0x31, 0x01]), "store settings in printer NV memory"
    if action == "factoryreset":
        return bytes([ESC, 0x40, GS, 0x28, 0x58, 0x04, 0x00, 0x00, 0x00]), "GS ( X factory values"
    if action == "info":
        return bytes([ESC, 0x40, GS, 0x49, 0x31, GS, 0x28, 0x41, 0x02, 0x00, 0x01, 0x01]), "GS I 1 + GS ( A"
    if action in ("barcode", "barcodetest"):
        return bytes([ESC, 0x40]) + _escpos_barcode_sheet(), "CODE39 + EAN13 + CODE128 + QR sheet"
    return None, ""


def _zpl(action: str, p: Dict[str, Any]) -> Tuple[Optional[bytes], str]:
    data = p["data"]
    if action in ("selftest", "config"):
        return b"~WC", "~WC configuration label"
    if action in ("status", "info"):
        return b"~HS", "~HS host status query"
    if action == "initialize":
        return b"^XA^XZ", "^XA^XZ clears the format buffer"
    if action == "feed":
        return f"^XA^FO0,0^GB1,{p['lines'] * 8},1^FS^XZ".encode(), "blank label to advance media"
    if action == "cut":
        return b"^XA^CN1^XZ", "^CN1 cut now"
    if action == "calibrate":
        return b"^XA^JUC^XZ", "^JUC auto-calibrate"
    if action == "density":
        return f"^XA^MD{(p['darkness'] - 8) * 2}^XZ".encode(), "^MD darkness"
    if action == "media":
        code = {"blackmark": "M", "continuous": "Y"}.get(p["media"], "N")
        return f"^XA^MN{code}^XZ".encode(), f"^MN media tracking ({p['media']})"
    if action == "counter":
        return b"~HQES", "~HQES odometer query"
    if action == "resetcounter":
        return b"~JR", "~JR reset printer"
    if action == "factoryreset":
        return b"^XA^JUF^XZ", "^JUF factory defaults"
    if action == "drawer":
        return b"^XA^XZ", "ZPL printers have no cash drawer port"
    if action in ("barcode", "barcodetest"):
        return f"^XA^FO40,40^BY3^BCN,80,Y,N,N^FD{data}^FS^FO40,180^BQN,2,6^FDLA,{data}^FS^XZ".encode(), "Code128 + QR label"
    if action in ("nozzlecheck", "headclean", "align"):
        title = {"nozzlecheck": "NOZZLE CHECK", "headclean": "HEAD TEST"}.get(action, "ALIGNMENT")
        return f"^XA^CI28^PW600^LL400^FO30,30^A0N,32,32^FD{title}^FS^FO30,80^GB540,4,4^FS^PQ1^XZ".encode(), "ZPL test label"
    return None, ""


def _tspl(action: str, p: Dict[str, Any]) -> Tuple[Optional[bytes], str]:
    media = {"blackmark": "BLINE 3 mm,0\r\n", "continuous": "GAP 0,0\r\n"}.get(p["media"], "GAP 2 mm,0\r\n")
    if action in ("selftest", "config"):
        return b"SELFTEST\r\n", "SELFTEST configuration page"
    if action in ("status", "info", "counter"):
        return b"\x1b!?", "ESC !? status query"
    if action == "initialize":
        return b"CLS\r\n", "CLS clears the image buffer"
    if action == "feed":
        return f"FEED {p['lines'] * 8}\r\n".encode(), "FEED advances the media"
    if action == "cut":
        return b"CUT\r\n", "CUT (cutter equipped models)"
    if action == "calibrate":
        return (media + "GAPDETECT\r\n").encode(), "media calibration"
    if action == "density":
        return f"DENSITY {p['darkness']}\r\n".encode(), "DENSITY"
    if action == "media":
        return media.encode(), f"media sensor setup ({p['media']})"
    if action in ("resetcounter", "factoryreset"):
        return b"INITIALPRINTER\r\n", "INITIALPRINTER factory defaults"
    if action == "drawer":
        return b"\x07", "BEL pulse"
    if action in ("barcode", "barcodetest"):
        return f'SIZE 80 mm,60 mm\r\nGAP 2 mm,0\r\nCLS\r\nBARCODE 10,10,"128",90,1,0,2,4,"{p["data"]}"\r\nPRINT 1\r\n'.encode(), "TSPL Code128 label"
    if action in ("nozzlecheck", "headclean", "align"):
        return b'SIZE 80 mm,60 mm\r\nGAP 2 mm,0\r\nCLS\r\nTEXT 10,10,"3",0,1,1,"TEST"\r\nPRINT 1\r\n', "TSPL test label"
    return None, ""


def _epl(action: str, p: Dict[str, Any]) -> Tuple[Optional[bytes], str]:
    if action in ("selftest", "config", "info"):
        return b"N\r\nU\r\nP1\r\n", "blank label (EPL self test is front panel)"
    if action in ("status", "counter"):
        return b"\x1b!?", "ESC !? status query"
    if action == "initialize":
        return b"N\r\n", "N clears the image buffer"
    if action == "feed":
        return b"U\r\n", "U feeds one label"
    if action == "cut":
        return b"N\r\nP1\r\n", "print a blank label"
    if action == "density":
        return f"D{p['darkness']}\r\n".encode(), "D density"
    if action in ("media", "calibrate"):
        return b"Z\r\n", "Z auto-detects the label length"
    if action in ("resetcounter", "factoryreset"):
        return b"N\r\nZ\r\n", "clear buffer and re-calibrate"
    if action in ("barcode", "barcodetest"):
        return f'N\r\nB10,10,0,1,2,4,80,B,"{p["data"]}"\r\nP1\r\n'.encode(), "EPL Code128 label"
    if action in ("nozzlecheck", "headclean", "align"):
        return b'N\r\nA10,10,0,3,1,1,N,"TEST"\r\nP1\r\n', "EPL test label"
    if action == "drawer":
        return None, "EPL printers have no cash drawer port"
    return None, ""


def _cpcl(action: str, p: Dict[str, Any]) -> Tuple[Optional[bytes], str]:
    header = "! 0 200 200 300 1\r\n"
    if action in ("selftest", "config", "nozzlecheck", "headclean", "align"):
        title = {"selftest": "SELF TEST", "config": "CONFIGURATION"}.get(action, "HEAD TEST")
        return (header + f"T 4 0 20 40 {title}\r\nB 128 2 30 140 60 90 ARSIN123\r\nFORM\r\nPRINT\r\n").encode(), "CPCL test label"
    if action in ("status", "info", "counter"):
        return b"\x1b!?", "ESC !? status query"
    if action == "initialize":
        return b"! 0 200 200 300 1\r\nFORM\r\n", "FORM clears the label"
    if action == "feed":
        return (header + "FORM\r\nPRINT\r\n").encode(), "blank label to advance media"
    if action == "cut":
        return (header + "CUT\r\nPRINT\r\n").encode(), "CUT command"
    if action == "density":
        return (header + f"TONE {p['darkness']}\r\nPRINT\r\n").encode(), "TONE density"
    if action in ("media", "calibrate"):
        setup = "GAP 0\r\n" if p["media"] == "continuous" else "GAP-SENSE\r\n"
        return (header + setup + "FORM\r\nPRINT\r\n").encode(), "media sensor setup"
    if action in ("resetcounter", "factoryreset"):
        return b"! U1 reset\r\n", "CPCL reset"
    if action in ("barcode", "barcodetest"):
        return (header + f"B 128 2 30 40 80 120 {p['data']}\r\nFORM\r\nPRINT\r\n").encode(), "CPCL Code128 label"
    if action == "drawer":
        return b"\x07", "BEL pulse"
    return None, ""


def _star(action: str, p: Dict[str, Any]) -> Tuple[Optional[bytes], str]:
    if action in ("selftest", "config"):
        return bytes([0x1B, 0x40, 0x1B, 0x1E]), "ESC @ + ESC 0x1E Star test print"
    if action in ("status", "info", "counter"):
        return bytes([0x1B, 0x40, 0x1B, 0x05, 0x01]), "ESC 0x05 status request"
    if action == "initialize":
        return bytes([0x1B, 0x40]), "ESC @ initialise printer"
    if action == "feed":
        return bytes([0x1B, 0x61, p["lines"]]), "ESC a n feed"
    if action == "cut":
        return bytes([0x1B, 0x64, 0x02]), "ESC d 2 partial cut"
    if action == "drawer":
        return bytes([0x1B, 0x07, 0x07, 0x07, 0x07]), "ESC BEL drawer kick"
    if action == "density":
        return bytes([0x1B, 0x3D, p["darkness"]]), "ESC = n density"
    if action in ("media", "calibrate"):
        return bytes([0x1B, 0x40, 0x1B, 0x1D, 0x03]), "media sensor re-calibration"
    if action in ("resetcounter", "factoryreset"):
        return bytes([0x1B, 0x40, 0x1B, 0x23, 0x23]), "reset command"
    if action in ("nozzlecheck", "headclean", "align", "barcode", "barcodetest"):
        out = bytes([ESC, 0x40]) + _escpos_test_pattern("STAR TEST")
        if action in ("barcode", "barcodetest"):
            out += _escpos_barcode_sheet()
        return out, "Star line mode test pattern"
    return None, ""


def _escp(action: str, p: Dict[str, Any]) -> Tuple[Optional[bytes], str]:
    if action == "initialize":
        return bytes([ESC, 0x40]), "ESC @ initialise"
    if action == "feed":
        return bytes([ESC, 0x64, p["lines"]]), "ESC d n line feed"
    if action == "cut":
        return bytes([ESC, 0x69]), "ESC i cut / form feed"
    if action == "drawer":
        return bytes([ESC, 0x70, 0x00, 0x19, 0xFA]), "ESC p drawer kick"
    if action == "density":
        return bytes([ESC, 0x45]), "ESC E emphasised print"
    if action in ("status", "counter"):
        return bytes([ESC, 0x40]) + b"STATUS\r\n", "text status page"
    if action in ("media", "calibrate", "resetcounter", "factoryreset"):
        return bytes([ESC, 0x40]), "buffer reset only on ESC/P"
    if action in ("selftest", "config", "info", "nozzlecheck", "headclean", "align", "barcode", "barcodetest"):
        return bytes([ESC, 0x40]) + _escpos_test_pattern("ESC/P test page") + b"\x0c", "ESC/P test page"
    return None, ""


def _plain(action: str, p: Dict[str, Any], device_name: str) -> Tuple[Optional[bytes], str]:
    if action == "feed":
        return b"\n" * p["lines"], "line feeds"
    if action == "cut":
        return b"\x0c", "form feed"
    if action in ("status", "info"):
        return b"ARSIN PRINT SERVER STATUS\n", "plain text status block"
    if action in ("selftest", "config", "nozzlecheck", "headclean", "align", "barcode", "barcodetest"):
        body = f"ARSIN PRINT SERVER\n==================\ndevice : {device_name}\n\n" + "|..........|\n" * 12 + "\n\x0c"
        return body.encode(), "plain text test page"
    if action in ("initialize", "density", "media", "calibrate", "resetcounter", "counter", "factoryreset", "drawer"):
        return None, "no byte sequence defined for plain text printers"
    return None, ""


def build_command(lang: str, action: str, params: Any, device_name: str = "arsin-print-01") -> Tuple[bool, bytes, str]:
    """Return (ok, bytes, note) for one maintenance action."""
    if action not in ACTIONS:
        return False, b"", f"unknown action '{action}'"
    p = _params(params)
    normalized = (lang or "escpos").lower()
    aliases = {"epson": "escpos", "zebra": "zpl", "tspl2": "tspl", "star": "starprnt", "esc/p": "escp", "text": "plain"}
    normalized = aliases.get(normalized, normalized)

    builders = {
        "escpos": lambda: _escpos(action, p),
        "zpl": lambda: _zpl(action, p),
        "tspl": lambda: _tspl(action, p),
        "epl": lambda: _epl(action, p),
        "cpcl": lambda: _cpcl(action, p),
        "starprnt": lambda: _star(action, p),
        "escp": lambda: _escp(action, p),
        "plain": lambda: _plain(action, p, device_name),
    }
    builder = builders.get(normalized)
    if builder is None:
        return False, b"", f"unsupported language '{lang}'"
    data, note = builder()
    if data is None:
        return False, b"", note or f"action '{action}' is not defined for {normalized}"
    if p["copies"] > 1:
        data = data * p["copies"]
    return True, data, note


# ----------------------------------------------------- host / Wi-Fi helpers


def _run(command: List[str], timeout: float = 10.0) -> Tuple[int, str]:
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        return completed.returncode, (completed.stdout or "") + (completed.stderr or "")
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, str(exc)


def _default_interface() -> str:
    code, output = _run(["sh", "-c", "ip route show default 2>/dev/null | awk '{print $5; exit}'"])
    if code == 0 and output.strip():
        return output.strip().splitlines()[0]
    code, output = _run(
        ["sh", "-c", "nmcli -t -f DEVICE,TYPE dev status 2>/dev/null | awk -F: '$2==\"wifi\"{print $1; exit}'"]
    )
    if code == 0 and output.strip():
        return output.strip().splitlines()[0]
    return "wlan0"


def _hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return MDNS_HOST


def _primary_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.settimeout(0.5)
            probe.connect(("192.0.2.1", 9))
            return probe.getsockname()[0]
    except OSError:
        return ""


def _mac_address(interface: str) -> str:
    try:
        with open(f"/sys/class/net/{interface}/address", "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def _board_id() -> str:
    """Map the device tree model onto a catalog board id (rpi-4b, rpi-5, ...)."""
    model = ""
    for path in ("/proc/device-tree/model", "/sys/firmware/devicetree/base/model"):
        try:
            with open(path, "rb") as handle:
                model = handle.read().decode("utf-8", "replace").replace("\x00", "").strip()
        except OSError:
            continue
        if model:
            break
    lowered = model.lower()
    if "raspberry pi 5" in lowered:
        return "rpi-5"
    if "raspberry pi 4" in lowered or "compute module 4" in lowered:
        return "rpi-4b"
    if "zero 2 w" in lowered:
        return "rpi-zero-2-w"
    if "zero w" in lowered or "raspberry pi zero" in lowered:
        return "rpi-zero-w"
    if "raspberry pi 3" in lowered:
        return "rpi-4b"
    return model or "raspberrypi"


def _wifi_link(interface: str) -> Tuple[str, int]:
    """(ssid, rssi) of the current STA link, empty when not associated."""
    code, output = _run(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "dev", "wifi", "list", "--rescan", "no"])
    if code == 0:
        for line in output.splitlines():
            parts = line.split(":")
            if len(parts) >= 3 and parts[0].strip() == "yes":
                try:
                    rssi = int(parts[-1])
                except ValueError:
                    rssi = 0
                return parts[1].strip(), rssi
    code, output = _run(["sh", "-c", f"iw dev {interface} link 2>/dev/null"])
    if code == 0 and "SSID:" in output:
        ssid = ""
        rssi = 0
        for raw in output.splitlines():
            line = raw.strip()
            if line.startswith("SSID:"):
                ssid = line.split(":", 1)[1].strip()
            elif line.startswith("signal:"):
                try:
                    rssi = int(float(line.split()[1]))
                except (ValueError, IndexError):
                    rssi = 0
        return ssid, rssi
    return "", 0


def wifi_scan() -> List[Dict[str, Any]]:
    """Scan for access points with nmcli, then iwlist."""
    networks: List[Dict[str, Any]] = []
    code, output = _run(
        ["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "dev", "wifi", "list", "--rescan", "yes"], timeout=25
    )
    if code == 0 and output.strip():
        for line in output.splitlines():
            parts = line.split(":")
            if len(parts) < 3 or not parts[0].strip():
                continue
            try:
                rssi = int(parts[-2])
            except ValueError:
                continue
            networks.append({"ssid": parts[0].strip(), "rssi": rssi, "secure": parts[-1].strip() not in ("", "--")})
        if networks:
            return networks[:40]

    interface = _default_interface()
    code, output = _run(["sh", "-c", f"iwlist {interface} scan 2>/dev/null"], timeout=25)
    if code == 0 and output.strip():
        current: Dict[str, Any] = {}
        for raw in output.splitlines():
            line = raw.strip()
            if line.startswith("Cell "):
                if current.get("ssid"):
                    networks.append(current)
                current = {"ssid": "", "rssi": 0, "secure": False}
            elif line.startswith("ESSID:"):
                current["ssid"] = line.split(":", 1)[1].strip().strip('"')
            elif line.startswith("Signal level="):
                try:
                    current["rssi"] = int(line.split("=", 1)[1].split()[0])
                except ValueError:
                    pass
            elif "Encryption key:on" in line:
                current["secure"] = True
        if current.get("ssid"):
            networks.append(current)
    if not networks:
        log("warn", "wifi: no scan backend available (install NetworkManager or wireless-tools)")
    return networks[:40]


def wifi_join(ssid: str, password: str, interface: str) -> Tuple[bool, str]:
    if not shutil.which("nmcli"):
        return False, "nmcli (NetworkManager) is required to change the Wi-Fi network on Linux"
    command = ["nmcli", "dev", "wifi", "connect", ssid]
    if password:
        command += ["password", password]
    command += ["ifname", interface]
    code, output = _run(command, timeout=45)
    if code != 0:
        log("warn", f"wifi: join {ssid} failed: {output.strip()[:160]}")
        return False, output.strip()[:160] or "connection failed"
    _run(["nmcli", "con", "modify", ssid, "connection.autoconnect", "yes"])
    log("info", f"wifi: joined {ssid}")
    return True, ""


def wifi_hotspot(ssid: str, password: str, enabled: bool, interface: str) -> Tuple[bool, str]:
    if not shutil.which("nmcli"):
        return False, "nmcli (NetworkManager) is required to run a hotspot on Linux"
    if not enabled:
        code, output = _run(["nmcli", "con", "down", "Hotspot"])
        return code == 0, "" if code == 0 else output.strip()[:160]
    command = ["nmcli", "dev", "wifi", "hotspot", "ifname", interface, "ssid", ssid, "con-name", "Hotspot"]
    if password and len(password) >= 8:
        command += ["password", password]
    code, output = _run(command, timeout=45)
    if code != 0:
        return False, output.strip()[:160] or "hotspot failed"
    log("info", f"wifi: hotspot {ssid} up on {interface}")
    return True, ""


def start_mdns(hostname: str, web_port: int, raw_port: int) -> Tuple[bool, str, List[subprocess.Popen]]:
    """Advertise http://<hostname>.local through avahi-publish when available."""
    publisher = shutil.which("avahi-publish-service") or shutil.which("avahi-publish")
    if not publisher:
        return False, "avahi-publish-service not installed (mDNS advertisement unavailable)", []
    processes: List[subprocess.Popen] = []
    try:
        for service, port in (("_http._tcp", web_port), ("_pdl-datastream._tcp", raw_port)):
            processes.append(
                subprocess.Popen(
                    [publisher, "-s", hostname, service, str(port), "device=arsin_print_server"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            )
    except OSError as exc:
        return False, f"avahi-publish failed: {exc}", processes
    log("info", f"mdns: advertising {hostname}.local (http {web_port}, pdl-datastream {raw_port})")
    return True, "", processes


# ------------------------------------------------------------------ documents


class ServiceState:
    """Everything the REST layer needs in order to answer a request."""

    def __init__(self, store: ConfigStore, printer: Printer, no_printer: bool) -> None:
        self.store = store
        self.printer = printer
        self.no_printer = no_printer
        self.started_at = time.time()
        self.job_seq = 0
        self.job_lock = threading.Lock()
        self.interface = _default_interface()
        self.mdns_ok = False
        self.mdns_note = ""
        self.mdns_processes: List[subprocess.Popen] = []
        self.sse_lock = threading.Lock()
        self.sse_clients = 0
        self.web_root = ""
        self.restart_pending = False

    def next_job_id(self) -> str:
        with self.job_lock:
            self.job_seq += 1
            return f"j{self.job_seq % 1000000:06d}"

    def info_document(self) -> Dict[str, Any]:
        cfg = self.store.config
        ssid, rssi = _wifi_link(self.interface)
        return {
            "device": DEVICE,
            "app": APP_ID,
            "board": _board_id(),
            "version": VERSION,
            "build": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
            "mac": _mac_address(self.interface),
            "ip": _primary_ip(),
            "hostname": _hostname(),
            "transport": self.printer.transport_name(),
            "language": cfg["printer"].get("language", "escpos"),
            "uptimeMs": int((time.time() - self.started_at) * 1000),
            "freeHeap": 0,
            "rssi": rssi if ssid else 0,
            "mdns": MDNS_NAME,
            "wifiMode": "sta" if ssid else "off",
            "platform": "raspberrypi",
            "python": sys.version.split()[0],
            "configPath": self.store.loaded_from or self.store.path or "",
        }

    def status_document(self) -> Dict[str, Any]:
        cfg = self.store.config
        ssid, rssi = _wifi_link(self.interface)
        state = "idle" if self.no_printer else self.printer.state
        return {
            "state": state,
            "printer": {
                "connected": self.printer.connected(),
                "status": "ok" if self.no_printer else self.printer.health,
                "lastReply": self.printer.last_reply,
                "transport": self.printer.transport_name(),
                "description": self.printer.transport_description(),
            },
            "queue": {"depth": self.printer.queue_depth(), "lastJobId": self.printer.last_job},
            "counters": self.printer.counters(),
            "wifi": {"ssid": ssid, "ip": _primary_ip(), "rssi": rssi, "mode": "sta" if ssid else "off"},
            "bt": {
                "enabled": False,
                "connected": False,
                "name": cfg["bt"].get("name", "arsin_print_server"),
                "mode": "off",
                "note": "the Raspberry Pi build has no Bluetooth front end",
            },
            "usb": {
                "connected": self.printer.transport_name() == "usbhost" and self.printer.connected(),
                "vid": "0x0000",
                "pid": "0x0000",
                "manufacturer": "",
                "product": cfg["printer"].get("device", "") if self.printer.transport_name() == "usbhost" else "",
            },
            "heap": 0,
            "uptimeMs": int((time.time() - self.started_at) * 1000),
            "mdns": self.mdns_ok,
        }

    def wifi_document(self) -> Dict[str, Any]:
        cfg = self.store.config
        ssid, rssi = _wifi_link(self.interface)
        return {
            "ok": True,
            "mode": "sta" if ssid else "off",
            "sta": {
                "connected": bool(ssid),
                "ssid": ssid,
                "ip": _primary_ip(),
                "rssi": rssi,
                "hostname": cfg["sta"].get("hostname", MDNS_HOST),
            },
            "ap": {
                "enabled": bool(cfg["ap"].get("enabled")),
                "ssid": cfg["ap"].get("ssid", ""),
                "ip": cfg["ap"].get("ip", ""),
            },
            "saved": [{"ssid": entry["ssid"]} for entry in cfg["sta"].get("saved", [])],
            "interface": self.interface,
            "mdns": self.mdns_ok,
            "note": "Wi-Fi control uses NetworkManager (nmcli) when it is installed",
        }


# -------------------------------------------------------------- HTTP server


class ArsinHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: Tuple[str, int], state: ServiceState) -> None:
        super().__init__(address, ArsinHandler)
        self.state = state


class ArsinHandler(BaseHTTPRequestHandler):
    server_version = f"arsin-print-server/{VERSION}"
    protocol_version = "HTTP/1.1"

    # --------------------------------------------------------------- helpers
    @property
    def state(self) -> ServiceState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - stdlib signature
        log("debug", f"{self.address_string()} {fmt % args}")

    def _cors(self) -> None:
        cfg = self.state.store.config
        if not cfg["security"].get("allowCors", True):
            return
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Api-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")

    def _send_json(self, code: int, document: Any, headers: Optional[Dict[str, str]] = None) -> None:
        payload = json.dumps(document).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _send_text(self, code: int, text: str, content_type: str = "text/plain") -> None:
        payload = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def _send_error_json(self, code: int, message: str) -> None:
        self._send_json(code, {"ok": False, "error": message})

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _json_body(self) -> Tuple[bool, Any]:
        raw = self._read_body()
        if not raw:
            return False, None
        try:
            return True, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            log("warn", f"http: invalid JSON body: {exc}")
            return False, None

    def _api_key_ok(self) -> bool:
        expected = str(self.state.store.config["security"].get("apiKey", ""))
        if not expected:
            return True
        return self.headers.get("X-Api-Key", "") == expected

    def _require_write(self) -> bool:
        if self._api_key_ok():
            return True
        self._send_error_json(401, "missing or invalid X-Api-Key")
        return False

    def _query(self) -> Dict[str, str]:
        parsed = urllib.parse.urlsplit(self.path)
        return {key: values[0] for key, values in urllib.parse.parse_qs(parsed.query).items()}

    # ------------------------------------------------------------- verb entry
    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib naming
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        route = urllib.parse.urlsplit(self.path).path
        state = self.state
        if route == "/api/health":
            self._send_text(200, "arsin-print-server ok")
        elif route == "/api/info":
            self._send_json(200, state.info_document())
        elif route == "/api/status":
            self._send_json(200, state.status_document())
        elif route == "/api/config":
            self._send_json(200, state.store.snapshot())
        elif route == "/api/serial":
            cursor = int(self._query().get("since", "0") or 0)
            data, next_cursor = serial_since(cursor)
            self._send_json(200, {"data": data, "next": next_cursor})
        elif route == "/api/logs":
            cursor = int(self._query().get("since", "0") or 0)
            lines, next_cursor = logs_since(cursor)
            self._send_json(200, {"lines": lines, "next": next_cursor})
        elif route == "/api/wifi":
            self._send_json(200, state.wifi_document())
        elif route == "/api/backup":
            self._send_json(
                200,
                state.store.snapshot(),
                {"Content-Disposition": 'attachment; filename="arsin-print-server-config.json"'},
            )
        elif route == "/events":
            self._stream_events()
        elif route.startswith("/api/"):
            self._send_error_json(404, "unknown endpoint")
        else:
            self._serve_static(route)

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        route = urllib.parse.urlsplit(self.path).path
        state = self.state
        query = self._query()

        if route == "/api/print":
            self._handle_print(query)
            return
        if route == "/api/command":
            self._handle_command()
            return
        if route == "/api/raw":
            self._handle_raw()
            return

        if not self._require_write():
            return

        if route == "/api/config":
            ok, document = self._json_body()
            if not ok:
                self._send_error_json(400, "invalid or empty JSON body")
                return
            snapshot = state.store.snapshot()
            before = json.dumps(snapshot["printer"]) + json.dumps(snapshot["network"])
            applied, error = state.store.apply(document)
            if not applied:
                self._send_error_json(400, error)
                return
            state.store.save()
            snapshot = state.store.snapshot()
            after = json.dumps(snapshot["printer"]) + json.dumps(snapshot["network"])
            set_log_level(str(state.store.config["logging"].get("level", "info")))
            state.printer.reconfigure()
            self._send_json(200, {"ok": True, "restartRequired": before != after})
        elif route == "/api/wifi/scan":
            self._send_json(200, {"networks": wifi_scan()})
        elif route == "/api/wifi":
            ok, document = self._json_body()
            if not ok or not isinstance(document, dict) or not document.get("ssid"):
                self._send_error_json(400, 'missing "ssid"')
                return
            ssid = str(document["ssid"])[:32]
            password = str(document.get("password", ""))
            save = bool(document.get("save", True))
            joined, note = wifi_join(ssid, password, state.interface)
            if joined and save:
                with state.store.lock:
                    saved = [entry for entry in state.store.config["sta"]["saved"] if entry["ssid"] != ssid]
                    saved.append({"ssid": ssid, "password": password})
                    state.store.config["sta"]["saved"] = saved[-5:]
                    state.store.config["sta"]["ssid"] = ssid
                    state.store.config["sta"]["password"] = password
                state.store.save()
            current_ssid, rssi = _wifi_link(state.interface)
            self._send_json(
                200 if joined else 504,
                {"ok": joined, "ssid": ssid, "ip": _primary_ip(), "rssi": rssi, "saved": save, "note": note,
                 "active": current_ssid},
            )
        elif route == "/api/ap":
            ok, document = self._json_body()
            document = document if isinstance(document, dict) else {}
            enabled = bool(document.get("enabled", True))
            ssid = str(document.get("ssid") or state.store.config["ap"]["ssid"])
            password = str(document.get("password") or state.store.config["ap"]["password"])
            changed, note = wifi_hotspot(ssid, password, enabled, state.interface)
            with state.store.lock:
                state.store.config["ap"]["enabled"] = enabled
                state.store.config["ap"]["ssid"] = ssid
                if password:
                    state.store.config["ap"]["password"] = password
            state.store.save()
            self._send_json(200, {"ok": changed, "ap": {"enabled": enabled, "ssid": ssid}, "note": note})
        elif route == "/api/reboot":
            self._send_json(200, {"ok": True, "restarting": True})
            log("warn", "api: reboot requested - exiting so systemd restarts the service")
            threading.Timer(0.6, lambda: os._exit(0)).start()
        elif route == "/api/factory-reset":
            state.store.config = validate_config(_deep_merge(DEFAULT_CONFIG, {}))
            state.store.save()
            state.printer.reconfigure()
            self._send_json(200, {"ok": True, "restartRequired": True})
        elif route == "/api/counters/reset":
            state.printer.reset_counters()
            serial_reset()
            self._send_json(200, {"ok": True})
        elif route == "/api/backup":
            ok, document = self._json_body()
            if not ok:
                self._send_error_json(400, "invalid or empty JSON body")
                return
            applied, error = state.store.apply(document)
            if not applied:
                self._send_error_json(400, error)
                return
            state.store.save()
            state.printer.reconfigure()
            self._send_json(200, {"ok": True, "restartRequired": True})
        elif route == "/api/ota":
            self._read_body()
            self._send_text(
                501,
                "arsin-print-server: OTA firmware updates are only available on the ESP32/ESP8266 builds. "
                "On Linux update the package and restart the service.",
            )
        else:
            self._send_error_json(404, "unknown endpoint")

    # ------------------------------------------------------------- print paths
    def _handle_print(self, query: Dict[str, str]) -> None:
        if not self._require_write():
            return
        state = self.state
        payload = self._read_body()
        if not payload:
            self._send_error_json(400, "no print data received (send the job as the request body)")
            return
        language = query.get("lang") or str(state.store.config["printer"].get("language", "escpos"))
        want_cut = query.get("cut")
        default_cut = bool(state.store.config["printer"].get("cut", True))
        cut = default_cut if want_cut is None else want_cut not in ("0", "false", "")
        try:
            copies = max(1, min(20, int(query.get("copies", "1"))))
        except ValueError:
            copies = 1

        job_id = state.next_job_id()
        total = 0
        for _ in range(copies):
            total += state.printer.submit_all(payload, timeout=15.0)
        if cut:
            ok, cut_bytes, _note = build_command(language, "cut", {}, state.store.config["device"]["name"])
            if ok and cut_bytes:
                state.printer.submit_all(cut_bytes, timeout=3.0)
        state.printer.note_job(job_id)
        log("info", f"api: print job {job_id} ({language}) {len(payload)} byte(s) x{copies}")
        self._send_json(200, {"ok": True, "jobId": job_id, "bytes": total})

    def _handle_command(self) -> None:
        if not self._require_write():
            return
        state = self.state
        ok, document = self._json_body()
        if not ok or not isinstance(document, dict):
            self._send_error_json(400, "invalid or empty JSON body")
            return
        action = str(document.get("action", ""))
        if not action:
            self._send_error_json(400, 'missing "action"')
            return
        language = str(document.get("lang") or state.store.config["printer"].get("language", "escpos"))
        built, payload, note = build_command(
            language, action, document.get("params"), state.store.config["device"]["name"]
        )
        if not built:
            self._send_json(400, {"ok": False, "error": note, "action": action, "lang": language})
            return
        sent = state.printer.submit_all(payload, timeout=5.0)
        if sent < len(payload):
            self._send_error_json(503, "printer queue stalled")
            return
        self._send_json(
            200,
            {
                "ok": True,
                "hex": " ".join(f"{byte:02X}" for byte in payload),
                "bytes": len(payload),
                "note": note,
                "lang": language,
                "action": action,
            },
        )
        log("info", f"api: command {language}/{action} -> {len(payload)} byte(s)")

    def _handle_raw(self) -> None:
        if not self._require_write():
            return
        ok, document = self._json_body()
        if not ok or not isinstance(document, dict):
            self._send_error_json(400, "invalid or empty JSON body")
            return
        mode = str(document.get("mode", "hex")).lower()
        data = str(document.get("data", ""))
        if mode == "text":
            payload = data.encode("utf-8", "replace")
        else:
            cleaned = re.sub(r"[^0-9a-fA-F]", " ", data)
            try:
                payload = bytes(int(part, 16) for part in cleaned.split())
            except ValueError:
                payload = b""
        if not payload:
            self._send_error_json(400, "no bytes to send")
            return
        sent = self.state.printer.submit_all(payload, timeout=5.0)
        self._send_json(200, {"ok": True, "bytes": sent})

    # ------------------------------------------------------------------- SSE
    def _stream_events(self) -> None:
        state = self.state
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self._cors()
        self.end_headers()
        with state.sse_lock:
            state.sse_clients += 1
        log("info", "sse: client attached")
        try:
            self.wfile.write(b"retry: 2000\n\n")
            self.wfile.flush()
            while True:
                document = json.dumps(state.status_document())
                self.wfile.write(f"data: {document}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(2.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with state.sse_lock:
                state.sse_clients = max(0, state.sse_clients - 1)
            log("info", "sse: client disconnected")

    # ---------------------------------------------------------------- static
    def _serve_static(self, route: str) -> None:
        root = self.state.web_root
        if root:
            relative = route.lstrip("/") or "index.html"
            candidate = os.path.normpath(os.path.join(root, relative))
            if candidate.startswith(os.path.normpath(root)) and os.path.isfile(candidate):
                self._send_file(candidate)
                return
            index = os.path.join(root, "index.html")
            if os.path.isfile(index):
                self._send_file(index)
                return
        self._send_text(200, BUILTIN_PAGE, "text/html; charset=utf-8")

    def _send_file(self, path: str) -> None:
        gz_path = f"{path}.gz"
        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
        try:
            if accepts_gzip and os.path.isfile(gz_path):
                with open(gz_path, "rb") as handle:
                    payload = handle.read()
                encoding = "gzip"
            else:
                with open(path, "rb") as handle:
                    payload = handle.read()
                encoding = ""
        except OSError as exc:
            log("warn", f"static: cannot read {path}: {exc}")
            self._send_error_json(500, "cannot read asset")
            return
        self.send_response(200)
        self.send_header("Content-Type", guess_mime(path))
        self.send_header("Content-Length", str(len(payload)))
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()
        self.wfile.write(payload)


def guess_mime(path: str) -> str:
    extension = os.path.splitext(path)[1].lower()
    return {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
    }.get(extension, "application/octet-stream")


BUILTIN_PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arsin Print Server</title><style>
:root{color-scheme:dark}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e8ee}
header{padding:18px 20px;background:#161a22;border-bottom:1px solid #242a36}h1{margin:0;font-size:18px}
main{padding:20px;max-width:880px;margin:0 auto}section{background:#161a22;border:1px solid #242a36;
border-radius:10px;padding:16px;margin-bottom:16px}h2{margin:0 0 10px;font-size:14px;text-transform:uppercase;
letter-spacing:.6px;color:#8ea0c0}pre{background:#0b0d12;border:1px solid #242a36;border-radius:8px;padding:10px;
overflow:auto;white-space:pre-wrap}button{background:#2f6df6;color:#fff;border:0;border-radius:8px;padding:9px 14px;
margin:0 8px 8px 0;cursor:pointer}button.alt{background:#2a3242}.ok{color:#4ade80}.warn{color:#fbbf24}
</style></head><body>
<header><h1>Arsin Print Server (Raspberry Pi)</h1><div id="sub" class="warn">loading&hellip;</div></header>
<main>
<section><h2>Device</h2><pre id="info">{}</pre></section>
<section><h2>Status</h2><pre id="status">{}</pre></section>
<section><h2>Maintenance</h2>
<button onclick="cmd('selftest')">Self test</button>
<button onclick="cmd('status')">Status query</button>
<button class="alt" onclick="cmd('feed')">Feed</button>
<button class="alt" onclick="cmd('cut')">Cut</button>
<button class="alt" onclick="cmd('drawer')">Drawer</button>
<pre id="cmdout">-</pre></section>
<section><h2>Notes</h2><p class="warn">The web application bundle was not found next to the service
(<code>--web-root</code>). This page is the built-in fallback.</p></section>
</main><script>
const $=id=>document.getElementById(id);
async function j(u,o){const r=await fetch(u,o);return r.json()}
async function refresh(){try{const i=await j('/api/info');$('info').textContent=JSON.stringify(i,null,2);
$('sub').className='ok';$('sub').textContent=i.device+' '+i.version+' - '+i.platform+' - '+i.transport;
$('status').textContent=JSON.stringify(await j('/api/status'),null,2)}
catch(e){$('sub').className='warn';$('sub').textContent='offline: '+e}}
async function cmd(action){$('cmdout').textContent='sending '+action+' ...';
try{$('cmdout').textContent=JSON.stringify(await j('/api/command',{method:'POST',
headers:{'Content-Type':'application/json'},body:JSON.stringify({lang:'escpos',action:action,params:{}})}),null,2)}
catch(e){$('cmdout').textContent='error: '+e}}
refresh();setInterval(refresh,3000);
</script></body></html>
"""


# ------------------------------------------------------- raw TCP print server


class RawPrintHandler(socketserver.BaseRequestHandler):
    """Port 9100 style raw printing: everything received goes to the printer."""

    def handle(self) -> None:  # pragma: no cover - network thread
        state: ServiceState = self.server.state  # type: ignore[attr-defined]
        log("info", f"raw: client {self.client_address[0]} connected")
        self.request.settimeout(15.0)
        total = 0
        try:
            while True:
                try:
                    chunk = self.request.recv(4096)
                except socket.timeout:
                    break
                if not chunk:
                    break
                total += state.printer.submit_all(chunk, timeout=10.0)
        except OSError:
            pass
        finally:
            log("info", f"raw: client {self.client_address[0]} disconnected ({total} byte(s))")
            if total:
                state.printer.note_job(state.next_job_id())


class RawPrintServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: Tuple[str, int], state: ServiceState) -> None:
        super().__init__(address, RawPrintHandler)
        self.state = state


# ------------------------------------------------------------------- helpers


def resolve_web_root(explicit: str) -> str:
    """Find a directory that contains the web application index.html."""
    candidates: List[str] = []
    if explicit:
        candidates.append(explicit)
    here = os.path.dirname(os.path.abspath(__file__))
    candidates += [
        "/opt/arsin-print-server/web",
        os.path.join(here, "web"),
        os.path.join(here, "..", ".."),
        os.path.join(here, "..", "..", "web"),
        os.getcwd(),
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(os.path.join(candidate, "index.html")):
            return os.path.abspath(candidate)
    return ""


def parse_arguments(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="arsin_print_server.py",
        description="Arsin Print Server - Raspberry Pi / Linux print bridge (standard library only)",
    )
    parser.add_argument("--config", help="path to config.json (default: /etc/arsin-print-server/config.json)")
    parser.add_argument("--host", default="0.0.0.0", help="HTTP bind address (default: all interfaces)")
    parser.add_argument("--port", type=int, help="override network.webPort")
    parser.add_argument("--raw-port", type=int, help="override network.rawPort")
    parser.add_argument("--web-root", help="directory that holds index.html and assets/")
    parser.add_argument("--no-printer", action="store_true", help="accept jobs without a printer attached")
    parser.add_argument("--log-level", choices=LOG_LEVELS, help="override logging.level")
    parser.add_argument("--no-mdns", action="store_true", help="do not advertise through avahi")
    parser.add_argument("--print-config", action="store_true", help="print the effective config and exit")
    parser.add_argument("--version", action="version", version=f"arsin-print-server {VERSION}")
    return parser.parse_args(argv)


# ---------------------------------------------------------------------- main


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_arguments(argv)
    global _log_console

    store = ConfigStore(args.config or "")
    store.load()
    if args.log_level:
        store.config["logging"]["level"] = args.log_level
    set_log_level(str(store.config["logging"].get("level", "info")))
    set_log_buffer(int(store.config["logging"].get("bufferLines", 200)))
    if args.port:
        store.config["network"]["webPort"] = args.port
    if args.raw_port:
        store.config["network"]["rawPort"] = args.raw_port
    validate_config(store.config)

    if args.print_config:
        print(json.dumps(store.snapshot(), indent=2))
        return 0

    printer = Printer(store, no_printer=args.no_printer)
    state = ServiceState(store, printer, args.no_printer)
    state.web_root = resolve_web_root(args.web_root or "")

    log("info", f"arsin-print-server {VERSION} starting")
    log("info", f"transport: {printer.transport_description()}")
    if args.no_printer:
        log("warn", "--no-printer: jobs are accepted but discarded")
    if state.web_root:
        log("info", f"static web app served from {state.web_root}")
    else:
        log("warn", "no web application directory found, serving the built-in page")

    printer.start()

    if store.config["network"].get("mdns", True) and not args.no_mdns:
        ok, note, processes = start_mdns(
            str(store.config["sta"].get("hostname", MDNS_HOST)),
            int(store.config["network"].get("webPort", 80)),
            int(store.config["network"].get("rawPort", 9100)),
        )
        state.mdns_ok = ok
        state.mdns_note = note
        state.mdns_processes = processes
        if not ok:
            log("warn", f"mdns: {note}")

    http_port = int(store.config["network"].get("webPort", 80))
    raw_port = int(store.config["network"].get("rawPort", 9100))
    servers: List[Any] = []

    try:
        raw_server = RawPrintServer((args.host, raw_port), state)
    except OSError as exc:
        log("error", f"cannot listen on raw port {raw_port}: {exc}")
        raw_server = None
    if raw_server:
        servers.append(raw_server)
        threading.Thread(target=raw_server.serve_forever, name="arsin-raw", daemon=True).start()
        log("info", f"raw print server listening on {args.host}:{raw_port}")

    try:
        http_server = ArsinHttpServer((args.host, http_port), state)
    except OSError as exc:
        log("error", f"cannot listen on port {http_port}: {exc}")
        if http_port == 80:
            log("info", "tip: ports below 1024 need root, or run with --port 8080")
        printer.stop()
        for server in servers:
            server.shutdown()
        return 1
    servers.append(http_server)

    stopping = threading.Event()

    def _shutdown(signum: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        log("info", f"signal {signum} received, shutting down")
        threading.Thread(target=http_server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    log("info", f"http://{_primary_ip() or 'localhost'}:{http_port}/ ready (app {APP_ID})")
    try:
        http_server.serve_forever(poll_interval=0.5)
    finally:
        http_server.server_close()
        for server in servers:
            try:
                server.server_close()
            except OSError:
                pass
        for process in state.mdns_processes:
            if process.poll() is None:
                process.terminate()
        printer.stop()
        log("info", "arsin-print-server stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
