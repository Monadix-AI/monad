---
title: "Workplace Experiences"
description: "Shipped implementation of what was proposed as \"project presets\" — swappable, full-page UI skins over a project's data."
---
Shipped implementation of what was proposed as "project presets" — swappable,
full-page UI skins over a project's data.

**Web UI only.** An experience is a rendering layer in `apps/web`; the CLI, TUI, editors
(ACP), and IM channels never load one. Selection is stored in browser
`localStorage`, so it is per-device, not per-session and not per-user. Anything that
must work on every surface belongs in the daemon — a tool, command, hook, or protocol
contract — not in an experience.

This doc records the real shape as built;
see [`architecture.md`](/engineering/architecture) for the `@monad/sdk-experience`
package split.

## What exists

- **`@monad/sdk-experience`** — the React-free host-API contract + web-component event
  bridge (root export), plus `@monad/sdk-experience/react` (RTK hook re-exports for
  host-component atoms). See architecture.md's "Recorded decision" section.
- **`workplace-experience` atom kind** — `packages/protocol/src/atom-pack.ts` (the
  proposal called this `view`; shipped name differs).
- **Registry + renderer** — `apps/web/src/features/workplace/experiences/`: `registry.ts`,
  `WorkplaceExperienceRenderer.tsx`, `builtin/` (host wrapper for the one built-in experience,
  `chat-room`, which lives in `packages/atoms/src/workplace-experiences/`), and
  `web-component/` (third-party lazy-load path via `WebComponentExperience.tsx` +
  `registerWorkplaceExperience` in `@monad/sdk-atom`).
- **Selection persistence** — browser `localStorage`
  (`apps/web/src/features/workspace/use-project-view-mode.ts`), not
  `session.origin.ext`. This means preset choice is **per-device**, not synced across
  clients — a deliberate divergence from the original per-session-sync design.

## Host contract

- **Two shapes.** First-party experiences are React host components; every other experience
  is a Web Component over the event bridge, optionally with one daemon-side HTTP-only Elysia
  backend. `AtomPackRegistry.registerWorkplaceExperience` enforces the split — a
  `host-component` entry from any pack but `monad-builtins` is rejected.
- **One definition.** `workplaceExperienceDefinitionSchema` binds identity, the component
  entry, the optional API routes, and the host-stamped permissions.
- **A thin bridge.** The host hands over identity, the project snapshot, the permitted
  actions, `apiBaseUrl`, and a few bounded services (`requestProjectDialog`, `openStudio`).
  Experiences code against the published `@monad/sdk-experience` contract — not the host's
  Redux store, its router, or daemon internals.
- **Selection is client-local.** It lives in browser `localStorage`. No project, session,
  template, or daemon record owns a preferred experience.
- **Backends do not own state.** A backend handler receives
  `WorkplaceExperienceApiContext` — pack/experience identity, `projectSessions`,
  `projectMembers`, `requestInteraction`, plus host-managed `experienceState` (a scoped KV
  in the `experience_state` table) and `workerScheduler`. It drives shared state through
  those daemon services rather than opening a second persistence or ownership layer.
- **Backends activate with the pack, not with the selection.** API routes and experience
  workers register when the pack loads, so a backend runs whether or not anyone is looking
  at its experience.
- **Business errors stay inside the backend contract.** The host's failure categories below
  describe only what the host could not do.

## Which packs may contribute one

Being granted the `workplace-experience` atom kind is not enough. An experience runs
in-process in the Web host and drives project state, so the daemon derives a separate
acceptance decision per pack at load time — `resolveAtomPackExperienceTrust`
(`apps/monad/src/atoms/trust.ts`), from the pack's `.install.json`:

| Evidence | Outcome |
| --- | --- |
| No install record (drop-in dir) | refused |
| Recorded consent without `workplace-experience` | refused |
| `local` source, kind consented | accepted |
| `github`/`npm` source with a recorded integrity hash | accepted |
| `github`/`npm` source without one | refused |
| Record with no `sourceKind` (pre-dates source tracking) | refused, reinstall |

A mutable ref is not disqualifying on its own — the recorded hash is what pins the bundle,
and discovery re-verifies it on every load, so a later upstream swap cannot take effect.
Trust is derived, never stored: a `trusted` flag inside the pack dir would be self-service
escalation for anything that can write there.

A refused pack loses only its experience atoms — the definition, its API routes, and its
worker. Its channels, providers, and hooks still load, and each refusal is logged with its
reason. Built-in packs skip the check.

On top of that evidence, the operator's own review decides, via
`atomExperienceReview` in `config.json`:

```jsonc
{
  "atomExperienceReview": {
    "policy": "evidence",   // or "allowlist": admit only the packs named in `allow`
    "allow": [],            // per-pack operator review — also waives short evidence
    "deny": []              // always wins
  }
}
```

`allow` deliberately overrides missing evidence: a human who audited a pack is a stronger
signal than an install record, and making that an explicit per-pack entry keeps it from
becoming a blanket "trust everything" switch. `deny` beats everything, including `allow`.

## Reload

