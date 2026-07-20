# Inbox HITL and Read State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Inbox into a durable operator attention queue with directly answerable HITL questions, required-versus-best-effort QA waits, meaningful-visibility read state, and a separate Need response sidebar summary.

**Architecture:** Keep messages and durable events as Inbox content truth, add only `inbox_item_reads` for operator read state, and project mention/approval/HITL items through one store module. Make clarification resolution an atomic durable lifecycle that restores expiry timers after daemon restart; the Web client uses general Inbox APIs, RTK Query summary polling/invalidation, and `react-intersection-observer` behind a thin 500 ms exposure coordinator.

**Tech Stack:** Bun, TypeScript, Zod, Elysia, bun:sqlite/Drizzle, React 19, RTK Query, `react-intersection-observer@^10.1.0`, Bun test, Playwright.

## Global Constraints

- Omitted `autoResolutionMs` means required human input with no automatic timeout.
- Supplied `autoResolutionMs` must be an integer from `60_000` through `240_000` milliseconds.
- Read state and action state are independent; only meaningful visibility marks an item read.
- Use stable keys `mention:<messageId>`, `approval:<requestId>`, and `hitl:<requestId>`.
- Required HITL must not resolve empty on capacity pressure, browser disconnect, or daemon restart.
- Use `react-intersection-observer`; do not add raw scroll listeners or a read-specific `ResizeObserver`.
- Preserve `GET /v1/inbox/mentions` compatibility until all first-party consumers use the general API.
- Do not continuously loop sidebar badge text; respect reduced motion.

---

### Task 1: Protocol and QA Tool Contract

**Files:**
- Modify: `packages/protocol/src/inbox.ts`
- Modify: `packages/protocol/src/event-table.ts`
- Modify: `packages/protocol/src/rpc/control.ts`
- Modify: `packages/protocol/src/http.ts`
- Modify: `apps/monad/src/capabilities/tools/registry/clarify.ts`
- Create: `packages/protocol/test/inbox.test.ts`
- Modify: `apps/monad/test/unit/services/clarify.test.ts`

**Interfaces:**
- Produces: `InboxItem`, `HitlInboxItem`, `InboxFilter`, `ListInboxQuery`, `ListInboxResponse`, `InboxSummary`, `MarkInboxReadRequest`, `MarkInboxReadResponse`.
- Produces: clarification requested payload fields `autoResolutionMs?: number`, `expiresAt?: string`, and origin metadata needed for restart continuation.
- Produces: `ClarifyAsk(sessionId, request)` where request carries `question`, `options`, and optional `autoResolutionMs`.

- [ ] **Step 1: Write failing protocol tests**

Add tests that parse all three Inbox variants, reject out-of-range auto-resolution values, accept omission, parse filters/summary/read batches, and parse terminal clarification response variants.

```ts
expect(clarifyRequestedPayloadSchema.safeParse({
  requestId: 'req_ABCDEF123456',
  question: 'Proceed?',
  autoResolutionMs: 60_000,
  expiresAt: '2026-07-21T00:01:00.000Z'
}).success).toBe(true);
expect(clarifyRequestedPayloadSchema.safeParse({
  requestId: 'req_ABCDEF123456',
  question: 'Proceed?',
  autoResolutionMs: 59_999
}).success).toBe(false);
```

- [ ] **Step 2: Run RED tests**

Run: `bun test packages/protocol/test/inbox.test.ts apps/monad/test/unit/services/clarify.test.ts`

Expected: FAIL because general Inbox schemas and `autoResolutionMs` are absent.

- [ ] **Step 3: Implement schemas and tool input**

Define the general item context, action-state enum, HITL variant, list/filter/summary/read contracts, and terminal clarify response. Change `createClarifyTool` so the tool schema is:

```ts
const clarifyInput = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
  autoResolutionMs: z.number().int().min(60_000).max(240_000).optional()
});
```

Pass the structured request to the service and update the description to distinguish required from best-effort questions.

- [ ] **Step 4: Run GREEN tests and typecheck**

Run: `bun test packages/protocol/test/inbox.test.ts apps/monad/test/unit/services/clarify.test.ts && bun run --cwd packages/protocol typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol apps/monad/src/capabilities/tools/registry/clarify.ts apps/monad/test/unit/services/clarify.test.ts
git commit -m "feat(inbox): define HITL contracts"
```

### Task 2: Inbox Persistence and Global Projection

**Files:**
- Modify: `apps/monad/src/store/db/schema.ts`
- Create: `apps/monad/src/store/db/operator-inbox.ts`
- Modify: `apps/monad/src/store/db/index.ts`
- Modify: `apps/monad/src/store/db/mesh-agent-inbox.ts`
- Create: `apps/monad/test/unit/store/operator-inbox.test.ts`
- Generate: `apps/monad/drizzle/0002_inbox-read-state.sql`
- Generate: `apps/monad/drizzle/meta/0002_snapshot.json`
- Generate: `apps/monad/src/store/db/migrations.generated.ts`

