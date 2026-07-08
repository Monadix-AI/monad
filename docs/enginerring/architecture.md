# Architecture guidelines

> **Placeholder.** Fill this in with the canonical module boundaries, dependency rules,
> and decision records for the system's functional design.

## Areas to cover

- Package/app responsibility boundaries (`@monad/*` scope)
- Allowed dependency directions (what may import what)
- Extension points: where to add new features vs. where not to
- Key design decisions and why (link to `docs/proposals/` where relevant)
- Anti-patterns specific to this codebase

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
