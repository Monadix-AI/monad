#!/usr/bin/env bash
# Cross-compile the guest vsock exec agent (Linux aarch64) and vendor the binary into the package.
# Run when native/vsock-agent/main.go changes; requires Go on PATH.
set -euo pipefail
cd "$(dirname "$0")/../native/vsock-agent"
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
  -o ../../packages/sandbox-vm/vendor/vsock-agent-arm64 .
echo "built packages/sandbox-vm/vendor/vsock-agent-arm64"
