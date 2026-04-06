#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-restart}"
OS="$(uname -s)"

run_macos() {
  local plist="$HOME/Library/LaunchAgents/com.nanoclaw.plist"
  local service="gui/$(id -u)/com.nanoclaw"

  if [[ ! -f "$plist" ]]; then
    echo "launchd plist not found: $plist" >&2
    exit 1
  fi

  case "$ACTION" in
    start)
      launchctl load "$plist"
      ;;
    restart)
      if launchctl print "$service" >/dev/null 2>&1; then
        launchctl kickstart -k "$service"
      else
        launchctl load "$plist"
      fi
      ;;
    *)
      echo "Usage: $0 [start|restart]" >&2
      exit 1
      ;;
  esac
}

run_linux() {
  case "$ACTION" in
    start)
      systemctl --user start nanoclaw
      ;;
    restart)
      systemctl --user restart nanoclaw
      ;;
    *)
      echo "Usage: $0 [start|restart]" >&2
      exit 1
      ;;
  esac
}

case "$OS" in
  Darwin)
    run_macos
    ;;
  Linux)
    run_linux
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac
