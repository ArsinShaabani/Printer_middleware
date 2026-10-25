#!/usr/bin/env bash
#
# Arsin Print Server - one line installer for Raspberry Pi OS / Debian / Ubuntu.
#
#   curl -fsSL https://raw.githubusercontent.com/ArsinShaabani/Printer_middleware/main/firmware/raspberrypi/install.sh | sudo bash
#
# or, from a checkout:
#
#   sudo ./install.sh                 # install or upgrade in place
#   sudo ./install.sh --with-cups     # also install CUPS and a raw queue
#   sudo ./install.sh --port 8080     # serve the web app on another port
#   sudo ./install.sh --uninstall     # remove the service (config is kept)
#
# The script is idempotent: running it again upgrades the files, keeps the
# existing configuration and restarts the service.

set -euo pipefail

SERVICE_NAME="arsin-print-server"
INSTALL_DIR="/opt/arsin-print-server"
CONFIG_DIR="/etc/arsin-print-server"
CONFIG_FILE="${CONFIG_DIR}/config.json"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SERVICE_USER="arsin-print"
REPO_RAW="${ARSIN_REPO_RAW:-https://raw.githubusercontent.com/ArsinShaabani/Printer_middleware/main}"
PORT=""
WITH_CUPS=0
UNINSTALL=0
NO_SERVICE=0

log()  { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARNING: %s\n' "$*" >&2; }
die()  { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --with-cups) WITH_CUPS=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this installer with sudo / as root"
command -v python3 >/dev/null 2>&1 || die "python3 is required (apt install python3)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

# --------------------------------------------------------------------- uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  log "stopping and disabling ${SERVICE_NAME}"
  systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
  systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
  rm -f "${UNIT_FILE}"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "${INSTALL_DIR}"
  log "removed ${INSTALL_DIR}; configuration kept in ${CONFIG_DIR}"
  exit 0
fi

# ------------------------------------------------------------------- fetch files
fetch() {
  # fetch <file-name> <destination>
  local rel="$1" dest="$2"
  if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/${rel}" ]; then
    cp "${SCRIPT_DIR}/${rel}" "${dest}"
    return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${REPO_RAW}/firmware/raspberrypi/${rel}" -o "${dest}" && return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "${dest}" "${REPO_RAW}/firmware/raspberrypi/${rel}" && return 0
  fi
  return 1
}

log "installing to ${INSTALL_DIR}"
install -d -m 0755 "${INSTALL_DIR}"
install -d -m 0755 "${CONFIG_DIR}"

tmp_service="$(mktemp)"
fetch "arsin_print_server.py" "${INSTALL_DIR}/arsin_print_server.py" || die "cannot download arsin_print_server.py"
chmod 0755 "${INSTALL_DIR}/arsin_print_server.py"
fetch "arsin-print-server.service" "${tmp_service}" || die "cannot download the systemd unit"
fetch "config.example.json" "${INSTALL_DIR}/config.example.json" || warn "config.example.json not downloaded"

# ------------------------------------------------------------------- config file
if [ ! -f "${CONFIG_FILE}" ]; then
  log "creating ${CONFIG_FILE} from the example"
  cp "${INSTALL_DIR}/config.example.json" "${CONFIG_FILE}"
else
  log "keeping the existing ${CONFIG_FILE}"
fi
chmod 0640 "${CONFIG_FILE}"

if [ -n "${PORT}" ]; then
  log "setting network.webPort to ${PORT}"
  python3 - "${CONFIG_FILE}" "${PORT}" <<'PY'
import json, sys
path, port = sys.argv[1], int(sys.argv[2])
with open(path, "r", encoding="utf-8") as handle:
    cfg = json.load(handle)
cfg.setdefault("network", {})["webPort"] = port
with open(path, "w", encoding="utf-8") as handle:
    json.dump(cfg, handle, indent=2)
    handle.write("\n")
PY
fi

# ----------------------------------------------------------------- service user
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  log "creating the ${SERVICE_USER} system user"
  if command -v adduser >/dev/null 2>&1; then
    adduser --system --group --no-create-home --home "${INSTALL_DIR}" "${SERVICE_USER}" >/dev/null
  else
    useradd --system --home "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  fi
fi
for group in dialout lp; do
  if getent group "${group}" >/dev/null 2>&1; then
    usermod -aG "${group}" "${SERVICE_USER}" || warn "could not add ${SERVICE_USER} to ${group}"
  fi
done
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"
chown root:"${SERVICE_USER}" "${CONFIG_FILE}"

# ------------------------------------------------------------------ CUPS (optional)
if [ "$WITH_CUPS" -eq 1 ]; then
  log "installing CUPS and a raw print queue (optional)"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq || warn "apt-get update failed"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cups cups-client || warn "CUPS install failed"
    systemctl enable --now cups >/dev/null 2>&1 || true
    sleep 2
    if command -v lpadmin >/dev/null 2>&1; then
      lpadmin -p ARSIN_PrintServer -E -v "socket://127.0.0.1:9100" -m raw 2>/dev/null \
        || warn "could not create the ARSIN_PrintServer queue (create it from the CUPS web UI on :631)"
      log "CUPS queue ARSIN_PrintServer -> socket://127.0.0.1:9100"
    fi
  else
    warn "apt-get not found: install CUPS manually and point a raw queue at port 9100"
  fi
fi

# --------------------------------------------------------------------- systemd
if [ "$NO_SERVICE" -eq 1 ]; then
  log "--no-service: skipping systemd setup; run manually with:"
  log "  python3 ${INSTALL_DIR}/arsin_print_server.py --config ${CONFIG_FILE}"
  exit 0
fi

log "installing ${UNIT_FILE}"
install -m 0644 "${tmp_service}" "${UNIT_FILE}"
rm -f "${tmp_service}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service" >/dev/null
systemctl restart "${SERVICE_NAME}.service"

sleep 2
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  ip_addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  web_port="$(python3 -c "import json;print(json.load(open('${CONFIG_FILE}'))['network']['webPort'])" 2>/dev/null || echo 80)"
  log "service is running"
  log "web app : http://${ip_addr:-<pi-ip>}:${web_port}/"
  log "raw 9100: ${ip_addr:-<pi-ip>}:9100"
  log "logs    : journalctl -u ${SERVICE_NAME} -f"
else
  warn "service did not start - inspect: journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  exit 1
fi
