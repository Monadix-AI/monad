# TUI Chat Runtime Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove echoed user messages, make agent activity visible from submit through settle, hide projection for ordinary chats, and prevent streamed text from resizing chat columns.

**Architecture:** Pure stream and layout models define reconciliation, token cursor, spinner, projection, and width behavior. React/Redux components consume those models while the existing daemon and client-rtk contracts remain unchanged.

**Tech Stack:** Ink 7, React 19, Redux Toolkit, RTK Query, Bun test, TypeScript.

## Global Constraints

- Keep user messages optimistic and external-agent projection read-only.
- Do not change daemon endpoints, protocol types, or client-rtk normalization.
- Do not load Experience extensions in TUI.
- Preserve unrelated dirty worktree changes.

---

### Task 1: Stream reconciliation and running lifecycle

**Files:**
- Create: `apps/tui/src/shell/stream-model.ts`
- Create: `apps/tui/test/unit/stream-model.test.ts`
- Modify: `apps/tui/src/hooks/useStream.ts`
- Modify: `apps/tui/src/store/server.ts`
- Modify: `apps/tui/src/components/Layout.tsx`

**Interfaces:**
- Produces: `settledAssistantMessages(messages): StreamTranscriptMessage[]`.
- Produces: `advanceStreamCursor(cursor, message): { cursor: StreamCursor; delta: string }`.
- Produces: Redux action `finishTurn()` which clears streaming state without creating a message.

- [ ] **Step 1: Write failing stream-model and reducer tests**

Assert mixed user/assistant stream data yields only settled assistants; streaming assistants are excluded; a new message ID resets the token cursor even when its text is shorter; `addUserMessage` enters running state and `finishTurn` clears it.

- [ ] **Step 2: Run tests and observe RED**

Run: `bun test apps/tui/test/unit/stream-model.test.ts`

Expected: FAIL because the model and lifecycle action do not exist.

- [ ] **Step 3: Implement the minimal model and integration**

Filter settled messages by `role === 'assistant'`, track token cursors by message ID in `useStream`, set `isStreaming = true` in `addUserMessage`, and dispatch `finishTurn()` on send failure and explicit abort. Preserve `commitMessage` as the assistant settle path.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/tui/test/unit/stream-model.test.ts`

Expected: PASS with zero failures.

### Task 2: Activity animation

**Files:**
- Create: `apps/tui/src/shell/activity-model.ts`
- Create: `apps/tui/test/unit/activity-model.test.ts`
- Modify: `apps/tui/src/components/Streaming.tsx`

**Interfaces:**
- Produces: `activityFrame(tick): string`, always one terminal cell.
- Consumes: Redux `isStreaming` set immediately by Task 1.

- [ ] **Step 1: Write a failing fixed-width frame test**

Assert multiple ticks cycle through distinct Braille frames and every frame has one Unicode code point.

- [ ] **Step 2: Run the test and observe RED**

Run: `bun test apps/tui/test/unit/activity-model.test.ts`

Expected: FAIL because `activityFrame` does not exist.

- [ ] **Step 3: Implement the spinner and running row**

Use a timer only while running. Render `monad`, a fixed-width frame, and either streamed text or the localized running label; clear the timer on unmount or settle.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/tui/test/unit/activity-model.test.ts`

Expected: PASS with zero failures.

### Task 3: Projection eligibility and stable chat columns

**Files:**
- Modify: `apps/tui/src/shell/layout-model.ts`
- Modify: `apps/tui/test/unit/shell-model.test.ts`
- Modify: `apps/tui/src/components/Layout.tsx`

**Interfaces:**
- Produces: `shouldShowProjection(mode, chatOpen, hasSession, externalAgentCount): boolean`.
- Produces: `chatPaneWidths(columns, navigationWidth, projectionVisible): { transcript: number; projection: number }`.

- [ ] **Step 1: Write failing eligibility and width tests**

Assert ordinary chats never show projection, an associated external-agent session shows it only in wide chat, and identical terminal inputs always return identical integer widths independent of transcript content.

- [ ] **Step 2: Run the test and observe RED**

Run: `bun test apps/tui/test/unit/shell-model.test.ts`

Expected: FAIL because both functions are absent.

- [ ] **Step 3: Integrate RTK eligibility and explicit widths**

Use `useListExternalAgentSessionsQuery` plus selectors in `Layout`; calculate projection visibility from associated session count; apply fixed numeric widths and `flexShrink={0}` to transcript and projection wrappers; exclude an absent projection from focus and mouse routing.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/tui/test/unit/shell-model.test.ts`

Expected: PASS with zero failures.

### Task 4: Changed-path verification

**Files:**
- Verify all files in Tasks 1–3.

**Interfaces:**
- Consumes: the completed fixes.
- Produces: fresh test, type, formatting, and diff evidence.

- [ ] **Step 1: Run TUI unit tests**

Run: `bun run --cwd apps/tui test:unit:loud`

Expected: PASS with zero failures.

- [ ] **Step 2: Run TUI typecheck and formatting**

Run: `bun run --cwd apps/tui typecheck`

Run: `bunx biome check apps/tui/src apps/tui/test/unit`

Expected: both exit 0.

- [ ] **Step 3: Inspect the focused diff**

Run: `git diff --check` and inspect only the files listed above.

Expected: no whitespace errors and no daemon/protocol/client-rtk changes.
