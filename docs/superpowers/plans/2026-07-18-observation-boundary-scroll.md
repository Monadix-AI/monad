# Observation Boundary Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the observation panel's top and bottom controls land on the physical boundaries of the currently loaded virtual-list content.

**Architecture:** `VirtualList` owns physical scroll-boundary behavior through its imperative handle. The observation panel calls explicit top/bottom operations and leaves history paging to the existing `startReached` callback, so each click can trigger at most the next normal backfill page.

**Tech Stack:** React, TypeScript, react-virtuoso, Bun test.

## Global Constraints

- Work directly on `main` as requested.
- Preserve unrelated working-tree changes.
- Top means the currently loaded content boundary, not the beginning of all provider history.
- Existing manual scrolling, follow-latest behavior, and history paging remain unchanged.

---

### Task 1: Virtual-list physical boundary operations

**Files:**
- Modify: `apps/web/test/unit/virtual-list.test.ts`
- Modify: `packages/ui/src/components/VirtualList.tsx`

**Interfaces:**
- Consumes: the existing `VirtualListHandle`, `scrollerRef`, and bottom settlement state machine.
- Produces: `scrollBoundaryTop(metrics, boundary)` and `VirtualListHandle.scrollToTop(behavior?)`.

- [ ] **Step 1: Write the failing boundary test**

Add a test that expects the physical top to be `0` and the physical bottom to be `Math.max(0, scrollHeight - clientHeight)`:

```ts
expect([
  scrollBoundaryTop({ scrollHeight: 2_400, clientHeight: 600 }, 'top'),
  scrollBoundaryTop({ scrollHeight: 2_400, clientHeight: 600 }, 'bottom')
]).toEqual([0, 1_800]);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun run scripts/bun-test.ts apps/web/test/unit/virtual-list.test.ts --only-failures`

Expected: FAIL because `scrollBoundaryTop` is not exported.

- [ ] **Step 3: Implement the minimal physical-boundary API**

Add:

```ts
export function scrollBoundaryTop(
  metrics: { scrollHeight: number; clientHeight: number },
  boundary: 'top' | 'bottom'
): number {
  return boundary === 'top' ? 0 : Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}
```

Extend `VirtualListHandle` with `scrollToTop`. Its implementation cancels bottom settlement, unpins follow mode, clears layout anchoring, marks the scroll programmatic, and calls the physical scroller with `top: 0`. Update bottom scrolling to use the same physical bottom helper.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `bun run scripts/bun-test.ts apps/web/test/unit/virtual-list.test.ts --only-failures`

Expected: all tests in the file pass.

### Task 2: Observation controls use physical boundaries

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/observation/panel.tsx`
- Modify: `packages/atoms/test/unit/external-agent-observation.test.ts`

**Interfaces:**
- Consumes: `VirtualListHandle.scrollToTop` and `VirtualListHandle.scrollToBottom`.
- Produces: top/bottom button handlers that target the physical loaded-content boundaries.

- [ ] **Step 1: Write the failing panel source regression**

Add a strict source-level contract assertion that the panel's top handler calls `scrollToTop('smooth')` and no longer derives a first-row key, while the bottom handler calls `scrollToBottom('smooth')`.

- [ ] **Step 2: Run the observation test and verify RED**

Run: `bun run scripts/bun-test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures`

Expected: FAIL because the top handler still calls `scrollToKey`.

- [ ] **Step 3: Replace the panel handlers**

Use:

```ts
const scrollToTop = () => {
  setFollow(false);
  listRef.current?.scrollToTop('smooth');
};
const scrollToBottom = () => {
  setFollow(false);
  listRef.current?.scrollToBottom('smooth');
};
```

- [ ] **Step 4: Run affected tests and typecheck**

Run:

```sh
bun run scripts/bun-test.ts apps/web/test/unit/virtual-list.test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
bun run typecheck
```

Expected: all affected tests pass and typecheck exits zero.

- [ ] **Step 5: Commit only task files**

Stage the two implementation files, two test files, and this plan. Commit them without staging unrelated working-tree changes.
