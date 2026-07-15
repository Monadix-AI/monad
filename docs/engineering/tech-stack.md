# Tech stack

A quick-reference map of every tool and library in the repo, organized by concern.

---

## Runtime & language

| Tool | Role |
|------|------|
| **[Bun](https://bun.sh)** | JS runtime, package manager, bundler, test runner — replaces Node/npm/jest/webpack entirely |
| **TypeScript 7** | Language and fast native type-checker; strict mode throughout |

## Monorepo

| Tool | Role |
|------|------|
| **[Turborepo](https://turbo.build)** | Task graph, remote caching, parallel builds across `apps/` and `packages/` |
| **[Syncpack](https://github.com/JamieMason/syncpack)** | Keeps package version ranges in sync across the monorepo |
| **Bun workspaces** | Module resolution within the `@monad/*` scope |

## Code quality & git hooks

| Tool | Role |
|------|------|
| **[Biome](https://biomejs.dev)** | Linting + formatting (replaces ESLint + Prettier) |
| **[Lefthook](https://github.com/evilmartians/lefthook)** | Git hooks runner — delegates read-only pre-commit checks to the shared quality gate |
| **Commitlint + Commitizen** | Enforces Conventional Commits on every commit message |
| **[Rulesync](https://github.com/dyoshikawa/rulesync)** | Compiles committed `.rulesync/rules/` into gitignored local targets for supported agents |

## Backend daemon (`apps/monad`)

| Tool | Role |
|------|------|
| **[Elysia](https://elysiajs.com)** | HTTP + WebSocket server (runs on `Bun.serve` under the hood) |
| **[Drizzle ORM](https://orm.drizzle.team)** | Type-safe SQL query builder; migrations live in `packages/store` |
| **`bun:sqlite`** | Embedded SQLite — primary persistence layer (no external DB required) |
| **`Bun.redis`** | In-process KV store (`packages/kv`) |
| **[Zod v4](https://zod.dev)** | Schema validation at all wire boundaries (HTTP/WS/disk) |
| **[OpenTelemetry](https://opentelemetry.io)** | Tracing + metrics exported via OTLP |
| **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)** | MCP client (stdio + HTTP transports) |
| **[@agentclientprotocol/sdk](https://github.com/agentclientprotocol)** | ACP server — exposes the daemon as an ACP agent to editors |

## AI / agent layer (`packages/agent-core`)

| Tool | Role |
|------|------|
| **[Vercel AI SDK](https://sdk.vercel.ai)** | Model provider abstraction; streaming tool-call loop |
| **Provider plugins** | First-party adapters wrap AI SDK; loaded via `@monad/plugins` |

## Web UI (`apps/web`)

| Tool | Role |
|------|------|
| **[Vite](https://vite.dev)** | Development server and production SPA build (`out/`) |
| **[TanStack Router](https://tanstack.com/router)** | Type-safe file-based client routing and generated route tree |
| **[React 19](https://react.dev)** | UI framework; React Compiler enabled |
| **[Tailwind CSS v4](https://tailwindcss.com)** | Utility-first CSS; PostCSS pipeline |
| **[Redux Toolkit](https://redux-toolkit.js.org) + React-Redux** | Global client state (sessions, messages, config) |
| **[Streamdown](https://github.com/nicolo-ribaudo/streamdown)** | Incremental Markdown rendering for streaming assistant output |
| **[Lucide React](https://lucide.dev)** | Icon set |
| **[i18next](https://www.i18next.com) + react-i18next** | Internationalisation; language packs ship as drop-in locale plugins |

## TUI (`apps/tui`)

| Tool | Role |
|------|------|
| **[Ink](https://github.com/vadimdemedes/ink)** | React renderer for the terminal |
| **[Zustand](https://zustand-demo.pmnd.rs)** | Local TUI state (lighter than Redux for a single-process terminal) |
| **Redux Toolkit + React-Redux** | Shared session/message state (mirrors the web layer) |

## CLI (`apps/cli`)

| Tool | Role |
|------|------|
| **[CAC](https://github.com/cacjs/cac)** | Lightweight command-line argument parser |

## Testing

| Tool | Role |
|------|------|
| **`bun test`** | Unit and integration tests; E2E tests run over both TCP and Unix-socket transports |
| **Playwright** | Browser-based E2E for the web UI (path configured via `PLAYWRIGHT_BROWSERS_PATH`) |

## Release & CI

| Tool | Role |
|------|------|
| **[release-please](https://github.com/googleapis/release-please)** | Automated changelog + version bump PRs from Conventional Commits |
| **GitHub Actions** | CI matrix: macOS, Linux, Windows; Docker musl stage for static builds |

---

## Key constraints

- **No Node.js** — everything runs on Bun. Don't introduce `node`, `ts-node`, `jest`, `webpack`, `express`, `pg`, `ioredis`, `better-sqlite3`, or `ws`.
- **No external DB at runtime** — SQLite + Bun KV only; the daemon must work offline with zero infra.
- **Schema-first at boundaries** — every HTTP/WS/disk boundary uses a Zod schema as the single source of truth; never cast external data.
