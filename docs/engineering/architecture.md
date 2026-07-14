# Architecture guidelines

This document records the codebase boundaries that should stay stable as monad
grows. For the daemon startup graph and runtime lifecycle, see
[daemon-architecture.md](../internals/daemon-architecture.md). For transport and security
posture, see [runtime.md](../internals/runtime.md).

## Package and app boundaries

| Area | Owns | Must not own |
|---|---|---|
| `@monad/protocol` | Wire/domain schemas, RPC method table, ids, shared events | Runtime logic, daemon imports, UI-only view models |
| `@monad/home` | `~/.monad` layout, config/auth/profile parsing and persistence | Daemon lifecycle, tools, model routing, UI logic |
| `apps/monad` | Long-lived daemon runtime: store, agent loop, tools, MCP, atoms, channels, transports | Client-only cache, React UI state |
| `@monad/client` | Type-safe daemon API client and stream parsing | Daemon implementation details |
| `@monad/client-rtk` | Shared RTK Query cache/endpoints | Endpoint implementations, daemon business logic |
| `apps/cli` | Scriptable command surface over the daemon client | Direct daemon store/model/tool access |
| `apps/web` | Browser UI over daemon APIs | Server authority or daemon-only business logic |
| `apps/tui` | Terminal UI over shared client/cache layers | Forked endpoint logic |
| `@monad/sdk-atom` | Third-party atom authoring contract | Daemon state, filesystem layout, web UI contracts |
| `@monad/ui` | Headless presentation components | Data fetching, daemon/client imports |

## Dependency direction

- Protocol and home packages sit below executable apps.
- Clients depend on protocol contracts, not daemon implementation.
- Daemon domains may depend on protocol and home contracts, but extension SDKs
  must not depend on daemon internals.
- UI packages consume client/cache layers; they do not import `apps/monad`.
- Runtime boundary types are schema-first at process, HTTP, WebSocket, file, MCP,
  atom, and skill boundaries.

## Daemon module ownership

The daemon uses explicit lifecycle modules for long-lived resources. A module
belongs beside the behavior it manages:

- `store/lifecycle.ts` owns persistence startup and shutdown.
- `platform/sandbox/lifecycle.ts` owns sandbox setup.
- `agent/model/lifecycle.ts` owns model services, provider discovery, and
  embedding indexer lifecycle.
- `capabilities/lifecycle.ts` owns stable first-party tool and command registries.
- `atoms/lifecycle.ts` owns atom discovery.
- `capabilities/skills/lifecycle.ts` owns skill discovery and watch integration.
- `capabilities/mcp/lifecycle.ts` owns MCP connection state.

`runtime/create.ts` assembles descriptors into `RuntimeKernel`; it is not a
business-logic dumping ground. `application/lifecycle.ts` orchestrates process
startup, application services, handlers, and transport launch.

## Extension points

Prefer public extension surfaces over daemon imports:

- Skills for procedural knowledge and tool-use recipes.
- Atom packs for skills, channels, MCP servers, providers, hooks, and other
  declared extension kinds.
- MCP for external tools.
- Command hooks or atom hooks for agent-loop policy and observability.
- Protocol/client packages for API integrations.

Third-party developers should not import `apps/monad` internals. If an extension
needs a new stable contract, add or extend the appropriate protocol or SDK package
instead of leaking daemon implementation types.

## Anti-patterns

- Reintroducing a central `bootstrap/` hierarchy for daemon behavior that already
  has an owning domain.
- Putting runtime service instances into Zustand. Zustand is for serializable
  lifecycle state; service outputs live in `RuntimeContext`.
- Creating a second config implementation outside `@monad/home`.
- Using RxJS, revision queues, or global event logs for local config hot reload.
  Use `ConfigService` and module reload hooks.
- Adding feature-specific `process.platform` branches outside a thin platform
  adapter.
- Redeclaring wire/domain types in consumers instead of deriving from the schema
  producer.
- Adding UI-only state to protocol packages or daemon-only state to UI packages.

## Recorded decision: `@monad/sdk-experience`

The workspace-experience SDK is **one package with two entry points, split on the React
boundary by subpath** — so a third-party **web-component** experience author can type the host
API without pulling in React, while a **host-component** author gets the RTK hooks from the same
package.

- **`@monad/sdk-experience` (root)** — the React-free **contract**: the published
  snapshot/actions/host-API types plus the framework-agnostic runtime helpers
  (`WORKSPACE_EXPERIENCE_API_VERSION`, `defineWorkspaceExperience`,
  `isWorkspaceExperienceApiCompatible`, `bindWorkspaceExperience`, the DOM event bridge).
  Dependencies: `@monad/protocol` only, **zero React**. `web-component` atoms (external custom
  elements, e.g. graph-view) can't use React hooks and stay on this event-bridge contract.
- **`@monad/sdk-experience/react`** — a curated re-export subset of `@monad/client-rtk`'s RTK
  Query hooks, scoped to what `host-component` (React) atoms in `@monad/atoms` need. It must never
  grow a second implementation of an endpoint; every export re-exports a hook that already exists
  in `@monad/client-rtk`. `react`/`react-redux` are **optional peer deps** — importing the root
  never pulls them in. This works because built-in host-component experiences render inside the
  host app's Redux `<Provider>` (see `apps/web/lib/monad-store.ts` / `monad-runtime-provider.tsx`).

Keeping both halves in one package (rather than two sibling packages) means experience authors have
a single dependency; the subpath — not a package boundary — carries the React split. `@monad/sdk-atom`
stays the pure atom-authoring adapter contract (protocol + zod only), unrelated to this package.
`WorkspaceExperienceDefinition`/`Entry`/`HostApi` remain wire types in `@monad/protocol`; the daemon
consumes those directly.
