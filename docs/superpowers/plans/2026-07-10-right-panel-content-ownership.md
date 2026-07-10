# Right Panel Content Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a shared right panel from displaying content owned by the previous session during route transitions.

**Architecture:** Replace content presence counting with an owner-aware registry. The shell publishes the active route owner, content registers against that owner, and stale registrations are synchronously rejected before effects clean up.

**Tech Stack:** React 19, TypeScript, Bun test, Playwright

## Global Constraints

- Keep the right panel open and preserve its width while switching sessions.
- Never render content whose owner differs from the active route owner.
- Do not depend on effect cleanup timing for correctness.
- Preserve unrelated working-tree changes.

---

### Task 1: Pure ownership state machine

**Files:**
- Create: `apps/web/src/features/shell/right-panel/right-panel-ownership.ts`
- Create: `apps/web/test/unit/right-panel-ownership.test.ts`

**Interfaces:**
- Produces: `RightPanelOwnership`, `createRightPanelOwnership(ownerId)`, `activateRightPanelOwner(state, ownerId)`, `registerRightPanelContent(state, ownerId, registrationId)`, and `unregisterRightPanelContent(state, registrationId)`.

- [ ] **Step 1: Write failing tests for active-owner registration, route invalidation, and stale cleanup.**
- [ ] **Step 2: Run `bun ../../scripts/bun-test.ts test/unit/right-panel-ownership.test.ts --loud` from `apps/web` and verify missing-module failure.**
- [ ] **Step 3: Implement immutable ownership transitions with registration IDs.**
- [ ] **Step 4: Run the focused unit test and verify all cases pass.**

### Task 2: React registry integration

**Files:**
- Modify: `apps/web/src/features/shell/right-panel/right-panel-context.tsx`
- Modify: `apps/web/src/features/shell/right-panel/RightPanelContent.tsx`
- Modify: `apps/web/src/features/shell/right-panel/RightPanel.tsx`

**Interfaces:**
- Consumes: the Task 1 ownership transitions.
- Produces: `RightPanelProvider({ ownerId, children })` and `RightPanelContent({ ownerId, ... })`.

- [ ] **Step 1: Make the provider activate the current owner during render and expose owner-aware registration.**
- [ ] **Step 2: Require content to register with an owner and portal only when it is current.**
- [ ] **Step 3: Derive panel content visibility from the active owner's registration.**
- [ ] **Step 4: Run the focused unit test and TypeScript compiler.**

### Task 3: Route ownership and regression coverage

**Files:**
- Modify: `apps/web/src/features/shell/page-shell/ShellRouteProvider.tsx`
- Modify: `apps/web/src/features/session/SessionRoute.tsx`
- Modify: `apps/web/test/e2e/sidebar-interactions.spec.ts`

**Interfaces:**
- Consumes: `RightPanelProvider.ownerId` and `RightPanelContent.ownerId`.
- Produces: route identities in the form `session:<sessionId>` with non-session fallbacks based on the parsed shell route.

- [ ] **Step 1: Tighten the existing browser regression so the old inspector marker must be absent at the first observable draft-session state.**
- [ ] **Step 2: Run the focused browser test and verify it fails against count-based registration.**
- [ ] **Step 3: Pass the shell owner into the provider and session owner into inspector content; remove correctness-only keys.**
- [ ] **Step 4: Run formatting, the focused unit and browser tests, and `bunx tsc --noEmit`.**
