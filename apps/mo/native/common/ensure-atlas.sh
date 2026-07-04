#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
bun run "$root/scripts/gen-mo-atlas.ts" >/dev/null
