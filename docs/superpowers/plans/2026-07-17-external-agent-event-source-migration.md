# External Agent EventSource Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace provider-specific live/history plumbing with one normalized EventSource contract across all six built-in external-agent adapters, the daemon, protocol, client, and Workplace UI.

**Architecture:** Each adapter owns provider wire parsing, history acquisition, stable event identity, and provider cursor semantics. The daemon consumes normalized events, wraps provider cursors in its opaque cursor namespace, maintains the live tail and durable normalized observation journal, and exposes only current-frame, subscribe, and page operations. Clients merge by a stable `dedupeKey` and never inspect provider `raw` fields.

**Tech Stack:** Bun 1.3.14, TypeScript, Zod, Drizzle SQLite, Elysia/Treaty, RTK Query, React, `bun:test`.

## Global Constraints

- Migrate `codex`, `claude-code`, `gemini`, `qwen`, `openclaw`, and `hermes`; no built-in adapter may retain the legacy history hooks.
- Provider-specific APIs, file layouts, event vocabularies, identities, checkpoints, and cursors stay inside adapter modules.
- `@monad/protocol`, daemon transports, RTK, and UI consume normalized `ExternalAgentObservationEvent` values and opaque cursors only.
- Generic code must not branch on provider names or inspect `event.raw` for pagination, deduplication, activity, or checkpoint logic.
- Preserve provider raw payloads only as optional diagnostic/card-rendering data.
- Preserve TCP loopback and Unix-socket parity for every daemon behavior.
- Add no dependency, environment variable, or user-facing string.
- Use test-first red/green cycles and quiet Bun test entry points.

---

### Task 1: Define the normalized protocol and adapter contract

**Files:**
- Modify: `packages/protocol/src/external-agent/external-agent-observation.ts`
- Modify: `packages/protocol/src/external-agent/external-agent-session.ts`
- Modify: `packages/protocol/test/external-agent.test.ts`
- Modify: `packages/sdk-atom/src/agent-adapter.ts`
- Modify: `packages/sdk-atom/test/unit/agent-adapter.test.ts`

**Interfaces:**
- Produces `ExternalAgentObservationEvent.dedupeKey: string`.
- Produces `ExternalAgentEventPageRequest`, `ExternalAgentEventPage`, `ExternalAgentEventPageResult`, and `ExternalAgentEventSource`.
- Produces frame field `historyBefore?: string`; the value is opaque outside the daemon/adapter boundary.

- [ ] **Step 1: Add failing protocol tests**

Assert exact parsing of an event and frame:

```ts
expect(
  externalAgentObservationEventSchema.parse({
    id: 'evt_render_1',
    dedupeKey: 'turn_1:item_1',
    role: 'agent',
    text: 'done',
    source: 'codex-app-server'
  })
).toEqual({
  id: 'evt_render_1',
  dedupeKey: 'turn_1:item_1',
  role: 'agent',
  text: 'done',
  source: 'codex-app-server'
});
```

Add an exact frame assertion containing `historyBefore: 'provider:opaque'`.

- [ ] **Step 2: Run protocol tests and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/protocol/test/external-agent.test.ts --only-failures
```

Expected: schema strips or rejects `dedupeKey`/`historyBefore` because the contract is not defined.

- [ ] **Step 3: Add failing SDK compile/runtime contract test**

Create a minimal `ExternalAgentEventSource` whose page method returns normalized events:

```ts
const source: ExternalAgentEventSource = {
  projectLive: () => ({ events: [] }),
  readPage: async () => ({ state: 'available', events: [], nextCursor: 'next' })
};
expect(await source.readPage?.(historyContext, { limit: 20, sortDirection: 'desc' })).toEqual({
  state: 'available',
  events: [],
  nextCursor: 'next'
});
```

- [ ] **Step 4: Implement the contracts**

Add these shapes to `agent-adapter.ts`:

```ts
export interface ExternalAgentEventPageRequest {
  before?: string;
  limit: number;
  sortDirection: 'asc' | 'desc';
}

export interface ExternalAgentEventPage {
  events: ExternalAgentObservationEvent[];
  nextCursor?: string;
}

export type ExternalAgentEventPageResult =
  | ({ state: 'available' } & ExternalAgentEventPage)
  | { state: 'unavailable'; reason: 'unsupported' | 'not-found' | 'temporary' };

