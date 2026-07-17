# Stopped Provider History Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve native provider cursors for stopped managed-agent history so the UI can load the complete history in chronological order.

**Architecture:** Refactor the existing one-shot app-server history probe into a page-oriented primitive that returns provider items plus `nextCursor`. `ExternalAgentHost` will use that primitive before falling back to flattened output, and one shared presentation helper will reverse descending provider pages into chronological UI order for both live and stopped sessions.

**Tech Stack:** Bun, TypeScript, Bun test, Codex app-server JSON-RPC, Monad external-agent adapters.

## Global Constraints

- Keep UI provider-agnostic; `nextCursor` continues to mean an older page and older pages are prepended.
- Never forward `snapshot:*` cursors to a provider.
- Preserve the stored-output fallback when a stopped provider page bridge is unavailable.
- Keep supervised process timeout, cleanup, structured framing, and response-id matching behavior unchanged.
- Exercise daemon behavior through the existing TCP loopback and Unix-socket transport matrix where applicable.
- Use Bun commands only.

---

### Task 1: Normalize Provider Page Presentation

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/index.ts:803-849`
- Test: `apps/monad/test/unit/external-agent-history-cursor.test.ts`

**Interfaces:**
- Consumes: `ExternalAgentHistoryPageRequest.sortDirection` and `{ items: unknown[]; nextCursor?: string }` provider pages.
- Produces: `providerHistoryPresentationItems(items, sortDirection): unknown[]`, used by live and stopped page conversion.

- [ ] **Step 1: Write the failing test**

Add a stored-session adapter fixture whose `historyPage` returns turns in provider-descending order:

```ts
historyPage: async () => ({
  items: [{ id: 'newer', items: [] }, { id: 'older', items: [] }],
  nextCursor: 'older-page'
}),
historyPageOutput: ({ page }) => page.items.map((item) => JSON.stringify(item)).join('\n')
```

Assert the adapter receives `['older', 'newer']` for presentation and the response cursor is
`provider:older-page`. This test must fail with the current `['newer', 'older']` order.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun run scripts/bun-test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts --only-failures
```

Expected: the new order assertion fails because stopped provider pages are passed through unchanged.

- [ ] **Step 3: Implement the shared presentation helper**

Add a pure helper near `providerHistoryPageRequest`:

```ts
function providerHistoryPresentationItems(items: unknown[], sortDirection: 'asc' | 'desc'): unknown[] {
  return sortDirection === 'desc' ? [...items].reverse() : items;
}
```

Use it in both `providerHistoryPageResponse` and `historyPageOutput`; remove the duplicated live-only reverse.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused command. Expected: all cases in the file pass.

- [ ] **Step 5: Commit**

```bash
git add apps/monad/src/services/external-agent/host/index.ts apps/monad/test/unit/external-agent-history-cursor.test.ts
git commit -m "fix(external-agent): normalize provider history page order"
```

### Task 2: Preserve Stopped Provider Pages and Cursors

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/history-backfill.ts`
- Modify: `apps/monad/src/services/external-agent/host/index.ts:776-801`
- Modify: `apps/monad/src/services/external-agent/host/observation-resolve.ts:166-184`
- Test: `apps/monad/test/unit/external-agent-history-cursor.test.ts`
- Test: `apps/monad/test/unit/external-agent-host.test.ts`

**Interfaces:**
- Consumes: `ExternalAgentSessionRow`, `ExternalAgentProviderAdapter`, `ExternalAgentHistoryPageRequest`, and existing `ProviderHistoryViaCliHelpers`.
- Produces:
  - `providerHistoryPageViaCli(row, adapter, request, helpers): Promise<{ items: unknown[]; nextCursor?: string } | null>`
  - `providerHistoryOutputViaCli(...)`, retained as a compatibility wrapper that requests the initial descending page and serializes it.

- [ ] **Step 1: Write failing cursor-preservation coverage**

Extend the stopped-session host test so a provider with no local `historyPage` but with the one-shot page bridge receives
the decoded request:

```ts
historyRequest({ before: 'provider:turn-20', limit: 20, sortDirection: 'desc', itemsView: 'full' })
```

The fake bridge returns:

```ts
{ items: [{ id: 'turn-19', items: [] }], nextCursor: 'turn-0' }
```

Assert the host response carries `nextCursor: 'provider:turn-0'`. Also call with `before: 'snapshot:20'` and assert the
bridge is not invoked. The current code must fail because it has no stopped one-shot page path and falls back to snapshot
pagination.

- [ ] **Step 2: Run the daemon host/history tests and verify RED**

```bash
bun run scripts/bun-test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts apps/monad/test/unit/external-agent-host.test.ts --only-failures
```

Expected: the new stopped bridge/cursor assertion fails for the missing page-oriented primitive.

- [ ] **Step 3: Extract the one-shot page primitive**

Refactor the body of `providerHistoryOutputViaCli` so process launch and protocol handling resolve a page:

```ts
export interface ProviderHistoryPage {
  items: unknown[];
  nextCursor?: string;
}