**Interfaces:**
- Consumes: protocol Inbox schemas from Task 1.
- Produces: `listOperatorInbox(query): ListInboxResponse`, `operatorInboxSummary(): InboxSummary`, `markOperatorInboxRead(itemKeys, readAt): MarkInboxReadResponse`.

- [ ] **Step 1: Write failing store tests**

Cover mixed-source global ordering, unresolved and resolved clarifications, independent read/action state, earliest-read preservation, idempotent batches, filters, summary counts, and limit application after global sorting.

```ts
store.markOperatorInboxRead(['hitl:req_ABCDEF123456'], '2026-07-21T00:01:00.000Z');
store.markOperatorInboxRead(['hitl:req_ABCDEF123456'], '2026-07-21T00:02:00.000Z');
expect(store.listOperatorInbox({ filter: 'all', limit: 100 }).items[0]?.readAt)
  .toBe('2026-07-21T00:01:00.000Z');
```

- [ ] **Step 2: Run RED store tests**

Run: `bun test apps/monad/test/unit/store/operator-inbox.test.ts`

Expected: FAIL because the table and store methods do not exist.

- [ ] **Step 3: Add schema and generate migration**

Add `inboxItemReads(itemKey primary key, readAt not null)` to Drizzle schema. From `apps/monad`, run:

`bun run db:generate --name inbox-read-state`

Verify the generated SQL creates only `inbox_item_reads`, then run `bun run db:bundle`.

- [ ] **Step 4: Implement one projector**

Move operator-facing aggregation out of `mesh-agent-inbox.ts`. Query mentions, approvals, and clarify events with source row identities; normalize to `InboxItem`, globally sort before limiting, join `inbox_item_reads`, and derive action states. Keep `listMentionInbox` as a compatibility adapter over the new projector.

- [ ] **Step 5: Run GREEN store and migration tests**

Run: `bun test apps/monad/test/unit/store/operator-inbox.test.ts apps/monad/test/unit/store/migrations.test.ts apps/monad/test/unit/store/migration-drift.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/monad/src/store apps/monad/drizzle apps/monad/test/unit/store
git commit -m "feat(inbox): persist operator read state"
```

### Task 3: Durable Clarification Lifecycle

**Files:**
- Modify: `apps/monad/src/store/db/events.ts`
- Modify: `apps/monad/src/store/db/index.ts`
- Modify: `apps/monad/src/services/generation/clarify.ts`
- Modify: `apps/monad/src/agent/approvals/interrupts.ts`
- Modify: `apps/monad/src/application/agent-runtime.ts`
- Modify: `apps/monad/src/handlers/daemon-handlers/handlers-oversight.ts`
- Modify: `apps/monad/src/handlers/daemon-handlers/index.ts`
- Modify: `apps/monad/src/services/native-agent/project.ts`
- Create: `apps/monad/test/unit/services/clarify-lifecycle.test.ts`
- Modify: `apps/monad/test/unit/services/clarify.test.ts`

**Interfaces:**
- Produces: store-backed `listPendingClarifications()` and atomic `resolveClarification(requestId, answer, reason)`.
- Produces: `ClarifyService.restore()` and `ClarifyService.setRecoveredContinuation(handler)`.
- Consumes: continuation origin metadata from Task 1.

- [ ] **Step 1: Write failing lifecycle tests**

Test required requests with no timer, bounded expiry, restored remaining timers, immediate expiry after restart, exactly-one answer/timeout resolution, capacity error, and removal of `daemon_restarted` clarify tombstones.

```ts
const restarted = createServiceFromStore(store, clock);
await restarted.restore();
expect(store.listPendingClarifications()).toHaveLength(1);
expect(restarted.respond(requestId, 'yes').status).toBe('answered');
```

- [ ] **Step 2: Run RED lifecycle tests**

Run: `bun test apps/monad/test/unit/services/clarify.test.ts apps/monad/test/unit/services/clarify-lifecycle.test.ts`

Expected: FAIL on required default, durable restore, atomic resolution, and capacity behavior.

- [ ] **Step 3: Implement atomic event lifecycle**

Add a SQLite transaction that finds an unresolved request, inserts one `clarify.resolved` event if still unresolved, and returns its terminal state. Make `ClarifyService` publish creation facts, delegate terminal claims to the store-backed callback, maintain live waiters/timers, and rebuild pending records from durable events.

- [ ] **Step 4: Implement restart continuation routing**