export interface ExternalAgentEventSource {
  projectLive(args: {
    id: string;
    output: string;
    mode?: 'live' | 'history';
  }): ExternalAgentEventPage;
  readPage?(context: ExternalAgentProviderHistoryContext, request: ExternalAgentEventPageRequest): Promise<ExternalAgentEventPageResult>;
}
```

Add `events: ExternalAgentEventSource` to `ExternalAgentProviderAdapter`. Keep legacy hooks temporarily in this task so the adapters compile; Task 6 removes them.

- [ ] **Step 5: Run protocol and SDK tests and verify GREEN**

```bash
bun scripts/bun-test.ts packages/protocol/test/external-agent.test.ts packages/sdk-atom/test/unit/agent-adapter.test.ts --only-failures
```

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/protocol packages/sdk-atom
git commit -m "feat(external-agent): define normalized event source contract"
```

### Task 2: Build shared adapter projection and conformance helpers

**Files:**
- Create: `packages/atoms/src/agent-adapters/event-source.ts`
- Create: `packages/atoms/test/unit/external-agent-event-source-conformance.test.ts`
- Modify: `packages/atoms/src/agent-adapters/observation-adapters.ts`

**Interfaces:**
- Consumes each adapter's existing `ExternalAgentObservationProjector`.
- Produces `createProjectedEventSource(provider, projection, historyReader?)`.
- Produces `eventDedupeKey(adapter, event)` without exposing provider raw fields to consumers.

- [ ] **Step 1: Write failing conformance tests**

For every built-in observation projector, project one representative live fixture and history fixture and assert:

```ts
expect(history.events.map((event) => event.dedupeKey)).toEqual(live.events.map((event) => event.dedupeKey));
expect(history.events.every((event) => event.dedupeKey.length > 0)).toBe(true); // presence-ok: dedupeKey is the contract under test
```

Also assert a page reader's cursor is passed through unchanged and an empty reader result becomes `{ state: 'unavailable', reason: 'not-found' }`.

- [ ] **Step 2: Run conformance test and verify RED**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts --only-failures
```

- [ ] **Step 3: Implement the shared source**

Use the existing projector's `identity(event)` for `dedupeKey`; when absent, derive a deterministic hash input from normalized role, provider event type, timestamp, and text inside the adapter package. Never make consumers inspect `raw`.

```ts
export function createProjectedEventSource(args: {
  provider: ExternalAgentProvider;
  projection: ExternalAgentObservationProjector;
  readPage?: ExternalAgentEventSource['readPage'];
}): ExternalAgentEventSource;
```

`projectLive` calls the existing projection pipeline, assigns `dedupeKey`, and returns `{ events }`.

- [ ] **Step 4: Run conformance tests and verify GREEN**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
```

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/atoms/src/agent-adapters/event-source.ts packages/atoms/src/agent-adapters/observation-adapters.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts
git commit -m "refactor(atoms): normalize adapter observation sources"
```

### Task 3: Migrate file/direct history adapters

**Files:**
- Modify: `packages/atoms/src/agent-adapters/claude-code/index.ts`
- Modify: `packages/atoms/src/agent-adapters/claude-code/observation.ts`
- Modify: `packages/atoms/src/agent-adapters/gemini/index.ts`
- Modify: `packages/atoms/src/agent-adapters/gemini/observation.ts`
- Modify: `packages/atoms/src/agent-adapters/qwen/index.ts`
- Modify: `packages/atoms/src/agent-adapters/qwen/observation.ts`
- Modify: `packages/atoms/src/agent-adapters/hermes/index.ts`
- Modify: `packages/atoms/src/agent-adapters/hermes/history.ts`
- Test: `packages/atoms/test/unit/external-agent-event-source-conformance.test.ts`
- Test: `apps/monad/test/unit/claude-history-page.test.ts`

**Interfaces:**
- Produces `adapter.events.readPage()` for Claude, Gemini, Qwen, and Hermes.
- Returns normalized pages; raw provider items never cross the adapter boundary.

- [ ] **Step 1: Extend failing tests for four adapters**

For each adapter, invoke `events.readPage` using deterministic fixtures and assert the full normalized `{ state, events, nextCursor }` result. Include timestamp-less Claude events and a missing local Gemini/Qwen file result.

- [ ] **Step 2: Run tests and verify RED**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts apps/monad/test/unit/claude-history-page.test.ts --only-failures
```

