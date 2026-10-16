#!/usr/bin/env bash
# Run a local FalkorDB without Docker.
#
# Uses the redis-server + FalkorDB module binaries shipped in the `falkordblite`
# Python wheel (needs Python >= 3.12; uv fetches one). Installed once into $STALEPROOF_HOME/falkordb.
#
#   scripts/falkordb-local.sh start [port]   # default port 6379
#   scripts/falkordb-local.sh stop  [port]
#   scripts/falkordb-local.sh status [port]
#   scripts/falkordb-local.sh bin            # print the binaries directory
#
# Data lives in $STALEPROOF_HOME/falkordb/data-<port> (RDB snapshots), so the
# graph — including verdicts and decisions — survives restarts.
set -euo pipefail

# STALEPROOF_HOME, else LOCKSTEP_HOME (the former name), else ~/.staleproof (or ~/.lockstep if only it exists).
if [ -z "${STALEPROOF_HOME:-}" ]; then
  if [ -n "${LOCKSTEP_HOME:-}" ]; then
    STALEPROOF_HOME="$LOCKSTEP_HOME"
  elif [ ! -d "$HOME/.staleproof" ] && [ -d "$HOME/.lockstep" ]; then
    STALEPROOF_HOME="$HOME/.lockstep"
  else
    STALEPROOF_HOME="$HOME/.staleproof"
  fi
fi
BASE="$STALEPROOF_HOME/falkordb"
VENV="$BASE/venv"
FALKORDBLITE_VERSION="${FALKORDBLITE_VERSION:-0.10.0}"

cmd="${1:-start}"
port="${2:-6379}"

die() { echo "falkordb-local: $*" >&2; exit 1; }

find_bin() {
  local d
  d="$(ls -d "$VENV"/lib/python*/site-packages/redislite/bin 2>/dev/null | head -1 || true)"
  [ -n "$d" ] && [ -x "$d/redis-server" ] && echo "$d"
}

install() {
  mkdir -p "$BASE"
  if command -v uv >/dev/null 2>&1; then
    [ -d "$VENV" ] || uv venv -q --python 3.12 "$VENV"
    uv pip install -q --python "$VENV/bin/python" "falkordblite==$FALKORDBLITE_VERSION"
  else
    command -v python3 >/dev/null 2>&1 || die "need uv or python3 to install falkordblite"
    [ -d "$VENV" ] || python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q "falkordblite==$FALKORDBLITE_VERSION"
  fi
}

bin_dir() {
  local d
  d="$(find_bin || true)"
  if [ -z "$d" ]; then
    install >&2
    d="$(find_bin || true)"
  fi
  [ -n "$d" ] || die "falkordblite installed but redis-server not found under $VENV"
  echo "$d"
}

ping() {
  "$1/redis-cli" -p "$port" PING 2>/dev/null | grep -q PONG
}

case "$cmd" in
  bin)
    bin_dir
    ;;
  start)
    d="$(bin_dir)"
    if ping "$d"; then
      echo "falkordb-local: already running on port $port"
      exit 0
    fi
    data="$BASE/data-$port"
    mkdir -p "$data"
    "$d/redis-server" \
      --port "$port" \
      --bind 127.0.0.1 \
      --dir "$data" \
      --loadmodule "$d/falkordb.so" \
      --save "60 1" \
      --daemonize yes \
      --pidfile "$data/redis.pid" \
      --logfile "$data/redis.log"
    for _ in $(seq 1 50); do
      ping "$d" && { echo "falkordb-local: running on port $port (data: $data)"; exit 0; }
      sleep 0.1
    done
    die "server did not answer PING on port $port — see $data/redis.log"
    ;;
  stop)
    d="$(bin_dir)"
    if ping "$d"; then
      "$d/redis-cli" -p "$port" SHUTDOWN SAVE >/dev/null 2>&1 || true
      echo "falkordb-local: stopped port $port"
    else
      echo "falkordb-local: nothing running on port $port"
    fi
    ;;
  status)
    d="$(bin_dir)"
    if ping "$d"; then echo "running on port $port"; else echo "not running on port $port"; exit 1; fi
    ;;
  *)
    die "usage: falkordb-local.sh start|stop|status|bin [port]"
    ;;
esac
