# Agent Flow Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agent Workshop assembly UI with the approved option 3 React Flow editor while preserving all existing agent state and save contracts.

**Architecture:** `AgentEditor` remains the state and persistence owner. A new pure model module derives validation, readiness, prompt guidance, and node summaries; a fixed `AgentFlowCanvas` renders the six-node explanatory sequence; `AgentFlowPanel` edits the selected portion through existing callbacks. React Flow state is view-only and never persisted.

**Tech Stack:** React 19, TypeScript, `@xyflow/react` 12.11, `@monad/ui`, Hugeicons, Bun tests, Vite.

## Global Constraints

- Preserve the existing `useUpdateAgentMutation`, `useSetAgentPromptMutation`, and `buildAgentEditorUpdate` payloads.
- Use fixed nodes: request, identity, model, tools, safety, response.
- Inherited settings are valid and must not be presented as errors.
- Do not add protocol fields, endpoints, persisted node positions, raster assets, gradients, inline SVGs, or another icon package.
- Use existing Monad colors, typography, controls, sidebar, and breadcrumb header.
- Save is disabled only for an empty name or invalid numeric safety limits.

---

### Task 1: Pure Agent Flow Model

**Files:**
- Create: `apps/web/src/features/studio/agent-workshop/agent-flow-model.ts`
- Test: `apps/web/test/unit/agent-flow-model.test.ts`

**Interfaces:**
- Produces: `AgentFlowNodeId`, `AgentFlowValidation`, `validateAgentFlow`, `deriveAgentFlowReadiness`, `appendPromptGuidance`, `agentFlowSummaries`.
- Consumes: existing string state values from `AgentEditor` and `atomsMode` / `atomsAllow`.

- [ ] **Step 1: Write failing tests** for blank-name blocking, inherited-value validity, numeric-limit validation, optional-improvement counting, duplicate-safe prompt guidance, and summaries.

```ts
test('treats inherited values as valid optional improvements', () => {
  expect(deriveAgentFlowReadiness(baseInput)).toEqual({
    label: 'Ready to use',
    optionalImprovements: 5,
    saveBlocked: false
  });
});
```

- [ ] **Step 2: Verify RED** with `bun run --cwd apps/web test:unit -- agent-flow-model.test.ts`; expect import failure because `agent-flow-model.ts` does not exist.
- [ ] **Step 3: Implement the pure model** with strict positive-number checks (`maxTurns` integer; token and budget values finite and greater than zero), exact-line guidance de-duplication, and plain-language summaries.
- [ ] **Step 4: Verify GREEN** with `bun run --cwd apps/web test:unit -- agent-flow-model.test.ts`; expect all new tests to pass.

### Task 2: Fixed React Flow Canvas

**Files:**
- Create: `apps/web/src/features/studio/agent-workshop/AgentFlowCanvas.tsx`
- Create: `apps/web/src/features/studio/agent-workshop/AgentFlowNode.tsx`
- Modify: `apps/web/src/features/studio/agent-workshop/AgentWorkshop.tsx`

**Interfaces:**
- Consumes: `AgentFlowNodeId` and derived summaries from Task 1.
- Produces: `AgentFlowCanvas({ selected, summaries, onSelect })` and the shared `AgentFlowNode` node type.

- [ ] **Step 1: Add a failing source-contract test** asserting the workshop imports `ReactFlow`, registers a custom node type, and defines all six node ids.
- [ ] **Step 2: Verify RED**; expect the source-contract assertions to fail against the workshop assembly UI.
- [ ] **Step 3: Implement the fixed canvas** with six non-draggable, non-connectable nodes, arrow edges, dot background, fit/zoom controls, node selection, pane deselection, and keyboard-readable labels.
- [ ] **Step 4: Replace the three-column assembly shell** with the single canvas shell and selected-node state, retaining existing capability queries and props.
- [ ] **Step 5: Verify GREEN** with focused unit tests and `bun run --cwd apps/web typecheck`.

### Task 3: Contextual Editing Panel

**Files:**
- Create: `apps/web/src/features/studio/agent-workshop/AgentFlowPanel.tsx`
- Modify: `apps/web/src/features/studio/agent-workshop/AgentWorkshop.tsx`
- Modify: `apps/web/src/features/studio/agent-workshop/AgentEditor.tsx`

