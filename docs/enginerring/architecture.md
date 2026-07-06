# Architecture guidelines

> **Placeholder.** Fill this in with the canonical module boundaries, dependency rules,
> and decision records for the system's functional design.

## Areas to cover

- Package/app responsibility boundaries (`@monad/*` scope)
- Allowed dependency directions (what may import what)
- Extension points: where to add new features vs. where not to
- Key design decisions and why (link to `docs/proposals/` where relevant)
- Anti-patterns specific to this codebase

## Recorded decision: `@monad/sdk-atom-client-rtk`

`host-component` (React) workspace-experience atoms in `@monad/atoms` may depend on
`@monad/sdk-atom-client-rtk` — a curated re-export subset of `@monad/client-rtk`'s RTK
Query hooks, scoped to what atom authors need. It must never grow a second
implementation of an endpoint; every export in it re-exports a hook that already
exists in `@monad/client-rtk`. This works because built-in host-component experiences
render inside the host app's Redux `<Provider>` (see `apps/web/lib/monad-store.ts` /
`monad-runtime-provider.tsx`). `web-component` atoms (loaded as external custom
elements, e.g. graph-view) can't use React hooks and stay on the `WorkspaceExperienceHostApi`
event-bridge contract from `@monad/protocol`. `@monad/sdk-atom` itself stays
dependency-free (protocol + zod only) — `sdk-atom-client-rtk` is a sibling package, not
a subpath of it.