- [ ] **Step 3: Implement Claude and Hermes direct pages**

Move `historyPageOutput` conversion behind their `readPage` functions. The returned value must already contain normalized events and the provider cursor.

- [ ] **Step 4: Implement Gemini and Qwen file pages**

Read the provider file internally, split complete records, page before the opaque file offset cursor, project within the adapter, and return normalized events. A missing or unparseable file returns structured unavailable.

- [ ] **Step 5: Run tests and verify GREEN**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts apps/monad/test/unit/claude-history-page.test.ts --only-failures
```

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/atoms/src/agent-adapters/{claude-code,gemini,qwen,hermes} packages/atoms/test/unit/external-agent-event-source-conformance.test.ts apps/monad/test/unit/claude-history-page.test.ts
git commit -m "refactor(atoms): migrate file-backed event sources"
```

### Task 4: Migrate app-server history adapters

**Files:**
- Modify: `packages/atoms/src/agent-adapters/codex/index.ts`
- Modify: `packages/atoms/src/agent-adapters/codex/runtime.ts`
- Modify: `packages/atoms/src/agent-adapters/codex/history.ts`
- Modify: `packages/atoms/src/agent-adapters/openclaw/index.ts`
- Modify: `packages/atoms/src/agent-adapters/openclaw/app-server.ts`
- Test: `packages/atoms/test/unit/external-agent-event-source-conformance.test.ts`
- Test: `apps/monad/test/unit/external-agent-history-cursor.test.ts`

**Interfaces:**
- Produces normalized `events.readPage` for Codex and OpenClaw.
- Uses an adapter-owned request executor injected by the daemon when the provider needs a running or temporary app-server.

- [ ] **Step 1: Add failing Codex/OpenClaw page tests**

Feed representative `turn/list` and OpenClaw history responses into their adapter source and assert normalized event pages, stable dedupe keys, and unchanged provider next cursors.

- [ ] **Step 2: Run tests and verify RED**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts --only-failures
```

- [ ] **Step 3: Implement adapter-owned response projection**

Codex converts turns/items directly to normalized events inside `codex/history.ts`. OpenClaw performs the equivalent conversion inside `openclaw/app-server.ts`. Neither returns `history_page` control events to generic observation consumers.

- [ ] **Step 4: Implement request binding**

Add an SDK context callback:

```ts
requestProviderPage?: (request: unknown) => Promise<{ items: unknown[]; nextCursor?: string }>;
```

The daemon supplies transport execution; the adapter owns request/response vocabulary and normalization.

- [ ] **Step 5: Run tests and verify GREEN**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts --only-failures
```

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/atoms/src/agent-adapters/{codex,openclaw} packages/sdk-atom/src/agent-adapter.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts
git commit -m "refactor(atoms): migrate app-server event sources"
```

### Task 5: Add the daemon event coordinator and durable normalized journal

**Files:**
- Create: `apps/monad/src/store/db/external-agent-observations.ts`
- Modify: `apps/monad/src/store/db/schema.ts`
- Modify: `apps/monad/src/store/db/index.ts`
- Modify: `apps/monad/drizzle/0002_external-agent-observations.sql`
- Modify: `apps/monad/drizzle/meta/_journal.json`
- Regenerate: `apps/monad/src/store/db/migrations.generated.ts`
- Create: `apps/monad/src/services/external-agent/host/event-coordinator.ts`
- Modify: `apps/monad/src/services/external-agent/host/output-pipeline.ts`
- Modify: `apps/monad/src/services/external-agent/host/observation-resolve.ts`
- Modify: `apps/monad/src/services/external-agent/host/index.ts`
- Test: `apps/monad/test/unit/store/external-agent-observations.test.ts`
- Test: `apps/monad/test/unit/external-agent-host.test.ts`

**Interfaces:**
- Stores `{ sessionId, seq, dedupeKey, eventJson, observedAt }` with a unique `(sessionId, dedupeKey)` constraint.
- Produces coordinator methods `current(id)`, `page(id, request)`, and `append(id, events)`.

- [ ] **Step 1: Write failing store tests**

Append two events with the same dedupe key and assert the exact page contains one canonical event. Insert three unique events and assert descending pagination returns two events plus an opaque next cursor, followed by the remaining event.

- [ ] **Step 2: Run store tests and verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/store/external-agent-observations.test.ts --only-failures
```

