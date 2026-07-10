# Workspace Home Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the workspace home into a polished two-step session launcher with clear target selection, guarded async creation, inline recovery, and a 140–180ms confirmation transition.

**Architecture:** Keep `WorkspaceHome` as the orchestration boundary and the shared `ComposerShell` as the only composer. Extract only pure launch-target/error helpers for unit coverage; use scoped global classes for the home-specific ambient field, selection surfaces, and reduced-motion behavior.

**Tech Stack:** React 19, TypeScript, Tailwind utility classes, shared `@monad/ui` tokens, RTK Query, Bun test, Vite.

## Global Constraints

- Launch feedback completes in 140–180ms and never delays navigation after the mutation resolves.
- Existing agent navigation, default-agent creation, project-session creation, and shell prefill behavior remain unchanged.
- Do not change shared Composer behavior or global color tokens.
- All controls remain keyboard accessible, touch targets are at least 44px on mobile, and motion honors `prefers-reduced-motion`.

---

### Task 1: Launch Model And Regression Tests

**Files:**
- Create: `apps/web/src/features/workspace/workspace-home-model.ts`
- Create: `apps/web/test/unit/workspace-home-model.test.ts`

**Interfaces:**
- Produces: `resolveWorkspaceLaunchTarget(input): WorkspaceLaunchTarget | null`
- Produces: `workspaceLaunchErrorMessage(error): string`

- [ ] **Step 1: Write failing tests** for default agent, existing agent, project-with-selection, project-without-selection, and normalized mutation errors.
- [ ] **Step 2: Run `bun test apps/web/test/unit/workspace-home-model.test.ts`** and confirm failure because the model module does not exist.
- [ ] **Step 3: Implement the smallest discriminated-union resolver and error normalizer** needed by the tests.
- [ ] **Step 4: Re-run the targeted test** and confirm all cases pass.

### Task 2: Workspace Home Interaction And Visual System

**Files:**
- Modify: `apps/web/src/features/workspace/WorkspaceHome.tsx`
- Modify: `apps/web/src/styles/globals.css`
- Modify: `packages/i18n/src/locales/en/web.json`
- Modify: `packages/i18n/src/locales/zh/web.json`

**Interfaces:**
- Consumes: `resolveWorkspaceLaunchTarget` and `workspaceLaunchErrorMessage` from Task 1.
- Preserves: `ComposerShell`, RTK mutation hooks, `pushShellUrl`, and `projectSessionPath` contracts.

- [ ] **Step 1: Add guarded launch state** so repeated submits are ignored, controls expose busy semantics, and failures restore editing with an inline alert.
- [ ] **Step 2: Recompose the page** into an intent stage, compact `with...` continuation, segmented agent/project selector, scan-friendly target rows, and a selected-target launch summary.
- [ ] **Step 3: Connect the existing workspace ambient classes** and add state-driven focus/selection/launch styling with 160ms exponential easing and reduced-motion overrides.
- [ ] **Step 4: Add concise localized labels** for launching, error recovery, selected target context, and empty project guidance.
- [ ] **Step 5: Run targeted tests, formatting, and TypeScript checks.**
- [ ] **Step 6: Start the API and web servers, then verify desktop/mobile screenshots, keyboard flow, target switching, and console output in the in-app browser.**

## Self-Review

- Spec coverage: hierarchy, target selection, existing creation paths, guarded submit, error recovery, responsive layout, keyboard semantics, and reduced motion are assigned above.
- Scope: one product surface and its local tests/styles; no API or sidebar changes.
- Type consistency: the page consumes only the two exports created in Task 1.
