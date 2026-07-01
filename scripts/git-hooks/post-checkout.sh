#!/bin/sh
set -u

# Git passes 1 as the third argument when the checkout changes branches.
# `git worktree add` creates/checks out the new branch in the new worktree, so
# this is the earliest reliable point to prepare that checkout.
if [ "${3:-0}" != "1" ]; then
  exit 0
fi

root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$root" ] || [ ! -d "$root" ]; then
  exit 0
fi

cd "$root" || exit 0

if [ -f .envrc ]; then
  if command -v direnv >/dev/null 2>&1; then
    direnv allow || true
  else
    echo "[monad hook] direnv not found; skipping direnv allow" >&2
  fi
fi

if [ -f package.json ] && [ ! -d node_modules ]; then
  if [ -f .envrc ] && command -v direnv >/dev/null 2>&1; then
    echo "[monad hook] node_modules missing; running direnv exec bun install" >&2
    direnv exec "$root" bun install
  elif command -v bun >/dev/null 2>&1; then
    echo "[monad hook] node_modules missing; running bun install" >&2
    bun install
  else
    echo "[monad hook] bun not found; cannot initialize worktree dependencies" >&2
    exit 1
  fi
fi
