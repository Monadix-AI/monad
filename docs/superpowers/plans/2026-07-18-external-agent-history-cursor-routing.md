# External-Agent History Cursor Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep local JSONL offsets in the local history pager and prevent them from reaching provider-native APIs.

**Architecture:** Reuse the existing `provider:` and `snapshot:` namespaces. The host routes `snapshot:` cursors to an adapter call without `requestProviderPage`; only provider-bridge results receive `provider:` cursors.

**Tech Stack:** TypeScript, Bun test, external-agent host, adapter event sources.

## Global Constraints

- Work directly on `main`.
- Preserve unrelated working-tree changes.
- Keep provider errors visible.
- Apply the same cursor ownership rules to live and stopped sessions.

---

### Task 1: Route local history cursors back to the local pager

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/history-cursor.ts`
- Modify: `apps/monad/src/services/external-agent/host/index.ts`
- Test: `apps/monad/test/unit/external-agent-history-cursor.test.ts`

**Interfaces:**
- Consumes: `decodeHistoryCursor(before)` and `ExternalAgentEventSource.readPage(context, request)`.
- Produces: `encodeStoredHistoryCursor(cursor: string): string` and host routing that never supplies a stored cursor to `requestProviderPage`.

- [x] **Step 1: Write the failing regression test**

Add a stopped Codex session whose overridden `readPage` returns `nextCursor: '100'` only when `context.requestProviderPage` is absent. Assert the first host page returns `snapshot:100`; request that cursor and assert the local reader receives `[undefined, '100']` while the provider reader is never called.

- [x] **Step 2: Run the regression test and verify RED**

Run `bun run scripts/bun-test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts --only-failures`.

Expected: FAIL because the first page currently returns `provider:100`.

- [x] **Step 3: Add stored cursor encoding**

Add this function to `history-cursor.ts`:

```ts
export function encodeStoredHistoryCursor(cursor: string): string {
  return `${STORED_HISTORY_CURSOR_PREFIX}${cursor}`;
}
```

- [x] **Step 4: Route cursor kinds in the host**

For a decoded `stored` cursor, call `readPage` without `requestProviderPage`, pass its unwrapped value as `before`, and encode its next cursor with `encodeStoredHistoryCursor`. Only a provider-bridge result may use `encodeProviderHistoryCursor`. A supplied provider cursor must not silently fall back to the local reader.

- [x] **Step 5: Run focused tests and verify GREEN**

Run `bun run scripts/bun-test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts apps/monad/test/unit/external-agent-host.test.ts --only-failures`.

Expected: all tests pass.

- [x] **Step 6: Run verification**

Run `bun run typecheck` and `git diff --check`. Typecheck must pass unless a pre-existing unrelated working-tree failure remains; the task diff must have no whitespace errors.

- [x] **Step 7: Commit only cursor-routing files**

Stage the two host files, the cursor regression test, and this plan. Commit with `fix(external-agent): isolate history cursor domains`.
