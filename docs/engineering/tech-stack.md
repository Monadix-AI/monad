---
title: "Tech Stack"
description: "A quick-reference map of every tool and library in the repo, organized by concern."
---
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
| **[mise](https://mise.jdx.dev)** | Pins the toolchain, loads the per-worktree `.env.local`, and owns the `quality:*` task graph |
| **[Syncpack](https://github.com/JamieMason/syncpack)** | Keeps package version ranges in sync across the monorepo |
| **[Knip](https://knip.dev)** | Reports unused files, exports, and dependencies (check-only — never `--fix`) |
| **Bun workspaces** | Module resolution within the `@monad/*` scope |

## Code quality & git hooks

| Tool | Role |
|------|------|
| **[Biome](https://biomejs.dev)** | Linting + formatting (replaces ESLint + Prettier) |
| **[Lefthook](https://github.com/evilmartians/lefthook)** | Git hooks runner — runs fast staged-only fixes and checks |
| **Commitlint + Commitizen** | Enforces Conventional Commits on every commit message |
| **[Rulesync](https://github.com/dyoshikawa/rulesync)** | Compiles committed `.rulesync/rules/` into gitignored local targets for supported agents |

## Backend daemon (`apps/monad`)

| Tool | Role |
|------|------|
| **[Elysia](https://elysiajs.com)** | HTTP + WebSocket server (runs on `Bun.serve` under the hood) |
| **[Drizzle ORM](https://orm.drizzle.team) + drizzle-kit** | Type-safe SQL query builder; schema in `apps/monad/src/store/db`, migrations in `apps/monad/drizzle` |
| **`bun:sqlite`** | Embedded SQLite — primary persistence layer (no external DB required) |
| **`Bun.redis`** | In-process KV store (`apps/monad/src/store/kv`) |
| **[Zod v4](https://zod.dev)** | Schema validation at all wire boundaries (HTTP/WS/disk) |
| **[OpenTelemetry](https://opentelemetry.io)** | Tracing + metrics exported via OTLP (OpenInference semantic conventions) |
| **[@modelcontextprotocol](https://github.com/modelcontextprotocol/typescript-sdk) `core`/`client`/`server`** | MCP client (stdio + HTTP transports) and the agent-facing MCP server |
| **[@agentclientprotocol/sdk](https://github.com/agentclientprotocol)** | ACP server — exposes the daemon as an ACP agent to editors |
| **[@a2a-js/sdk](https://github.com/a2aproject/a2a-js)** | A2A server — exposes an agent as a standard Agent2Agent agent |
| **[mem0ai](https://github.com/mem0ai/mem0)** | Optional semantic-memory backend (local Qdrant managed by the daemon) |

## AI / agent layer (`apps/monad/src/agent`, `@monad/atoms`)

| Tool | Role |
|------|------|
| **[Vercel AI SDK](https://sdk.vercel.ai)** | Used internally by the first-party provider adapters in `@monad/atoms` |
| **Provider atoms** | Model backends registered through `@monad/sdk-atom`; the contract itself is ai-sdk-free |

## Web UI (`apps/web`, `@monad/ui`)

| Tool | Role |
|------|------|
| **[Vite](https://vite.dev)** (rolldown build) | Development server and production SPA build (`out/`) |
| **[TanStack Router](https://tanstack.com/router)** | Type-safe file-based client routing and generated route tree |
| **[React 19](https://react.dev)** | UI framework; React Compiler enabled |
| **[Tailwind CSS v4](https://tailwindcss.com)** | Utility-first CSS; PostCSS pipeline |
| **[Redux Toolkit](https://redux-toolkit.js.org) + React-Redux** | Global client state via `@monad/client-rtk` (sessions, messages, config) |
| **[Streamdown](https://github.com/vercel/streamdown) + [Shiki](https://shiki.style)** | Incremental Markdown rendering and syntax highlighting (in `@monad/ui`) |
| **[Hugeicons](https://hugeicons.com)** | Icon set — named imports only, never the barrel |
| **`@monad/i18n`** | In-house message catalogs (`packages/i18n/src/locales/<lng>/<namespace>.json`); language packs ship as `locale` atoms |

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

## Sandboxing (`@monad/sandbox`, `@monad/sandbox-vm`)

| Tool | Role |
|------|------|
| **Seatbelt / bubblewrap + Landlock + seccomp / AppContainer** | Per-OS lightweight launchers, compiled from `apps/monad/native/sandbox-launcher` |
| **Local egress proxy** | Muxed HTTP CONNECT + SOCKS5 domain filtering, optional TLS termination |
| **QEMU/KVM · vfkit · Hyper-V** | Optional VM backend with a Go guest agent (`packages/sandbox-vm/native`) |

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
