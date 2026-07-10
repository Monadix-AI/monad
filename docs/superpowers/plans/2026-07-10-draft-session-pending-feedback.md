# Draft Session Pending Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show selected agent name with shimmer immediately after homepage submission while the session is being created.

**Architecture:** Build the draft user and pending assistant messages as pure session view data, then render them through the existing chat message component. Resolve the display label from the draft's selected agent and use `Default Agent` when no agent is selected.

**Tech Stack:** React, TypeScript, Bun test, Playwright

## Global Constraints

- Reuse the existing pending assistant `Shimmer` presentation.
- Do not add a separate sidebar loading state.
- Failed drafts must not keep shimmering.

---

### Task 1: Draft feedback view model

**Files:**
- Create: `apps/web/src/features/session/draft-session-feedback.ts`
- Create: `apps/web/test/unit/draft-session-feedback.test.ts`

**Interfaces:**
- Produces: `buildDraftSessionFeedback({ agentLabel, draft }) => ViewItem[]`.

- [ ] Write failing tests for creating and failed drafts.
- [ ] Run the focused unit test and verify the module is missing.
- [ ] Implement the minimal user and pending assistant message builder.
- [ ] Run the focused test and verify both states pass.

### Task 2: Existing message presentation integration

**Files:**
- Modify: `apps/web/src/features/session/ChatMessage.tsx`
- Modify: `apps/web/src/features/session/use-session-route-model.ts`
- Modify: `apps/web/src/features/shell/page-shell/ShellRouteProvider.tsx`

**Interfaces:**
- Consumes: `Msg.label` and `buildDraftSessionFeedback`.
- Produces: selected agent labels rendered through the existing pending shimmer.

- [ ] Add optional message labels and pending-state diagnostics to `Message`.
- [ ] Pass agents into the session route model and resolve the draft label.
- [ ] Replace the inline single draft message with the feedback builder.

### Task 3: Browser regression

**Files:**
- Modify: `apps/web/test/e2e/sidebar-interactions.spec.ts`

**Interfaces:**
- Verifies: homepage submission displays `Default Agent` in a pending message before create-session resolution.

- [ ] Hold the mocked create-session response until the pending label is asserted.
- [ ] Release the response and verify the existing create/send flow completes.
- [ ] Run focused unit tests and the complete sidebar E2E file.
