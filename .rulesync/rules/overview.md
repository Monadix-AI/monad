---
root: true
targets: ["*"]
description: "Monad agent instructions — conventions for all coding agents"
globs: ["**/*"]
---

# Agent instructions

Conventions for working in this repo. These apply to **all** coding agents (Claude
Code, Cursor, Copilot, Gemini, ...). Keep this short and imperative; depth lives in
`docs/` and is referenced here.

> **Single source of truth:** this content lives in `.rulesync/rules/` and is
> compiled by [rulesync](https://github.com/dyoshikawa/rulesync) into `AGENTS.md`,
> `CLAUDE.md`, and other agent files. **Edit `.rulesync/rules/`, never generated
> agent files**, then run `bun run agents:sync`.

## Reference docs
@docs/conventions.md
@docs/enginerring/architecture.md
@docs/design-principles.md
@docs/security-guidelines.md
@docs/cli-design.md
@docs/performance-guidelines.md
@docs/runtime.md
@docs/realtime-channels.md
@docs/channel-conformance.md
@docs/skills.md
@docs/model-providers.md
@docs/design/ui-guidelines.md
@docs/design/ux-guidelines.md
@docs/design/ux-writing-guidelines.md
@docs/worktree.md
@docs/parallel-agents.md
@docs/enginerring/testing.md

## Runtime: Bun only

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` / `yarn install` / `pnpm install`
- Use `bun run <script>` instead of `npm run` / `yarn run` / `pnpm run`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads `.env`, so don't use `dotenv`.
- Prefer Bun-native APIs: `Bun.serve`, `bun:sqlite`, `Bun.redis`, `Bun.sql`,
  built-in `WebSocket`, `Bun.file`, and `Bun.$`.
- Gate environment-specific code on plain `NODE_ENV` checks so bundlers can
  dead-code-eliminate unused branches.

## Code style

Full rules: `docs/conventions.md` / @docs/conventions.md.

- Write no comments by default. Add one only for a non-obvious invariant,
  hidden constraint, or counter-intuitive decision.
- Split files past roughly 300-400 lines along responsibility boundaries.
- Extract shared logic when the second copy appears; name it for behavior, not origin.
- Use `Promise.all` when awaits have no data dependency.
- No new feature env vars: user settings belong in `config.json`, daemon modes in argv.

## Architecture

Package boundaries and dependency direction: `docs/enginerring/architecture.md` /
@docs/enginerring/architecture.md. Read before adding a package, moving a type, or
introducing a new dependency between existing layers.

## Product principles

Design each feature for both cross-platform parity and security-first containment.
Full rules: `docs/design-principles.md` / @docs/design-principles.md and
`docs/security-guidelines.md` / @docs/security-guidelines.md.

- Push platform-specific behavior behind a thin uniform interface; do not scatter
  `process.platform` branches through feature code.
- Treat all agent-reachable input as hostile: prompts, tool args, atom packs, MCP,
  skills, channel payloads, and persisted state.
- Keep CLI surfaces scriptable by default: canonical command names, `--json`, stdin
  `-`, stable exit codes, and XDG paths. CLI rules: `docs/cli-design.md` /
  @docs/cli-design.md.

## Performance

Rules, budgets, and profiling procedure: `docs/performance-guidelines.md` /
@docs/performance-guidelines.md.

- Measure before you change — no optimization lands without a before/after number.
- Backend hot path (per-token stream, SQLite, request handlers) stays allocation-free, `parse`s at the edge only, prepares statements once, and bounds everything that grows.
- Frontend hot path (transcript re-render per streamed token) stays under one frame — memoize messages, parse markdown incrementally, select narrowly from Redux, virtualize long lists.

## Types and contracts

Typing rules: `docs/conventions.md` / @docs/conventions.md.

- Single source of truth: one producer per type; consumers import and derive (`.pick()/.omit()/.extend()`, `Pick/Omit/&`), never redeclare.
- Data-layer types live with their producer: `@monad/protocol` for wire/domain,
  `@monad/home` for config and home layout, daemon store modules for DB rows.
- UI-only props, form state, and view-models stay in the UI app/package.
- Schema-first at runtime boundaries (HTTP/WS/disk): the zod schema is the definition;
  always `parse`, never cast external data.
- In-process-only types stay pure TS until they gain a wire boundary.
- Naming: `xxxSchema` + same-stem PascalCase type; when fields travel in path params, the full request schema is the truth and the body derives via `.omit()`.

## Responsibilities by area

### `@monad/protocol`

Single source of truth for wire/domain contracts: zod schemas, domain entities,
events, settings, RPC methods, IDs. Types only; no runtime logic and no monorepo
dependencies beyond `zod`.

- Define `xxxSchema`, then `export type Xxx = z.infer<typeof xxxSchema>`.
- One concept per file, re-exported from `src/index.ts`.
- Consumers derive shapes instead of redeclaring them.
- UI-only types do not belong here.
- See `docs/conventions.md` / @docs/conventions.md.

### `@monad/home`

Owns the daemon home boundary: `config.json`, `auth.json`, filesystem layout,
workspace context discovery, init flow, and client connection resolution.

- `src/config.ts` is the settings source of truth; add user-facing settings there.
- `src/paths.ts` is the only place that knows the `~/.monad` layout.
- Parse config/auth on load; never log secrets.
- Keep this layer below runtime modules: do not import `@monad/monad`, atoms, web, CLI,
  or other executable layers.
- See `docs/conventions.md` / @docs/conventions.md and
  `docs/security-guidelines.md` / @docs/security-guidelines.md.

### `apps/monad` daemon

Core runtime: transports, agent loop, store, MCP, atom loading, channels, providers,
config reload, and observability.

- Bootstrap in dependency order: config -> store -> agent -> handlers -> transports.
- Keep handlers transport-agnostic and split by domain.
- Prefer hot reload over restart: file watcher -> config bus -> subscribers.
- Built-in and third-party atom packs must load through the same manifest-gated path.
- Hot paths must parse at edges, prepare statements once, and bound growing state.
- Any feature touching daemon behavior must match over TCP loopback and Unix socket.
- See `docs/runtime.md` / @docs/runtime.md,
  `docs/security-guidelines.md` / @docs/security-guidelines.md, and
  `docs/performance-guidelines.md` / @docs/performance-guidelines.md.

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
  two planes. See `docs/realtime-channels.md` / @docs/realtime-channels.md.

### Apps: CLI, Web, TUI

- `apps/cli` is a thin client. It starts/resolves the daemon, dispatches through
  `@monad/client`, localizes human output through `@monad/i18n`, and keeps `--json`
  machine output untranslated. CLI design: `docs/cli-design.md` / @docs/cli-design.md.
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
- New channels must meet conformance. See `docs/channel-conformance.md` /
  @docs/channel-conformance.md, `docs/skills.md` / @docs/skills.md, and
  `docs/model-providers.md` / @docs/model-providers.md.

### `@monad/ui`

Headless component library: Radix primitives, Tailwind, CVA, and shared presentation
only.

- One file per component; merge classes with `cn()`.
- Variants belong in CVA definitions, not ad-hoc conditional strings.
- No data layer imports: no protocol, home, client, or daemon packages.
- App-specific composition belongs in `apps/web/components/`.
- See `docs/design/ui-guidelines.md` / @docs/design/ui-guidelines.md and
  `docs/design-principles.md` / @docs/design-principles.md.

## Dev environment

Default workflow: never develop in the main checkout. Every feature, including
single-file fixes, should happen in a dedicated git worktree unless the user explicitly
asks to work on main. Full procedure: `docs/worktree.md` / @docs/worktree.md.

```sh
# from the main checkout
git worktree add ../monad-<feature> -b feat/<feature>
cd ../monad-<feature>
bun install && bun run dev
```

`bun run dev` is safe in multiple worktrees; ports are assigned per worktree. When
driving multiple agents in parallel, read `docs/parallel-agents.md` /
@docs/parallel-agents.md first.

## Testing

Use `bun run test` for the full suite. When targeting a package, directory, or
file, use `scripts/bun-test.ts ... --only-failures` so only failing case details
are printed. Full testing conventions and patterns: `docs/enginerring/testing.md` /
@docs/enginerring/testing.md.

- When running lint, typecheck, and tests as a quality gate, prefer one
  failure-collection pass that exposes all current errors before fixing them. Do not
  bounce between a single failing command and a single fix when the broader failure
  surface is available.
- Every `apps/monad` feature must be exercised over **all transports** (TCP
  loopback and the Unix socket) — behaviour must match on both. See
  `docs/runtime.md` / @docs/runtime.md.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend runtime

Use HTML imports with `Bun.serve()` for Bun-native frontends. Don't use Vite in new
Bun-served surfaces. HTML files can import `.tsx`, `.jsx`, `.js`, and CSS directly:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

```sh
bun --hot ./index.ts
```

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tools** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them. `codegraph_node` returns one symbol's source + callers, or reads a whole file with line numbers. If the tools are listed but deferred, load them by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` and `codegraph node <symbol-or-file>` print the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
