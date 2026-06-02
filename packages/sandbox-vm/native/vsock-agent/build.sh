#!/usr/bin/env bash
# Cross-compile the guest vsock exec agent (Linux, both arches) and vendor the binaries into the
# package. Run when main.go / mount9p.go changes; requires Go on PATH. The guest arch matches the
# host arch (KVM / Virtualization.framework run same-arch guests), so we ship both.
set -euo pipefail

SOURCE=$(cd "$(dirname "$0")" && pwd)
OUT=$(cd "$SOURCE/../.." && pwd)/vendor
TMP=$(mktemp -d "$OUT/.vsock-agent-build.XXXXXX")

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

cd "$SOURCE"
go test ./...

GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$TMP/vsock-agent-arm64" .
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$TMP/vsock-agent-amd64" .

shasum -a 256 "$TMP/vsock-agent-arm64" "$TMP/vsock-agent-amd64"
mv "$TMP/vsock-agent-arm64" "$OUT/vsock-agent-arm64"
mv "$TMP/vsock-agent-amd64" "$OUT/vsock-agent-amd64"
