# @monad/mo

Mo — the monad desktop sprite. A pixel-art cat you drop files onto to start a session.

See [`docs/usage/mo.md`](../../docs/usage/mo.md) for the architecture and the drop → session flow.

## Layout

- `native/common/` — `daemon.c`: libcurl client (Unix socket) shared by all shells
- `native/linux/` — GTK3 + Cairo shell (window, cat, file drop → input box)
- `native/macos/` — Cocoa shell; builds `Mo.app` (`LSUIElement` agent app)
- `native/windows/` — Win32 shell _(TODO)_
- `native/common/` — also `atlas.h`: compiled atlas-pet layout table (mirrors `assets/atlas.json`)
- `assets/` — `mochi.png` atlas-pet sprite sheet + `atlas.json` manifest
- `scripts/build.ts` — builds the native shell for the host OS

## Build

```sh
bun run --filter @monad/mo build
```

Linux needs `libgtk-3-dev` and `libcurl4-openssl-dev`. The shell talks to a running
monad daemon over its Unix socket; start the daemon first (`bun run dev`).