Stop startup tombstoning of clarification requests. Extract managed-project answer delivery from the current open HTTP call so live and recovered answers share a request-ID-idempotent delivery helper. After daemon handlers create the session module, register a recovered daemon-agent continuation handler that writes a bounded system context message through message ingress and calls session continuation from history exactly once.

- [ ] **Step 5: Run GREEN lifecycle and focused integration tests**

Run: `bun test apps/monad/test/unit/services/clarify.test.ts apps/monad/test/unit/services/clarify-lifecycle.test.ts apps/monad/test/e2e/native-agent-cli-bridge.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/monad/src apps/monad/test/unit/services apps/monad/test/e2e/native-agent-cli-bridge.test.ts
git commit -m "feat(hitl): persist clarification waits"
```

### Task 4: General Inbox HTTP and RTK Query API

**Files:**
- Modify: `apps/monad/src/transports/http/inbox.ts`
- Modify: `apps/monad/src/transports/http/clarify.ts`
- Modify: `packages/client-rtk/src/endpoints/inbox/index.ts`
- Modify: `packages/client-rtk/src/endpoints/tools/clarify-respond.ts`
- Modify: `packages/client-rtk/src/api.ts`
- Modify: `packages/client-rtk/src/endpoints/sessions/stream-control.ts`
- Create: `apps/monad/test/e2e/inbox-hitl.test.ts`
- Create: `packages/client-rtk/test/unit/inbox.test.ts`

**Interfaces:**
- Consumes: store methods from Tasks 2-3.
- Produces: `/v1/inbox/items`, `/v1/inbox/summary`, `/v1/inbox/read`, terminal-state clarification responses, and first-party RTK hooks.

- [ ] **Step 1: Write failing HTTP and client tests**

Assert filtering/summary/read endpoints, duplicate response terminal state, legacy mentions compatibility, mutation invalidation of `Inbox`, and session-stream invalidation on mention/approval/clarify events.

- [ ] **Step 2: Run RED API tests**

Run: `bun test apps/monad/test/e2e/inbox-hitl.test.ts packages/client-rtk/test/unit/inbox.test.ts`

Expected: FAIL because the routes and hooks are absent.

- [ ] **Step 3: Implement HTTP controllers**

Wire schema-first contracts to the store. Use server time for read mutations. Change clarify response to return stored terminal state and return `not-found` only for unknown IDs.

- [ ] **Step 4: Implement RTK endpoints and invalidation**

Export `useListInboxQuery`, `useGetInboxSummaryQuery`, `useMarkInboxReadMutation`, and the updated respond hook. Invalidate `Inbox` after mutations and from active session event streams for Inbox-changing event types; configure summary/list hooks with a conservative polling fallback in Web consumers.

- [ ] **Step 5: Run GREEN API tests and typecheck**

Run: `bun test apps/monad/test/e2e/inbox-hitl.test.ts packages/client-rtk/test/unit/inbox.test.ts && bun run --cwd packages/client-rtk typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/monad/src/transports/http apps/monad/test/e2e/inbox-hitl.test.ts packages/client-rtk packages/protocol/src/http.ts
git commit -m "feat(inbox): expose general operator API"
```

### Task 5: Inbox UI and Need Response Sidebar

**Files:**
- Modify: `apps/web/src/features/inbox/InboxRoute.tsx`
- Create: `apps/web/src/features/inbox/inbox-item-row.tsx`
- Create: `apps/web/src/features/inbox/hitl-inbox-card.tsx`
- Create: `apps/web/src/features/inbox/inbox-filters.tsx`
- Modify: `apps/web/src/features/shell/sidebar/workspace-items.tsx`
- Modify: `apps/web/src/features/shell/sidebar/nav-item.tsx`
- Modify: `packages/i18n/src/locales/en/web.json`
- Modify: `packages/i18n/src/locales/zh/web.json`
- Create: `apps/web/test/unit/inbox-view-model.test.ts`
- Create: `apps/web/test/unit/inbox-sidebar-badge.test.tsx`

**Interfaces:**
- Consumes: general Inbox and summary RTK hooks from Task 4.
- Produces: kind-specific cards, local HITL drafts keyed by request ID, filters, and accessible static/finite sidebar badge.

- [ ] **Step 1: Write failing view-model and render tests**

Cover independent read/action presentation, filter selection, HITL answer payloads, draft preservation, read pending Need response, quiet unread fallback, accessible full badge label, and reduced-motion/static markup.

- [ ] **Step 2: Run RED Web tests**

Run: `bun test apps/web/test/unit/inbox-view-model.test.ts apps/web/test/unit/inbox-sidebar-badge.test.tsx`

Expected: FAIL because components and view helpers are absent.

- [ ] **Step 3: Split and implement Inbox components**

