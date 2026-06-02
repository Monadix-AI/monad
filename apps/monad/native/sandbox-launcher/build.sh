#!/usr/bin/env bash
# Build all monad-sandbox-launcher variants.
#
# Usage: ./build.sh [OUTPUT_DIR]
#   OUTPUT_DIR defaults to ./out/
#
# What each binary does:
#   Linux (all variants)   — Landlock FS write-restriction + seccomp syscall filter
#   Windows (x64 / arm64) — Low Integrity token + Job Object
#
# Required compilers (install what you need for your target):
#   Linux x64 glibc  : gcc               (usually pre-installed)
#   Linux arm64 glibc: aarch64-linux-gnu-gcc
#   Linux x64 musl   : musl-gcc           (musl-tools)
#   Linux arm64 musl : aarch64-linux-musl-gcc  (not in Ubuntu apt — build from musl-cross-make)
#   Windows x64      : x86_64-w64-mingw32-gcc  (gcc-mingw-w64-x86-64)
#   Windows arm64    : aarch64-w64-mingw32-clang (llvm-mingw — see mstorsjo/llvm-mingw)
#
# Install helpers (Debian/Ubuntu):
#   sudo apt-get install gcc-aarch64-linux-gnu musl-tools gcc-mingw-w64-x86-64

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$DIR/out}"
mkdir -p "$OUT"

LINUX_SRC="$DIR/main.c"
WIN_SRC="$DIR/windows.c"

ok()   { echo "  ✓ $1"; }
skip() { echo "  ⚠ $1 (skipping — compiler not found)"; }

compile_linux() {
  local cc="$1" out="$2" label="$3"
  if command -v "$cc" &>/dev/null; then
    "$cc" -O2 -s -static -o "$out" "$LINUX_SRC" && ok "$label ($cc)"
  else
    skip "$label"
  fi
}

compile_windows() {
  local cc="$1" extra_flags=("${@:3}") out="$2" label="$3"
  if command -v "$cc" &>/dev/null; then
    "$cc" -O2 -s "${extra_flags[@]}" -municode -o "$out" "$WIN_SRC" -ladvapi32 && ok "$label ($cc)"
  else
    skip "$label"
  fi
}

echo "Building sandbox launchers → $OUT"
echo ""
echo "── Linux ────────────────────────────────────────────────────────────────────"
compile_linux gcc                         "$OUT/monad-sandbox-launcher"               "linux-x64-glibc"
compile_linux aarch64-linux-gnu-gcc       "$OUT/monad-sandbox-launcher-linux-arm64"   "linux-arm64-glibc"
compile_linux musl-gcc                    "$OUT/monad-sandbox-launcher-linux-x64-musl" "linux-x64-musl"
compile_linux aarch64-linux-musl-gcc      "$OUT/monad-sandbox-launcher-linux-arm64-musl" "linux-arm64-musl"

echo ""
echo "── Windows ──────────────────────────────────────────────────────────────────"
# x64: static link works fine with MinGW; arm64 with llvm-mingw uses its own runtime (no -static).
compile_windows x86_64-w64-mingw32-gcc    "$OUT/monad-sandbox-launcher.exe"           "windows-x64" -static
compile_windows aarch64-w64-mingw32-clang "$OUT/monad-sandbox-launcher-arm64.exe"     "windows-arm64"

echo ""
echo "Done. Built binaries:"
ls -lh "$OUT"/ 2>/dev/null | grep monad-sandbox-launcher || echo "  (none built)"