- [ ] **Step 3: Add schema and store operations**

Create the journal table, prepared insert/list statements, bounded retention per runtime, and schema parsing of stored `event_json`. Generate migration assets using the repository migration script; do not hand-edit generated TypeScript.

- [ ] **Step 4: Write failing coordinator tests**

Cover live append, stopped journal read, corrupt legacy snapshot fallback through `adapter.events.readPage`, provider unavailable fallback to journal, and provider cursor wrapping.

- [ ] **Step 5: Run host tests and verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/external-agent-host.test.ts --only-failures
```

- [ ] **Step 6: Implement the coordinator**

`output-pipeline` projects each complete provider frame once and sends normalized events to `append`. Control/lifecycle events still flow through `parseOutput`; provider JSON-RPC control responses are never appended to the observation journal. `page` asks the adapter source first when a provider reference exists, then uses the durable journal. It wraps provider/journal cursors with the existing daemon cursor namespace.

- [ ] **Step 7: Run store and host tests and verify GREEN**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/store/external-agent-observations.test.ts apps/monad/test/unit/external-agent-host.test.ts --only-failures
```

- [ ] **Step 8: Commit Task 5**

```bash
git add apps/monad/src/store apps/monad/src/services/external-agent apps/monad/drizzle
git commit -m "feat(monad): coordinate durable external agent events"
```

### Task 6: Remove legacy history hooks and raw-output observation flow

**Files:**
- Modify: `packages/sdk-atom/src/agent-adapter.ts`
- Modify: all files under `packages/atoms/src/agent-adapters/` referencing `historyPage`, `requestHistoryPage`, `historyPageOutput`, or `historyOutput`
- Delete: `apps/monad/src/services/external-agent/host/history-backfill.ts`
- Modify: `apps/monad/src/services/external-agent/host/index.ts`
- Modify: `apps/monad/src/services/external-agent/host/host-types.ts`
- Test: `apps/monad/test/unit/external-agent-adapters.test.ts`

**Interfaces:**
- Leaves `ExternalAgentProviderAdapter.events` as the only observation/history surface.
- Keeps `parseOutput` only for lifecycle/control events until a separately scoped control-plane migration.

- [ ] **Step 1: Add failing adapter surface test**

Assert all built-in adapters provide `events`, and exercise `events.projectLive` plus `events.readPage` when history is declared. Type-level references to the four legacy hooks must fail compilation after removal.

- [ ] **Step 2: Remove legacy hooks and helpers**

Delete the four fields from the SDK interface, remove their implementations, and replace daemon calls with coordinator calls. Remove pseudo-live JSONL reconstruction helpers used only by `historyPageOutput`.

- [ ] **Step 3: Run adapter and type checks**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/external-agent-adapters.test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts --only-failures
bun run typecheck
```

- [ ] **Step 4: Commit Task 6**

```bash
git add packages/sdk-atom packages/atoms apps/monad
git commit -m "refactor(external-agent): remove legacy history hooks"
```

### Task 7: Reduce transports and clients to current/subscribe/page

**Files:**
- Modify: `packages/protocol/src/rpc/method-table.ts`
- Modify: `apps/monad/src/transports/http/external-agent.ts`
- Modify: `apps/monad/src/handlers/external-agent/index.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `packages/client-rtk/src/endpoints/external-agent/get-external-agent-history-page.ts`
- Modify: `packages/client-rtk/src/endpoints/external-agent/stream-external-agent-ui-observation.ts`
- Test: `apps/monad/test/unit/transports/server-routes.test.ts`
- Test: `apps/monad/test/e2e/external-agent-runtime.test.ts`
- Test: `packages/client-rtk/test/unit/api.test.ts`

**Interfaces:**
- HTTP remains compatible at `/observation`, `/ui-observation-stream`, and `/history-page` while responses use normalized events and opaque cursors.
- TCP/Unix method dispatch uses the same coordinator methods.

- [ ] **Step 1: Add failing transport tests**

For both TCP loopback and Unix socket, append normalized events, read current, subscribe after a cursor, and page backward. Assert exact equivalent response shapes and cursor behavior.

