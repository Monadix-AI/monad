#!/usr/bin/env bash
# Cross-compile the guest vsock exec agent (Linux, both arches) and vendor the binaries into the
# package. Run when main.go / mount9p.go changes; requires Go on PATH. The guest arch matches the
# host arch (KVM / Virtualization.framework run same-arch guests), so we ship both.
set -euo pipefail
cd "$(dirname "$0")" # this script lives in the source dir
OUT=../../vendor      # packages/sandbox-vm/vendor
for arch in arm64 amd64; do
  GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$OUT/vsock-agent-$arch" .
  echo "built packages/sandbox-vm/vendor/vsock-agent-$arch"
done
