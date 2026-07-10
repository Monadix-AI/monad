# Sidebar and Session Component Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove excessive flattened props and multi-level prop forwarding from the sidebar and session content area without changing behavior or markup semantics.

**Architecture:** Session rendering consumes an explicit four-slice `SessionRouteModel` and delegates each slice to a focused region component. Sidebar rendering keeps frame mechanics local, groups pager/footer configuration, and injects workspace-tree state/actions/meta through a provider scoped to the workspace surface.

**Tech Stack:** React 19, TypeScript, Zustand, RTK Query, Bun test, Playwright, Biome.

## Global Constraints

- Preserve existing UI, class names, accessibility, routing, animation, and interaction behavior.
- Keep RTK Query as the only server-data owner.
- Keep durable shared UI state in existing Zustand stores; do not store callbacks, refs, route models, or server entities there.
- Use props for one-level dependencies and local context only for the deeply nested workspace tree.
- Reuse the existing `SessionSidebarPanels`, `SessionSidebarResizeHandle`, and `useSessionSidebarActions` work instead of creating parallel implementations.

---

### Task 1: Session Route Contract and Regions

**Files:**
- Create: `apps/web/src/features/session/session-route-contract.ts`
- Create: `apps/web/src/features/session/SessionHeader.tsx`
- Create: `apps/web/src/features/session/SessionTranscript.tsx`
- Create: `apps/web/src/features/session/SessionComposerRegion.tsx`
- Create: `apps/web/src/features/session/SessionInspectorRegion.tsx`
- Modify: `apps/web/src/features/session/SessionRoute.tsx`
- Modify: `apps/web/src/features/session/use-session-route-model.ts`
- Modify: `apps/web/src/features/shell/page-shell/ShellRouteProvider.tsx`
- Modify: `apps/web/src/routes/_shell/sessions/$sessionId.tsx`
- Test: `apps/web/test/unit/session-route-contract.test.ts`

**Interfaces:**
- Produces: `SessionRouteModel` with `identity`, `transcript`, `composer`, and `inspector` slices.
- Produces: `SessionRoute({ model }: { model: SessionRouteModel })`.
- Keeps `SessionCommandMenuItem` in `command-menu.ts`; the contract imports it rather than exporting command types from the route component.

- [ ] Write a compile/runtime contract test importing `SESSION_ROUTE_MODEL_REGIONS` and asserting `['identity', 'transcript', 'composer', 'inspector']`.
- [ ] Run `bun run --cwd apps/web test:unit -- test/unit/session-route-contract.test.ts` and confirm it fails because the contract module does not exist.
- [ ] Add the contract and region components, then reshape `useSessionRouteModel` to return `sessionRouteModel`.
- [ ] Update shell context and route wiring to pass one `model` prop.
- [ ] Run the focused unit test and `bunx tsc --noEmit` from `apps/web`.

### Task 2: Workspace Sidebar Provider and Grouped Panel Configuration

**Files:**
- Create: `apps/web/src/features/shell/sidebar/workspace-sidebar-context.tsx`
- Modify: `apps/web/src/features/shell/sidebar/workspace-items.tsx`
- Modify: `apps/web/src/features/shell/sidebar/workspace-project-list.tsx`
- Modify: `apps/web/src/features/shell/sidebar/chat-session-list.tsx`
- Modify: `apps/web/src/features/shell/SessionSidebarPanels.tsx`
- Modify: `apps/web/src/features/shell/SessionSidebar.tsx`
- Test: `apps/web/test/unit/workspace-sidebar-context.test.ts`

**Interfaces:**
- Produces: `WorkspaceSidebarContextValue = { state, actions, meta }`.
- Produces: `WorkspaceSidebarProvider` scoped to `WorkspaceSidebarItems`.
- Produces: grouped `SessionSidebarPanelsProps = { pager, workspace, settings, studio, footer }` rather than a 50-field flat interface.

- [ ] Write a contract test importing `WORKSPACE_SIDEBAR_CONTEXT_GROUPS` and asserting `['state', 'actions', 'meta']`.
- [ ] Run `bun run --cwd apps/web test:unit -- test/unit/workspace-sidebar-context.test.ts` and confirm it fails because the module does not exist.
- [ ] Add the workspace provider and hooks, then make project/session list components consume actions/meta directly.
- [ ] Group panel props by surface and footer responsibility while preserving existing JSX and classes.
- [ ] Run focused sidebar unit tests and `bunx tsc --noEmit` from `apps/web`.

### Task 3: Regression Verification

**Files:**
- Verify: `apps/web/test/e2e/sidebar-interactions.spec.ts`
- Verify: `apps/web/test/e2e/shell-navigation.spec.ts`

**Interfaces:**
- Consumes the refactored public component contracts; produces no new runtime API.

- [ ] Run Biome on all touched files and inspect formatting changes.
- [ ] Run `bunx tsc --noEmit` from `apps/web`.
- [ ] Run all focused unit tests for session view, workspace project lists, and the new contracts.
- [ ] Run sidebar interaction and shell navigation Playwright tests.
- [ ] Inspect `git diff --check` and confirm no unrelated files were modified by tooling.
