---
targets: ["*"]
description: "Package boundaries and per-area responsibilities"
globs: ["**/*"]
---

# Architecture

Package boundaries and dependency direction: `docs/engineering/architecture.md` /
@docs/engineering/architecture.md. Read before adding a package, moving a type, or
introducing a new dependency between existing layers.

## Responsibilities by area

### `@monad/protocol`

Single source of truth for wire/domain contracts: zod schemas, domain entities,
events, settings, RPC methods, IDs. Types only; no runtime logic and no monorepo
dependencies beyond `zod`.

- Define `xxxSchema`, then `export type Xxx = z.infer<typeof xxxSchema>`.
- One concept per file, re-exported from `src/index.ts`.
- Consumers derive shapes instead of redeclaring them.
- UI-only types do not belong here.
- See `docs/engineering/conventions.md` / @docs/engineering/conventions.md.

### `@monad/home`

Owns the daemon home boundary: `config.json`, `auth.json`, filesystem layout,
workspace context discovery, init flow, and client connection resolution.

- `src/config.ts` is the settings source of truth; add user-facing settings there.
- `src/paths.ts` is the only place that knows the `~/.monad` layout.
- Parse config/auth on load; never log secrets.
- Keep this layer below runtime modules: do not import `@monad/monad`, atoms, web, CLI,
  or other executable layers.
- See `docs/engineering/conventions.md` / @docs/engineering/conventions.md and
  `docs/engineering/security-guidelines.md` / @docs/engineering/security-guidelines.md.

### `apps/monad` daemon

Core runtime: transports, agent loop, store, MCP, atom loading, channels, providers,
config reload, and observability.

- Bootstrap in dependency order: config -> store -> agent -> handlers -> transports.
- Keep handlers transport-agnostic and split by domain.
- Prefer hot reload over restart: file watcher -> config bus -> subscribers.
- Built-in and third-party atom packs must load through the same manifest-gated path.
- Hot paths must parse at edges, prepare statements once, and bound growing state.
- Any feature touching daemon behavior must match over TCP loopback and Unix socket.
- See `docs/internals/runtime.md` / @docs/internals/runtime.md,
  `docs/engineering/security-guidelines.md` / @docs/engineering/security-guidelines.md, and
  `docs/engineering/performance-guidelines.md` / @docs/engineering/performance-guidelines.md.

### `@monad/client` and `@monad/client-rtk`

`@monad/client` is the daemon API client: Treaty, SSE, WebSocket, stream parsing, and
version checks. `@monad/client-rtk` is the shared RTK Query cache layer for web and TUI.

- Client code never imports daemon implementation or home internals.
- Validate every event frame with protocol schemas before handing it to callers.
- Add RTK endpoints as one file per operation under `src/endpoints/<domain>/`.
- Use `clientOf(api)` and `runTreaty`; do not hand-roll Treaty error handling.
- Normalize list responses with entity adapters; use tag invalidation and
  `onQueryStarted` optimistic patches.
- Stream generation over per-session SSE and lifecycle over control WS; never merge the
  two planes. See `docs/internals/realtime-channels.md` / @docs/internals/realtime-channels.md.

### Apps: CLI, Web, TUI

- `apps/cli` is a thin client. It starts/resolves the daemon, dispatches through
  `@monad/client`, localizes human output through `@monad/i18n`, and keeps `--json`
  machine output untranslated. CLI design: `docs/engineering/cli-design.md` / @docs/engineering/cli-design.md.
- `apps/web` is a daemon-control UI. Server state lives in the daemon and RTK cache;
  do not add business logic to React components. UI rules: `docs/design/ui-guidelines.md`
  / @docs/design/ui-guidelines.md, `docs/design/ux-guidelines.md` /
  @docs/design/ux-guidelines.md, and copy rules in `docs/design/ux-writing-guidelines.md`
  / @docs/design/ux-writing-guidelines.md.
- `apps/tui` is an Ink renderer over the shared client/RTK layers. It must not fork
  endpoint or cache logic from `@monad/client-rtk`.

### Atoms and SDK

`@monad/sdk-atom` defines the authoring contract. `@monad/atoms` is the built-in atom
pack using that contract.

- Preserve declare-then-register: a manifest must declare a kind before runtime
  registration succeeds.
- File-based kinds (`skill`, `mcp`, `locale`) bypass JS registration by design; do not
  route them through `register()`.
- Channel adapters do platform I/O only; the daemon owns session/store/agent wiring.
- New channels must meet conformance. See `docs/internals/channel-conformance.md` /
  @docs/internals/channel-conformance.md, `docs/usage/skills.md` / @docs/usage/skills.md, and
  `docs/internals/model-providers.md` / @docs/internals/model-providers.md.

### `@monad/ui`

Headless component library: Radix primitives, Tailwind, CVA, and shared presentation
only.

- One file per component; merge classes with `cn()`.
- Variants belong in CVA definitions, not ad-hoc conditional strings.
- No data layer imports: no protocol, home, client, or daemon packages.
- App-specific composition belongs in `apps/web/components/`.
- See `docs/design/ui-guidelines.md` / @docs/design/ui-guidelines.md and
  `docs/engineering/design-principles.md` / @docs/engineering/design-principles.md.