export async function providerHistoryPageViaCli(
  row: ExternalAgentSessionRow,
  adapter: ExternalAgentProviderAdapter,
  request: ExternalAgentHistoryPageRequest,
  helpers: ProviderHistoryViaCliHelpers
): Promise<ProviderHistoryPage | null>
```

Pass `request` unchanged to `adapter.requestHistoryPage`, resolve the parsed `history_page` payload as `{ items,
nextCursor }`, and keep the current timeout, response-id, process shutdown, and structured-buffer cleanup paths.

Reimplement `providerHistoryOutputViaCli` as a compatibility wrapper:

```ts
const page = await providerHistoryPageViaCli(
  row,
  adapter,
  { limit: 20, sortDirection: 'desc', itemsView: 'full' },
  helpers
);
return page ? historyPageOutput({ providerSessionRef, workingPath: row.workingPath, limitBytes: MAX_OUTPUT_SNAPSHOT, page }) : null;
```

- [ ] **Step 4: Route stopped provider cursors through the primitive**

In `storedHistoryPage`, after local `adapter.historyPage` and before `observeWithProviderHistory`, call
`providerHistoryPageViaCli` when the cursor is not `stored`. Pass `providerHistoryPageRequest(req, cursor)` and the host's
existing agent/env/structured-buffer helpers. Convert a returned page with `providerHistoryPageResponse`.

Keep `snapshot:*` requests on `storedOutputHistoryPage` and retain `observeWithProviderHistory` as the fallback when the
bridge returns `null`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the two-file command from Step 2. Expected: all tests pass and the new cursor/order assertions are exact full-shape
assertions rather than existence checks.

- [ ] **Step 6: Run transport regression coverage**

```bash
bun run scripts/bun-test.ts apps/monad/test/e2e/native-agent-cli-bridge.test.ts --only-failures
```

Expected: TCP loopback and Unix-socket cases both pass.

- [ ] **Step 7: Commit**

```bash
git add apps/monad/src/services/external-agent/host/history-backfill.ts apps/monad/src/services/external-agent/host/index.ts apps/monad/src/services/external-agent/host/observation-resolve.ts apps/monad/test/unit/external-agent-history-cursor.test.ts apps/monad/test/unit/external-agent-host.test.ts
git commit -m "fix(external-agent): page stopped provider history"
```

### Task 3: Verify the Complete Fix

**Files:**
- Verify only: all changed files and the target runtime API.

**Interfaces:**
- Consumes: committed Task 1 and Task 2 behavior.
- Produces: evidence that repository gates and the original stopped-runtime pagination scenario pass.

- [ ] **Step 1: Run changed-scope checks**

```bash
bun run lint
bun run typecheck
bun run scripts/bun-test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts apps/monad/test/unit/external-agent-host.test.ts packages/atoms/test/unit/observation-history.test.ts apps/monad/test/e2e/native-agent-cli-bridge.test.ts --only-failures
```

Expected: each command exits zero.

- [ ] **Step 2: Run the full suite**

```bash
bun run test
```

Expected: all Turbo test tasks pass.

- [ ] **Step 3: Inspect the diff and assertion quality**

```bash
git diff --check HEAD~2..HEAD
git diff --stat HEAD~2..HEAD
bun run check:test-assertions
```

Expected: no whitespace errors, only scoped files changed, and no weak test assertions.

- [ ] **Step 4: Deploy and reproduce after integration approval**

After the branch is integrated into `main`, run `bun run deploy:local`, then request consecutive pages for
`exa_L9VpOFWlanoR`. Verify the first response has a `provider:*` cursor, the next page contains older timestamps, and the
combined displayed sequence remains chronological after prepend.
