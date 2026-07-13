# Kanban Power Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `graphic-view` workspace experience to canonical ID `kanban`, ship it from `monad-power-pack`, and preserve legacy project selections.

**Architecture:** The built-in atoms pack keeps only the host-owned chat room. The opt-in Power Pack contributes a pack-relative web-component experience and stages its JavaScript asset beside the installed atom-pack bundle. The host continues publishing the generic `graphCanvas` snapshot projection, while the Kanban rendering implementation lives entirely in the Power Pack asset.

**Tech Stack:** TypeScript, Bun test, atom-pack workspace-experience registration, same-origin web components.

## Global Constraints

- Canonical experience ID is exactly `kanban` and display title is exactly `Kanban`.
- Legacy persisted IDs `graphic-view` and `graph-view` normalize to `kanban` without appearing as duplicate experience choices.
- Preserve unrelated uncommitted Host Interaction, Power Pack staging, and workspace E2E changes already present in this worktree.
- Use pack-relative module path `experiences/kanban.js` and custom element name `monad-kanban`.

---

### Task 1: Lock atom-pack ownership and staged asset behavior

**Files:**
- Modify: `apps/monad/test/unit/atoms/sandbox-atom-load.test.ts`
- Modify: `packages/monad-power-pack/test/unit/staged.test.ts`
- Create: `packages/monad-power-pack/src/experiences/kanban.ts`
- Create: `packages/monad-power-pack/src/experiences/kanban.js`
- Modify: `packages/monad-power-pack/src/index.ts`
- Modify: `packages/atoms/src/workspace-experiences/registry.ts`
- Delete: `packages/atoms/src/workspace-experiences/graph-view/definition.ts`
- Delete: `apps/web/public/experiences/graph-view.js`

**Interfaces:**
- Consumes: `defineAtomPack({ workspaceExperiences })` and pack-relative asset URL rewriting.
- Produces: `kanbanWorkspaceExperience` with `{ id: 'kanban', title: 'Kanban', entry: { type: 'web-component', module: 'experiences/kanban.js', tagName: 'monad-kanban' } }`.

- [ ] **Step 1: Write failing ownership and staging assertions**

  Assert that built-ins register only `chat-room`, Power Pack registers `kanban`, its manifest declares `workspace-experience`, and `stagedMonadPowerPack().files` contains `experiences/kanban.js` defining `monad-kanban`.

- [ ] **Step 2: Run tests to verify RED**

  Run: `bun test packages/monad-power-pack/test/unit/staged.test.ts apps/monad/test/unit/atoms/sandbox-atom-load.test.ts`

  Expected: failures showing built-ins still contain `graphic-view`, Power Pack lacks `kanban`, and the staged asset is missing.

- [ ] **Step 3: Implement the Power Pack experience and move the asset**

  Add the `kanban` definition and JavaScript web component under `packages/monad-power-pack/src/experiences/`, register it in `monadPowerPack`, add `workspace-experience` to the manifest, and stage the JavaScript bytes. Remove the old built-in definition, registry entry, and public Web asset.

- [ ] **Step 4: Run tests to verify GREEN**

  Run: `bun test packages/monad-power-pack/test/unit/staged.test.ts apps/monad/test/unit/atoms/sandbox-atom-load.test.ts`

  Expected: all ownership and staged-asset assertions pass.

