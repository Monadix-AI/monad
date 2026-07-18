# Observation History Autoload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GPT observation history form one continuous, automatically paged timeline without requiring a separate reveal action.

**Architecture:** Derive the history presentation mode from the observation source. Neutral external-agent streams always include fetched pages, while delivery observations preserve the existing explicit request gate. The existing virtual list continues loading `nextCursor` pages at the start boundary.

**Tech Stack:** React, TypeScript, Bun test, RTK Query, `@monad/ui` VirtualList.

## Global Constraints

- Keep daemon history requests paged at 20 provider items per request.
- Preserve stable dedupe keys and prepend anchoring.
- Do not change delivery-observation behavior.
- Add no hard-coded user-facing strings.

---

### Task 1: Derive observation history presentation

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/observation-history.ts`
- Test: `packages/atoms/test/unit/observation-history.test.ts`

**Interfaces:**
- Consumes: `deliveryId`, `historyRequested`, and whether a history page state exists.
- Produces: `observationHistoryPresentation(args): { active: boolean; includePages: boolean; showButton: boolean }`.

- [ ] **Step 1: Write the failing test**

Add an exact table assertion showing that external-agent history includes pages automatically, while delivery history remains gated.

- [ ] **Step 2: Verify the test fails**

Run: `bun scripts/bun-test.ts packages/atoms/test/unit/observation-history.test.ts --only-failures`

Expected: FAIL because `observationHistoryPresentation` is not exported.

- [ ] **Step 3: Implement the minimal helper**

Return automatic `active/includePages` for non-delivery observations and retain the request gate for delivery observations.

- [ ] **Step 4: Verify the focused test passes**

Run the same Bun test command and expect zero failures.

### Task 2: Connect automatic history to the observation rail

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx`

**Interfaces:**
- Consumes: `observationHistoryPresentation` from Task 1 and the existing `historyPages` state.
- Produces: panel props and stream composition that expose prefetched external-agent pages immediately.

- [ ] **Step 1: Use the derived presentation state**

Feed `includePages` into `streamWithHistoryPages`; feed `active` into `historyActive`; feed `showButton` into `showHistoryButton`; gate loading props consistently.

- [ ] **Step 2: Verify unit tests and types**

Run:

```sh
bun scripts/bun-test.ts packages/atoms/test/unit/observation-history.test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
bun run --cwd packages/atoms typecheck
```

Expected: both commands exit 0.

### Task 3: Verify and commit

**Files:**
- Verify all files modified by Tasks 1 and 2.

**Interfaces:**
- Consumes: completed implementation.
- Produces: a focused commit ready to integrate.

- [ ] **Step 1: Inspect the diff and weak assertions**

Run `git diff --check` and inspect the new test's exact behavioral assertion.

- [ ] **Step 2: Run the focused verification once more**

Run the two commands from Task 2 and expect zero failures.

- [ ] **Step 3: Commit**

Stage only the design, plan, observation history helper/test, and rail component, then commit with `fix(workplace): autoload observation history`.
