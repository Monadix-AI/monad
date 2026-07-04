#!/usr/bin/env bash
# Build the Linux Mo sprite. Requires GTK3 + libcurl development headers:
#   Debian/Ubuntu: sudo apt install libgtk-3-dev libcurl4-openssl-dev
#   Fedora:        sudo dnf install gtk3-devel libcurl-devel
set -euo pipefail
cd "$(dirname "$0")"
bash ../common/ensure-atlas.sh

out="${1:-mo}"
pkgs="gtk+-3.0 libcurl"

if ! pkg-config --exists $pkgs; then
  echo "mo: missing build deps. Need: $pkgs" >&2
  echo "  Debian/Ubuntu: sudo apt install libgtk-3-dev libcurl4-openssl-dev" >&2
  exit 1
fi

cc -O2 -Wall -Wextra -I../common mo.c ../common/daemon.c \
  $(pkg-config --cflags $pkgs) \
  $(pkg-config --libs $pkgs) \
  -o "$out"

echo "mo: built ./$out"
