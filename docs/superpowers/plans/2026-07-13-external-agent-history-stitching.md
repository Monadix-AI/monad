# External Agent History Stitching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Join backfilled external-agent history to the live observation timeline without ID-based deduplication and expose history only when an older page exists.

**Architecture:** Add pure client helpers for timestamp seam filtering and chronological prepend. The rail probes opaque-cursor pages before rendering the button, retains the first useful page, and reuses the existing top-reached pagination path.

**Tech Stack:** TypeScript, React, RTK Query, Bun test.

## Global Constraints

- The daemon does not assign or interpret raw transaction IDs.
- History and live observations join by a strict timestamp seam and consistent ascending order.
- Existing unrelated working-tree changes must remain untouched.

---

### Task 1: Chronological history page helpers

**Files:**

- Create: `packages/atoms/src/workspace-experiences/chat-room/utils/observation-history.ts`
- Test: `packages/atoms/test/unit/observation-history.test.ts`

**Interfaces:**

- Produces: `oldestObservationTimestamp`, `historyItemsBefore`, and `prependObservationHistory`.

- [ ] Write tests showing seam filtering rejects overlap and prepend preserves page order.
- [ ] Run `bun test packages/atoms/test/unit/observation-history.test.ts` and confirm the missing module failure.
- [ ] Implement the three pure helpers without event-ID comparison.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Probe-driven rail availability and pagination

**Files:**

- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx`
- Test: `packages/atoms/test/unit/observation-history.test.ts`

**Interfaces:**

- Consumes: Task 1 helpers and `ExternalAgentHistoryPageResponse.nextCursor`.
- Produces: hidden prefetched history state, actual-data button visibility, and cursor-based prepend.

- [ ] Add a failing state-transition test for pages containing only seam overlap followed by exhaustion.
- [ ] Run the focused test and confirm the expected assertion failure.
- [ ] Replace signature-based merging with direct chronological prepend and add automatic page probing.
- [ ] Traverse older pages with `sortDirection: 'desc'`; retain the first page older than the live seam while preserving each page's chronological presentation order.
- [ ] Re-run the focused test and relevant atoms unit tests.

### Task 3: Lily regression

**Files:**

- No production files beyond Tasks 1-2.

**Interfaces:**

- Consumes: the running daemon session `exa_2M2iV8qg7wsi`.

- [ ] Fetch every history page read-only and verify no projected event precedes Lily's earliest live event.
- [ ] Confirm the probe therefore reports unavailable and returns zero stitched items.
- [ ] Run TypeScript validation for the touched package and inspect the final diff for unrelated changes.
