# Mo — the desktop sprite

Mo is a pixel-art cat that floats on the desktop as a transparent, frameless,
always-on-top window. Drop a file or folder onto Mo and it opens a small input box;
submitting starts a new monad **session** seeded with what you dropped.

## Architecture

Mo is deliberately tiny. There is **no webview and no Bun host** — the desktop side is
a single lightweight native process per OS, and all the orchestration lives in the
**already-running monad daemon**.

```
┌───────────────────────────────────────────────┐
│ native Mo process  (apps/mo/native/<os>/)      │
│  • transparent / frameless / always-on-top     │
│  • pixel-art cat drawn natively (no webview)   │
│  • cursor-distance sensing → behavior FSM      │
│  • OS file drag-and-drop → input box           │
│  • libcurl/NSURLSession/WinHTTP → daemon       │
└──────────────────────┬────────────────────────┘
                       │ loopback / unix socket (HTTP)
┌──────────────────────▼────────────────────────┐
│ monad daemon  (apps/monad)                     │
│  GET  /v1/health              ← awake/asleep   │
│  POST /v1/mo/drop {paths,prompt}               │
│       → validate · create session · seed msg   │
│  GET  /v1/sessions/:id/events ← working anim   │
│  POST /v1/mo/{launch,quit} · GET /v1/mo/status │
└────────────────────────────────────────────────┘
```

The uniform interface is the daemon's REST contract (`@monad/protocol`). Each OS has its
own native shell implementing the same behaviour against that contract — there is no
shared platform-branching feature code, mirroring `packages/home/src/open-url.ts`.

### Why native rendering (no webview)

A system webview (WebKitGTK / WebView2 / WKWebView) drags in a full browser engine —
~150–300 MB resident for an always-on sprite. Drawing the cat natively keeps Mo at
~5–20 MB. React Native desktop was rejected too: no Linux support, a Metro toolchain that
conflicts with the repo's Bun convention, and no memory win over native blitting.

## The drop → session flow

1. The native shell collects the dropped **absolute paths**.
2. It shows a native input box; the user types an optional prompt.
3. It `POST`s `{ paths, prompt }` to `/v1/mo/drop`.
4. The daemon (`apps/monad/src/handlers/mo/handlers.ts`) resolves/validates the paths,
   creates a `desktop`-sourced session, and sends a seed message: the prompt leads, the
   dropped paths follow as a **quoted (JSON-escaped) data block** so a crafted filename
   can't smuggle instructions (prompt-injection containment). The agent reads the files
   via its sandboxed tools.

Files are passed by **absolute path** (the daemon is co-located) — no file contents are
read or transmitted by Mo itself.

## Sprite atlas — the Codex atlas-pet standard

Mo's art follows the **Codex atlas-pet** format (the same standard the `hatch-pet` pipeline emits).
The sheet (`assets/mochi.png`) is a `columns × rows` grid of `cell_width × cell_height` RGBA cells
on a transparent background (chroma-keyed from cyan `#00FFFF` at generation time). The bundled Mochi
sheet is **8 × 9** cells of **192 × 208**. Each row is one **agent-lifecycle state**; frames are
packed left-aligned, unused cells transparent. The canonical manifest is `assets/atlas.json`
(columns/rows/cell size + per-row `{state, row, frames}`); `native/common/atlas.h` mirrors it as a
compiled table so both shells render without a C JSON dependency.

The nine states (atlas row order, which is also the `mo_state` enum order):

| row | state | purpose |
|---|---|---|
| 0 | `idle` | calm resting / breathing / blinking |
| 1 | `running-right` | dragged rightward |
| 2 | `running-left` | dragged leftward |
| 3 | `waving` | greeting / a file is hovering |
| 4 | `jumping` | caught a dropped file |
| 5 | `failed` | drop failed / daemon unreachable |
| 6 | `waiting` | session seeded, awaiting the agent |
| 7 | `running` | agent actively generating |
| 8 | `review` | turn complete, output ready |

## Behavior state machine

`native/common/behavior.c` (platform-independent C, mirrors `common/daemon.c`) maps Mo's signals to
those nine states; both shells share it. Each shell samples sensors once per tick + passes edge events:

- **inputs** — daemon health, whether the seeded session's SSE is busy, whether a file is hovering,
  whether the user is dragging Mo's window (+ horizontal delta → left/right); edge events
  `drop` / `drop ok` / `drop fail`.
- the lifecycle: hover a file → **waving**; drop it → **jumping** (caught) → **waiting** (seeded) →
  **running** (agent generating) → **review** (done); a failed drop or an offline daemon → **failed**;
  dragging Mo's window → **running-left/right**; otherwise **idle**.

This is purely agent-lifecycle driven — there is no cursor-chasing/sleep behavior (the Codex state
taxonomy has no such states).

### Working animation (SSE)

After a successful drop, the shell subscribes to `GET /v1/sessions/:id/events` on a background
thread (`mo_daemon_subscribe`). It treats "stream bytes arriving" as busy — no event-payload
parsing — so the FSM holds `running` until the stream goes quiet (~2s), then shows `review`.

## Daemon-managed lifecycle

The daemon **owns** Mo's process — Mo is started only through the daemon (cli/web), never run
directly. `MoService` (`apps/monad/src/services/mo.ts`) spawns the native binary at `MO_BINARY`
on `POST /v1/mo/launch`, kills it on `POST /v1/mo/quit`, and reports `GET /v1/mo/status`.

Two mechanisms enforce "daemon-launched only" and bind the lifecycle:

- **Socket injection** — `MoService` passes the daemon's own socket path to Mo via the
  `MO_DAEMON_SOCK` env var, so the sprite always talks to *this* daemon instance (correct under
  multiple worktrees, each with its own socket). `daemon.c`'s `socket_path()` treats it as
  authoritative.
- **Launch gate** — on startup each shell checks `MO_DAEMON_SOCK`; if it's absent (e.g. Mo was
  double-clicked) it prints a hint and exits non-zero. This is an intent gate, not a security
  boundary — the env can be faked, but it stops accidental standalone launches.
- **Shutdown** — Mo dies with the daemon: `process.on('exit')` kills it, and a `SIGTERM`/`SIGINT`
  handler in `main.ts` routes a `monad` stop into a normal exit so that cleanup actually runs
  (the default signal disposition would skip it and orphan Mo).

## Build & install

`bun run --filter @monad/mo build` dispatches to the host OS's native shell
(`apps/mo/scripts/build.ts`, the single `process.platform` branch).

- **Linux** (`native/linux/`): GTK3 + Cairo. Needs `libgtk-3-dev` + `libcurl4-openssl-dev`;
  transparency needs a compositor. Install the binary and `mo.desktop` autostart entry.
- **macOS** (`native/macos/`): Cocoa `NSWindow` + `NSBezierPath`. Builds `Mo.app` (an
  `LSUIElement` agent app — no Dock icon) via the Xcode command line tools. Don't add it to Login
  Items — the daemon launches it (the launch gate makes a standalone start exit immediately).
  Point the daemon at the built binary with `MO_BINARY`. Signing/notarization is for distribution only.
- **Windows** (`native/windows/`): Win32 layered window, Startup shortcut. _(TODO)_

Two modules in `native/common/` are shared across shells: `daemon.c` (libcurl over the Unix
socket — health, drop, SSE subscribe) and `behavior.c` (the platform-independent state machine).
Each OS shell only owns its windowing + drawing + file-drop + cursor-sampling code.
