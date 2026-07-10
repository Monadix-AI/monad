# Right Panel Content Ownership Design

## Problem

The shell owns one persistent right-panel portal target while session routes own the content rendered into it. The current provider tracks only a content count, so content from the previous session remains valid until React runs its cleanup. During a route transition that allows the previous inspector to render for at least one frame.

Component keys and layout effects can shorten the stale frame, but neither expresses which route owns the mounted content. Correctness currently depends on effect timing.

## Design

The shell provides an active `ownerId` derived from the current route identity. Right-panel content must declare the same owner when it renders. The shared panel displays portal content only when the registered owner matches the active owner.

Registration is represented by an owner-aware registry rather than a reference count. A stale owner's unregister callback cannot remove a newer owner's registration. Route changes invalidate the previous registration synchronously during render, before passive or layout-effect cleanup runs.

The panel remains open and keeps its width during a session transition. Until content for the new owner is registered, its portal body is empty. Content from another owner is never shown as a placeholder.

## Boundaries

- `right-panel-ownership.ts` contains the pure ownership state transitions and is unit tested without React.
- `right-panel-context.tsx` binds ownership to React and the persistent portal slot.
- `RightPanelContent.tsx` declares its `ownerId` and portals only when that owner is active.
- `ShellRouteProvider.tsx` derives the active owner from the parsed shell route.
- `SessionRoute.tsx` passes `session:<sessionId>` as the inspector owner and no longer relies on keys for correctness.

## Verification

- Unit tests cover activation, stale registration rejection, and stale cleanup safety.
- The existing new-chat browser test starts with an old inspector open and asserts its marker is absent immediately after navigation to the draft session.
- Type checking and focused browser tests must pass.