### Task 2: Remove the obsolete built-in renderer while retaining generic snapshot data

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/ui.tsx`
- Modify: `packages/atoms/src/workspace-experiences/runtime.ts`
- Create: `packages/atoms/src/workspace-experiences/experience/activity-graph.ts`
- Modify: `packages/atoms/test/unit/workspace-experience-runtime.test.ts`
- Delete: `packages/atoms/src/workspace-experiences/graph-view/ui.tsx`
- Delete: `packages/atoms/src/workspace-experiences/graph-view/components/view.tsx`
- Delete: `packages/atoms/src/workspace-experiences/graph-view/runtime.ts`
- Delete: `packages/atoms/src/workspace-experiences/graph-view/utils/canvas.ts`
- Delete: `packages/atoms/src/workspace-experiences/graph-view/utils/graph-model.ts`

**Interfaces:**
- Consumes: `ProjectExperienceCanvasSource`.
- Produces: framework-neutral `WorkspaceExperienceSnapshot.graphCanvas`; no `graphic-view` entry remains in `runtime.views` or the built-in renderer table.

- [ ] **Step 1: Update runtime tests to require snapshot-only activity data**

  Assert participant/activity projection through `runtime.snapshot.graphCanvas` and remove assertions against `runtime.views['graphic-view']` or the built-in graph layout.

- [ ] **Step 2: Run the runtime test to verify RED**

  Run: `bun test packages/atoms/test/unit/workspace-experience-runtime.test.ts`

  Expected: failure because the runtime still exposes `graphic-view` and uses the old graph-view projector.

- [ ] **Step 3: Extract the generic activity projection and delete renderer code**

  Move only participant/activity snapshot projection to `experience/activity-graph.ts`, use it directly in `createProjectExperienceRuntime`, and remove the obsolete React renderer and graph-view runtime view.

- [ ] **Step 4: Run the runtime test to verify GREEN**

  Run: `bun test packages/atoms/test/unit/workspace-experience-runtime.test.ts`

  Expected: snapshot projection passes and no built-in graph renderer is required.

### Task 3: Migrate legacy browser selections

**Files:**
- Modify: `apps/web/src/features/workspace/use-project-view-mode.ts`
- Modify: `apps/web/test/unit/project-view-mode.test.ts`

**Interfaces:**
- Produces: `normalizeProjectViewMode(mode: string): string`, mapping `graphic-view` and `graph-view` to `kanban` and preserving every other ID.

- [ ] **Step 1: Write failing migration assertions**

  Assert `normalizeProjectViewMode('graphic-view') === 'kanban'`, `normalizeProjectViewMode('graph-view') === 'kanban'`, and `normalizeProjectViewMode('chat-room') === 'chat-room'`.

- [ ] **Step 2: Run the unit test to verify RED**

  Run: `bun test apps/web/test/unit/project-view-mode.test.ts`

  Expected: failure because `normalizeProjectViewMode` does not exist.

- [ ] **Step 3: Implement normalization at storage read and write boundaries**

  Export the pure normalizer, normalize values loaded from localStorage, and normalize values passed to the setter so legacy state is rewritten canonically.

- [ ] **Step 4: Run the unit test to verify GREEN**

  Run: `bun test apps/web/test/unit/project-view-mode.test.ts`

  Expected: all storage-key and migration assertions pass.

### Task 4: Verify the complete change

**Files:**
- Verify only: all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: a tested Power Pack-owned `kanban` experience with compatibility migration.

- [ ] **Step 1: Run focused tests**

  Run: `bun test packages/monad-power-pack/test/unit/staged.test.ts apps/monad/test/unit/atoms/sandbox-atom-load.test.ts packages/atoms/test/unit/workspace-experience-runtime.test.ts apps/web/test/unit/project-view-mode.test.ts`

  Expected: all tests pass.

- [ ] **Step 2: Run package typechecks**

  Run: `bun run --cwd packages/monad-power-pack typecheck && bun run --cwd packages/atoms typecheck && bun run --cwd apps/web typecheck`

  Expected: changed packages typecheck, with any unrelated baseline failure reported separately.

- [ ] **Step 3: Inspect the scoped diff**

  Run: `git diff -- packages/atoms/src/workspace-experiences packages/atoms/test/unit/workspace-experience-runtime.test.ts packages/monad-power-pack apps/monad/test/unit/atoms/sandbox-atom-load.test.ts apps/web/public/experiences apps/web/src/features/workspace/use-project-view-mode.ts apps/web/test/unit/project-view-mode.test.ts`

  Expected: only Kanban migration changes plus the pre-existing Power Pack staging edits are present.
