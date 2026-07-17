# Workspace experiences

Shipped implementation of what was proposed as "project presets" — swappable,
full-page UI skins over a project's data. This doc records the real shape as built;
see [`architecture.md`](../engineering/architecture.md) for the `@monad/sdk-experience`
package split.

## What exists

- **`@monad/sdk-experience`** — the React-free host-API contract + web-component event
  bridge (root export), plus `@monad/sdk-experience/react` (RTK hook re-exports for
  host-component atoms). See architecture.md's "Recorded decision" section.
- **`workspace-experience` atom kind** — `packages/protocol/src/atom-pack.ts` (the
  proposal called this `view`; shipped name differs).
- **Registry + renderer** — `apps/web/src/features/workplace/experiences/`: registry,
  renderer, `builtin/` (one built-in: `chat-room`), `web-component/` (third-party
  lazy-load path via `WebComponentExperience.tsx` +
  `registerWorkspaceExperience` in `@monad/sdk-atom`).
- **Selection persistence** — browser `localStorage` (`use-project-view-mode.ts`), not
  `session.origin.ext`. This means preset choice is **per-device**, not synced across
  clients — a deliberate divergence from the original per-session-sync design.

## Known gap: management isolation is not enforced

The original design's central invariant was that a preset/experience is **structurally
incapable of management** — it receives only a read-only canvas projection, never the
full controller. As shipped, `runtime.ts:122-139` exposes management actions
(`resolveApproval`, `pauseAll`, `addProjectMember`) directly to experiences. This is a
real divergence from the intended trust boundary, not just a naming change — a
third-party workspace-experience atom currently has a wider action surface than the
design intended. Revisit before shipping a second built-in or opening this kind to
untrusted third parties.