- [ ] **Step 2: Run transport/client tests and verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/e2e/external-agent-runtime.test.ts apps/monad/test/unit/transports/server-routes.test.ts packages/client-rtk/test/unit/api.test.ts --only-failures
```

- [ ] **Step 3: Route all surfaces through the coordinator**

Controllers validate request schemas, call `current`, `subscribe`, or `page`, and serialize protocol responses. No transport parses output or provider cursor formats.

- [ ] **Step 4: Run transport/client tests and verify GREEN**

```bash
bun scripts/bun-test.ts apps/monad/test/e2e/external-agent-runtime.test.ts apps/monad/test/unit/transports/server-routes.test.ts packages/client-rtk/test/unit/api.test.ts --only-failures
```

- [ ] **Step 5: Commit Task 7**

```bash
git add packages/protocol packages/client packages/client-rtk apps/monad/src/handlers apps/monad/src/transports apps/monad/test packages/client-rtk/test
git commit -m "refactor(external-agent): expose event source operations"
```

### Task 8: Remove provider knowledge from Workplace UI

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/observation-history.ts`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx`
- Modify: `packages/atoms/src/workspace-experiences/experience/external-agent-observation/external-agent-observation.ts`
- Test: `packages/atoms/test/unit/observation-history.test.ts`
- Test: `packages/atoms/test/unit/external-agent-observation.test.ts`

**Interfaces:**
- Consumes only `frame.events`, `frame.historyBefore`, page cursors, and `event.dedupeKey`.
- Produces provider-independent merge and pagination behavior.

- [ ] **Step 1: Write failing UI helper tests**

Assert an empty stopped frame with `historyBefore` triggers a page request, live and history copies with different render IDs but the same dedupe key merge once, and no helper fixture requires `raw`.

- [ ] **Step 2: Run tests and verify RED**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/observation-history.test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
```

- [ ] **Step 3: Implement opaque pagination and dedupe**

Delete `providerObservationIdentity`, `providerObservationCheckpoint`, and every generic `raw.uuid`/`raw.params.turnId`/`raw.method` check. Load the first page from `historyBefore`; merge using `dedupeKey`; keep `raw` only on rendered events.

- [ ] **Step 4: Run tests and verify GREEN**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/observation-history.test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
```

- [ ] **Step 5: Commit Task 8**

```bash
git add packages/atoms/src/workspace-experiences packages/atoms/test/unit
git commit -m "refactor(workplace): consume opaque agent event pages"
```

### Task 9: Conformance and repository verification

**Files:**
- Verify all files changed in Tasks 1-8.

**Interfaces:**
- Produces a reviewable branch with no legacy history hooks or provider-aware generic consumers.

- [ ] **Step 1: Run focused conformance and regression suites**

```bash
bun scripts/bun-test.ts packages/protocol/test/external-agent.test.ts packages/sdk-atom/test/unit/agent-adapter.test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts packages/atoms/test/unit/observation-history.test.ts packages/atoms/test/unit/external-agent-observation.test.ts apps/monad/test/unit/store/external-agent-observations.test.ts apps/monad/test/unit/external-agent-host.test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts apps/monad/test/e2e/external-agent-runtime.test.ts packages/client-rtk/test/unit/api.test.ts --only-failures
```

- [ ] **Step 2: Verify forbidden legacy/provider-aware patterns are gone**

```bash
rg -n "historyPageOutput|requestHistoryPage|historyOutput|providerObservationIdentity|providerObservationCheckpoint|raw\.uuid|params\.turnId" packages/sdk-atom packages/atoms/src/workspace-experiences apps/monad/src/services/external-agent
```

Expected: no matches in generic SDK host/UI surfaces; provider-specific matches are permitted only inside adapter implementation tests when parsing fixtures.

- [ ] **Step 3: Generate routes and migration assets**

```bash
bun run generate:routes
bun run --cwd apps/monad db:generate-assets
```

- [ ] **Step 4: Collect the full quality-gate failure surface**

```bash
bun run lint
bun run typecheck
bun run test
```

Record every failure before editing. If singleton-lock failures mention `MONAD_SUPERVISOR_PID`, rerun the same full suite with that inherited variable removed before attributing it to this branch.

- [ ] **Step 5: Fix the collected failures as one batch and rerun all three commands**

Require zero lint errors, zero type errors, and zero test failures.

- [ ] **Step 6: Audit the final diff**

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

Confirm migration history is append-only, tests contain no weak presence-only assertions, no provider-specific raw parsing remains outside adapter packages, and no user-facing string or dependency was added.