Keep route fetching/action orchestration small. Render mention navigation, approval controls, HITL options/free text, and completed states. Preserve drafts in route state keyed by `requestId`; disable only the active item during submission.

- [ ] **Step 4: Implement sidebar summary treatment**

Fetch summary with polling fallback. Show `Need response · N` whenever needs-response is nonzero, otherwise a quiet unread dot/count. Clip narrow text, expose full tooltip/accessible name, and reuse only the finite intent-driven marquee primitive when actual overflow is detected.

- [ ] **Step 5: Run GREEN Web tests and typecheck**

Run: `bun test apps/web/test/unit/inbox-view-model.test.ts apps/web/test/unit/inbox-sidebar-badge.test.tsx && bun run --cwd apps/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/inbox apps/web/src/features/shell/sidebar apps/web/test/unit packages/i18n/src/locales
git commit -m "feat(web): add actionable HITL inbox"
```

### Task 6: Meaningful Visibility Read Trigger

**Files:**
- Modify: `apps/web/package.json`
- Modify: `bun.lock`
- Create: `apps/web/src/features/inbox/inbox-read-exposure.ts`
- Create: `apps/web/src/features/inbox/inbox-read-region.tsx`
- Modify: `apps/web/src/features/inbox/inbox-item-row.tsx`
- Create: `apps/web/test/unit/inbox-read-exposure.test.ts`
- Create: `apps/web/test/e2e/inbox-hitl-read-state.spec.ts`

**Interfaces:**
- Consumes: `useOnInView` from `react-intersection-observer` and mark-read mutation from Task 4.
- Produces: stable primary-content read region and a coordinator that owns dwell timers, de-duplication, batching, and retries.

- [ ] **Step 1: Add dependency**

From `apps/web`, run: `bun add react-intersection-observer@^10.1.0`

- [ ] **Step 2: Write failing exposure coordinator tests**

Use a pure clock/scheduler boundary to test 500 ms continuous dwell, cancellation, page-hidden cancellation, remount by stable item key, batch de-duplication, and retry retention. Use the library test utilities where DOM-level observer behavior is exercised.

- [ ] **Step 3: Run RED exposure tests**

Run: `bun test apps/web/test/unit/inbox-read-exposure.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 4: Implement thin library wrapper**

Observe the stable title/question-preview wrapper with `root` set to Inbox's scroll element and `threshold: 0.5`. Start/cancel only the 500 ms business timer in Monad code. Enable `trackVisibility` and `delay: 100` when supported; use ordinary intersection otherwise. Never attach scroll or resize listeners.

- [ ] **Step 5: Run GREEN unit and Playwright tests**

Run: `bun test apps/web/test/unit/inbox-read-exposure.test.ts`

Run serially: `bunx playwright test apps/web/test/e2e/inbox-hitl-read-state.spec.ts --workers=1 --reporter=dot`

Expected: PASS, including reload persistence and read-but-pending badge behavior.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json bun.lock apps/web/src/features/inbox apps/web/test
git commit -m "feat(inbox): mark meaningfully viewed items read"
```

### Task 7: Full Verification and Documentation Consistency

**Files:**
- Modify only if verification exposes scoped defects.

**Interfaces:**
- Consumes every prior task.
- Produces a verified feature matching `docs/superpowers/specs/2026-07-21-inbox-hitl-read-state-design.md`.

- [ ] **Step 1: Run focused regression suite**

```bash
bun test packages/protocol/test/inbox.test.ts \
  apps/monad/test/unit/store/operator-inbox.test.ts \
  apps/monad/test/unit/services/clarify.test.ts \
  apps/monad/test/unit/services/clarify-lifecycle.test.ts \
  apps/monad/test/e2e/inbox-hitl.test.ts \
  apps/web/test/unit/inbox-view-model.test.ts \
  apps/web/test/unit/inbox-sidebar-badge.test.tsx \
  apps/web/test/unit/inbox-read-exposure.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package gates**

Run:

```bash
bun run --cwd packages/protocol typecheck
bun run --cwd packages/client-rtk typecheck
bun run --cwd apps/monad typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/monad db:drift
```

Expected: all exit 0.

- [ ] **Step 3: Run serial browser coverage**

Run: `bunx playwright test apps/web/test/e2e/inbox-hitl-read-state.spec.ts --workers=1 --reporter=dot`

Expected: PASS.

- [ ] **Step 4: Re-read the approved spec line by line**

Verify protocol, persistence, required wait, bounded timeout, restart restoration, Inbox actions, meaningful visibility, sidebar priority, accessibility, legacy compatibility, and race behavior all have code and tests.

- [ ] **Step 5: Inspect final diff**

Run: `git status --short && git diff --check && git diff HEAD~6 --stat`

Expected: no unrelated files or whitespace errors.
