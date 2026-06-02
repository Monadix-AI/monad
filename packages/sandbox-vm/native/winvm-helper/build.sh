#!/usr/bin/env bash
# Build the Windows VM-sandbox host helper (GOOS=windows both arches) and the guest-side gvforwarder
# (Linux, both arches — pinned gvisor-tap-vsock cmd/vm, the tap⇄vsock network forwarder the hyperv
# driver injects via Ignition), vendoring everything into packages/sandbox-vm/vendor. Run when this
# helper changes or when bumping GVPROXY_VERSION; requires Go on PATH.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)" # this script lives in the helper's source dir
OUT="$here/../../vendor"              # packages/sandbox-vm/vendor (absolute so subshells resolve it)

GVPROXY_VERSION=v0.8.9 # keep in lockstep with the gvproxy pins in packages/sandbox-vm/src/toolchain.ts

for arch in arm64 amd64; do
  (cd "$here" &&
    GOOS=windows GOARCH="$arch" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
      -o "$OUT/winvm-helper-$arch.exe" .)
  echo "built packages/sandbox-vm/vendor/winvm-helper-$arch.exe"
done

# gvforwarder: built from the pinned upstream module in a throwaway module dir (the release ships
# only an amd64 binary; we need arm64 too, and building both keeps provenance uniform).
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
(cd "$TMP" &&
  go mod init gvforwarder-build >/dev/null 2>&1 &&
  GOOS=linux go get "github.com/containers/gvisor-tap-vsock/cmd/vm@$GVPROXY_VERSION" >/dev/null 2>&1)
for arch in arm64 amd64; do
  (cd "$TMP" &&
    GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
      -o "$OUT/gvforwarder-$arch" github.com/containers/gvisor-tap-vsock/cmd/vm)
  echo "built packages/sandbox-vm/vendor/gvforwarder-$arch"
done