**Interfaces:**
- Consumes: all current `AgentWorkshop` values/setters, profiles, capability catalog, and selected `AgentFlowNodeId`.
- Produces: focused sections for identity/prompt, model/roles, tools, safety/limits, and availability.

- [ ] **Step 1: Add failing source-contract tests** for labeled identity fields, Advanced disclosures, capability mode controls, safety fields, and availability controls.
- [ ] **Step 2: Verify RED** against the canvas-only editor.
- [ ] **Step 3: Implement the panel** with visible labels, suggestion chips using `appendPromptGuidance`, inherited model/tool/sandbox language, unavailable-capability preservation, inline numeric errors, and the response availability section.
- [ ] **Step 4: Lift `saveBlocked` to `AgentEditor`** so the existing Save button is disabled for invalid local state while its save handler remains unchanged.
- [ ] **Step 5: Verify GREEN** with focused tests and typecheck.

### Task 4: Responsive Styling and Workshop Cleanup

**Files:**
- Modify: `apps/web/src/features/studio/agent-workshop/AgentFlowCanvas.tsx`
- Modify: `apps/web/src/features/studio/agent-workshop/AgentFlowPanel.tsx`
- Delete: `apps/web/src/features/studio/agent-workshop/AgentWorkshopHeader.tsx`
- Delete: `apps/web/src/features/studio/agent-workshop/AgentWorkshopInspector.tsx`
- Delete: `apps/web/src/features/studio/agent-workshop/AgentWorkshopPartsBin.tsx`
- Delete: `apps/web/src/features/studio/agent-workshop/AgentWorkshopPrimitives.tsx`
- Delete: `apps/web/src/features/studio/agent-workshop/AgentWorkshopWorkbench.tsx`

**Interfaces:**
- Consumes: components completed in Tasks 2-3.
- Produces: desktop anchored panel, tablet overlay, and mobile bottom-sheet behavior without horizontal page overflow.

- [ ] **Step 1: Add failing source checks** for the desktop panel width, narrow overlay/bottom placement, and absence of workshop jargon imports.
- [ ] **Step 2: Verify RED** before cleanup.
- [ ] **Step 3: Add responsive layout and reduced-motion classes**, focus-visible states, `aria-selected`, Escape close behavior, and deterministic tab order.
- [ ] **Step 4: Delete unused assembly components** and remove all remaining imports.
- [ ] **Step 5: Run** `bun run --cwd apps/web lint`, `bun run --cwd apps/web typecheck`, and focused unit tests; expect clean output.

### Task 5: Browser and Design QA

**Files:**
- Create: `design-qa.md`
- Modify: changed implementation files only when QA finds P0-P2 issues.

**Interfaces:**
- Consumes: approved option 3 image and running local app at port 3775.
- Produces: `design-qa.md` with `final result: passed` and a verified editor.

- [ ] **Step 1: Run the local daemon/web app** with `bun run dev` and open the existing Default Dev Agent editor in the in-app browser.
- [ ] **Step 2: Set the viewport to 1440 x 1024**, select Identity and instructions, capture the implementation, and inspect console errors.
- [ ] **Step 3: Compare the implementation screenshot and approved mock at the same state**, recording P0-P3 differences in `design-qa.md`.
- [ ] **Step 4: Fix every P0-P2 issue**, rerun focused tests/typecheck, and recapture until `final result: passed`.
- [ ] **Step 5: Verify core interactions**: six-node selection, pane close, Escape close, identity edits, Advanced disclosures, capability mode, invalid safety value blocking Save, viewport controls, and a successful local Save.
- [ ] **Step 6: Run final checks**: `bun run --cwd apps/web test:unit`, `bun run --cwd apps/web typecheck`, `bun run --cwd apps/web lint`, and `git diff --check`.

## Self-Review

- Spec coverage: all six nodes, every existing field, inheritance semantics, responsive behavior, accessibility, validation, persistence boundaries, and design QA are assigned to tasks.
- Placeholder scan: no deferred implementation markers or undefined follow-up work remain.
- Type consistency: the plan consistently uses `AgentFlowNodeId`, existing AgentEditor string state, `atomsMode`, `atomsAllow`, and current setter signatures.