The rediscovery sweep (`apps/monad/src/atoms/reload.ts`, triggered by the atom-pack API and
by the `~/.monad/atoms` watcher) is build-then-swap:

1. **Construct** — every registration from every pack lands in a throwaway `AtomPackRegistry`
   plus local buffers for commands, providers, conflicts, and per-pack atom details. Locale
   packs load here too. Nothing touches live state.
2. **Swap** — `AtomPackRegistry.adoptReloadableAtoms` replaces hooks, experiences, their API
   routes, and their workers in one synchronous pass; commands and providers replay
   already-validated input. No step in this phase can reject a pack, so a reader never
   observes a half-populated registry.
3. **Drain** — `syncExperienceWorkers` closes worker admission, waits for the in-flight
   deliveries to settle against the pack that accepted them, then rebinds and resumes
   (`ExperienceWorkerRegistry.drain` / `resume`).
4. **Deactivate** — packs the sweep dropped get their optional `deactivate()` called
   (`apps/monad/src/atoms/deactivate.ts`). Last, deliberately: a pack's own resources must
   outlive the swap and the drain, so it is torn down only once the replacement set is live
   and the work it accepted has finished. Keyed by pack identity in a `WeakSet`, so a pack
   dropped twice is torn down once, and a teardown that throws is logged without failing the
   sweep.

A sweep that throws before the swap leaves the previous working set serving. Tools and
connectors are wired once at startup and are not part of a sweep.

## Authoring one

Monad ships no builder for experience authors. Build the two files with `bun build` (or
anything else) and the daemon holds the contract:

- **Daemon entry** — `manifest.entry`, the pack bundle that calls
  `registerWorkplaceExperience` (and optionally `registerWorkplaceExperienceApi`).
- **Browser module** — the experience's `entry.module`, a same-origin ES module that
  defines the custom element. These are two declared paths, not a code-splitting result,
  so keeping backend code out of the browser module is a matter of file layout.

`checkExperienceBrowserChunk` (`apps/monad/src/atoms/browser-chunk.ts`) refuses to serve a
browser module that imports a `node:`/`bun:` builtin, a daemon-side `@monad/*` package, a
`#/` host-private alias, or React. Violations surface as snapshot warnings and the
experience is absent from `/v1/atoms/workplace-experiences` — the same shape as any other
unserviceable entry. React is excluded because a third-party experience is always a Web
Component; only first-party experiences are host components.

Assets are served from `/v1/atoms/<pack>/assets/<path>?v=<hash>`, where the hash is the
install-recorded bundle integrity, shortened. A reinstall changes it, so the browser
re-fetches the module instead of serving the previous one from cache.

Local loop: `monad atom install local:<path>`, then edit and reinstall — the rediscovery
sweep picks it up without a daemon restart. `@monad/monad-power-pack` is the reference
implementation to copy.

## Failure boundary

Host failures are structural — what the host could not do, never what a third-party
backend's own logic reported. The categories live in
`apps/web/src/features/workplace/experiences/failure.ts`:

| Category | Raised when |
| --- | --- |
| `invalid-definition` | The definition cannot be rendered as written (bad custom-element name, unknown built-in component) |
| `activation` | The host refused to activate it — currently a cross-origin module |
| `availability` | Its module or asset could not be fetched |
| `component-load` | The module loaded but never defined the element it declares |
| `render` | The mounted component threw while rendering |

All five render through `WorkplaceExperienceFailureView`, which offers `Try again` only for
the categories a retry can actually change (`availability`, `component-load`, `render`) and
keeps the raw detail behind a disclosure. `WorkplaceExperienceErrorBoundary` wraps both
render paths; the project rail, transcript, and experience menu sit outside it, so a broken
experience never takes the selection context with it. Changing the selected experience
resets the boundary.

## Management isolation

An experience never receives the host's full action surface. `WorkplaceExperienceRenderer`
narrows the view through `restrictProjectExperienceView`
(`apps/web/src/features/workplace/experiences/restrict-view.ts`), which calls
`restrictWorkplaceExperienceActions` from `@monad/sdk-experience`: an action whose required
permission was not granted is replaced by a stub that throws
`WorkplaceExperiencePermissionError` instead of reaching the host callback. Both render
paths — host-component and web-component — go through that one chokepoint.

The grants are the **atom pack manifest's** `permissions`, stamped onto the definition by
`AtomPackRegistry.registerWorkplaceExperience`. A pack that sets `permissions` on the
definition object it ships cannot widen its own surface; the daemon overwrites the field.
`monad-builtins` is stamped with the full permission set.

The action → permission table lives in one place,
`WORKPLACE_EXPERIENCE_ACTION_PERMISSIONS` (`packages/sdk-experience/src/permissions.ts`).
`switchExperience` and `openProjectSession` are host navigation and need no permission;
everything else does. The restriction is written as an exhaustive object literal so a newly
added action fails typecheck until it is classified.

## Out of scope

This contract covers a **local, operator-reviewed** pack running in the operator's own
browser. It is not a claim that an arbitrary pack is safe to run. Unreviewed third-party
distribution, a marketplace or registry, process/Realm isolation for experience code, and a
general capability system beyond the manifest permissions above are separate designs, none
of them started.
