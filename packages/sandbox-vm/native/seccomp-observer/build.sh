#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cc="${CC:-gcc}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

"$cc" -std=c11 -O2 -Wall -Wextra -Werror -static -o "$tmp/monad-seccomp-observer" "$root/observer.c"
"$cc" -std=c11 -O2 -Wall -Wextra -Werror -static -o "$tmp/observer-test" "$root/observer_test.c"

if [[ "${1:-}" != "--build-only" ]]; then
  "$tmp/observer-test" "$tmp/monad-seccomp-observer"
fi

if [[ "${1:-}" == "--test-only" ]]; then
  exit 0
fi

case "$(uname -m)" in
  x86_64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

strip "$tmp/monad-seccomp-observer"
destination="$root/../../vendor/seccomp-observer-$arch"
install -m 0755 "$tmp/monad-seccomp-observer" "$destination.tmp"
mv "$destination.tmp" "$destination"
sha256sum "$destination"
