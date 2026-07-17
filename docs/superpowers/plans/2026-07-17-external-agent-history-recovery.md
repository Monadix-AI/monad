# External Agent History Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stopped Workplace agents recover durable history when snapshots are empty or unparseable, provider events lack timestamps, or a newer empty runtime shadows an observable sibling.

**Architecture:** Keep provider and snapshot parsing in the daemon, but treat a history snapshot with zero projected events as a failed observation source and continue through existing provider fallback. Make client pagination bootstrap without a live timestamp, filter by time only when available, deduplicate by stable event ID, and select the newest observable sibling when no runtime is running.

**Tech Stack:** Bun, TypeScript, Elysia daemon handlers, React/RTK Query, `bun:test`.

## Global Constraints

- Do not rewrite persisted snapshots or synthesize missing provider timestamps.
- Preserve provider-first and stored-snapshot cursor contracts.
- Keep delivery observation behavior unchanged.
- Do not merge every historical runtime into one transcript.
- Add no dependencies, environment variables, user-facing strings, or logs containing provider history.
- Use Bun-only commands and repository quiet test entry points.

---

### Task 1: Recover provider history from an unparseable stored snapshot

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/observation-resolve.ts:118-180`
- Test: `apps/monad/test/unit/external-agent-host.test.ts:1268-1404`

**Interfaces:**
- Consumes: `ExternalAgentObservationResolver.observe(id, afterSeq?)`, `providerHistoryOutputViaCli`, `providerHistoryOutputFromLocal`, and `externalAgentStreamItems`.
- Produces: `observeWithProviderHistory(id): Promise<ExternalAgentObservationAccessResponse>` that accepts stored history only when it projects at least one event and otherwise tries provider fallback.

- [ ] **Step 1: Write the failing invalid-snapshot fallback test**

Create a Codex rollout file containing `restored from provider history`, persist a managed stopped runtime with the matching `providerSessionRef`, and use a non-empty invalid snapshot:

```ts
outputSnapshot: 'truncated provider frame without json newline\n'
```

Assert the exact observable contract rather than mere presence:

```ts
const observation = await host.observeWithProviderHistory(externalAgentSessionId);
expect(observation).toMatchObject({
  state: 'history',
  externalAgentSessionId,
  provider: 'codex',
  events: [expect.objectContaining({ text: 'restored from provider history' })]
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/external-agent-host.test.ts --only-failures
```

Expected: the new test fails because `observeWithProviderHistory` returns the non-empty snapshot with `events: []` without reading provider history.

- [ ] **Step 3: Add a parseable-snapshot precedence test**

Persist a parseable Codex snapshot containing `snapshot remains authoritative` while the provider file contains `provider fallback must not replace this`. Assert the returned output and projected event text are from the snapshot:

```ts
expect(observation).toMatchObject({
  state: 'history',
  output: expect.stringContaining('snapshot remains authoritative'),
  events: [expect.objectContaining({ text: 'snapshot remains authoritative' })]
});
```

- [ ] **Step 4: Implement observable-history fallback**

Keep live observations authoritative. For stopped history, return the base only when it has projected events:

```ts
const base = this.observe(id);
if (base.state === 'live') return base;
if (base.state === 'history' && (base.events?.length ?? 0) > 0) return base;
```

Extract provider output projection so empty provider output does not replace the diagnostic base:

```ts
private historyAccessFromOutput(
  id: string,
  row: ExternalAgentSessionRow,
  adapter: ExternalAgentProviderAdapter,
  output: string | null
): ExternalAgentObservationAccessResponse | null {
  if (!output) return null;
  const events = externalAgentStreamItems({ id, adapter, output, mode: 'history' });
  if (events.length === 0) return null;
  return {
    state: 'history',
    externalAgentSessionId: id as ExternalAgentSessionId,
    provider: row.provider,
    output,
    events,
    usageMeter: externalAgentUsageLimitMeter({ adapter, output }),
    observedAt: row.updatedAt
  };
}
```

Try CLI output, then local output, and finally return `base`.

- [ ] **Step 5: Run the daemon test and verify GREEN**

Run:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/external-agent-host.test.ts --only-failures
```

Expected: all tests in the file pass with no failures.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/monad/src/services/external-agent/host/observation-resolve.ts apps/monad/test/unit/external-agent-host.test.ts
git commit -m "fix(external-agent): recover history from invalid snapshots"
```

### Task 2: Bootstrap and retain timestamp-less paged history

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/observation-history.ts:3-65`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx:609-707`
- Test: `packages/atoms/test/unit/observation-history.test.ts`

**Interfaces:**
- Produces: `observationHistoryLoadScope({ deliveryId?, externalAgentSessionId? }): string | undefined`.
- Produces: `historyItemsBefore(items, liveBoundaryAt?, excludedIds?): AgentObservationEvent[]`.
- Produces: `findOlderObservationPage({ before?, liveBoundaryAt?, excludedIds?, load }): Promise<ObservationHistoryPage>`.
- Produces: `prependObservationHistory(pageItems, currentItems)` with stable-ID deduplication.

- [ ] **Step 1: Write failing helper tests**

Update/add exact assertions:

```ts
expect(
  observationHistoryLoadScope({ externalAgentSessionId: 'exa_empty', liveBoundaryAt: undefined })
).toBe('exa_empty');

expect(
  historyItemsBefore(
    [event('untimed'), event('duplicate'), event('newer', '2026-07-12T14:17:48.887Z')],
    '2026-07-12T14:14:40.000Z',
    new Set(['duplicate'])
  ).map((item) => item.id)
).toEqual(['untimed']);

expect(
  prependObservationHistory(
    [event('oldest'), event('same-render-id')],
    [event('same-render-id'), event('live')]
  ).map((item) => item.id)
).toEqual(['oldest', 'same-render-id', 'live']);
```

Add an async test where the first page has only excluded IDs, the second has one timestamp-less event, and assert both cursors were requested and the timestamp-less event is returned.

- [ ] **Step 2: Run helper tests and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/observation-history.test.ts --only-failures
```

Expected: failures show the empty load scope, dropped untimed item, and duplicate merged ID.

- [ ] **Step 3: Implement optional boundary filtering and ID deduplication**

Use these rules:

```ts
export function historyItemsBefore(
  items: AgentObservationEvent[],
  liveBoundaryAt?: string,
  excludedIds: ReadonlySet<string> = new Set()
): AgentObservationEvent[] {
  const boundary = liveBoundaryAt ? Date.parse(liveBoundaryAt) : Number.NaN;
  return items.filter((item) => {
    if (excludedIds.has(item.id)) return false;
    const value = observationTime(item);
    return value === undefined || Number.isNaN(boundary) || value < boundary;
  });
}
```

Deduplicate merged pages by ID while preserving first occurrence order. Make `liveBoundaryAt` and `excludedIds` optional inputs to `findOlderObservationPage`, and pass both into `historyItemsBefore` on every page.

- [ ] **Step 4: Remove the live-boundary bootstrap gate in the rail**

Keep refs for the moving boundary and current visible IDs:

```ts
const liveHistoryBoundaryRef = useRef(liveHistoryBoundaryAt);
liveHistoryBoundaryRef.current = liveHistoryBoundaryAt;
const liveHistoryIdsRef = useRef(new Set((observedAccessStream?.items ?? []).map((item) => item.id)));
liveHistoryIdsRef.current = new Set((observedAccessStream?.items ?? []).map((item) => item.id));
```

Allow `loadHistoryPage` without a boundary and pass `excludedIds: liveHistoryIdsRef.current`. Keep delivery exclusion in `observationHistoryLoadScope`.

- [ ] **Step 5: Run atom history tests and verify GREEN**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/observation-history.test.ts --only-failures
```

Expected: all history helper tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/atoms/src/workspace-experiences/chat-room/utils/observation-history.ts packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx packages/atoms/test/unit/observation-history.test.ts
git commit -m "fix(workplace): bootstrap timestamp-less agent history"
```

### Task 3: Prefer an observable sibling runtime

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/agent-rail-model.ts:21-56`
- Test: `packages/atoms/test/unit/workspace-project-rail.test.ts:555-625`

**Interfaces:**
- Consumes: `ExternalAgentStreamView.items`, `status`, and `observedAt`.
- Produces: unchanged `agentObservationStream(observation, streams): ExternalAgentStreamView | undefined` contract with observable fallback ranking.

- [ ] **Step 1: Write the failing selection test**

Construct a newer empty stopped stream and an older stopped stream with one assistant event. Assert member-level selection chooses the observable stream while explicit ID selection remains pinned:

```ts
expect(agentObservationStream({ agentId: 'pmem_codex_one' }, streams)?.id).toBe('exa_observable');
expect(agentObservationStream({ externalAgentSessionId: 'exa_new_empty' }, streams)?.id).toBe('exa_new_empty');
```

- [ ] **Step 2: Run the rail test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/workspace-project-rail.test.ts --only-failures
```

Expected: member-level selection returns `exa_new_empty`.

- [ ] **Step 3: Implement observable sibling ranking**

Preserve the explicit-ID path and running priority. Add an observable fallback before the newest-any fallback:

```ts
const matches = streams.filter(matchesAgent);
return (
  newestStream(matches.filter((stream) => stream.status === 'running')) ??
  newestStream(matches.filter((stream) => stream.items.length > 0)) ??
  newestStream(matches)
);
```

- [ ] **Step 4: Run the rail test and verify GREEN**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/workspace-project-rail.test.ts --only-failures
```

Expected: all rail tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/atoms/src/workspace-experiences/chat-room/utils/agent-rail-model.ts packages/atoms/test/unit/workspace-project-rail.test.ts
git commit -m "fix(workplace): prefer observable agent runtimes"
```

### Task 4: Integrated verification

**Files:**
- Verify all files modified in Tasks 1-3.

**Interfaces:**
- Consumes the completed daemon fallback, history helpers, rail integration, and runtime selector.
- Produces a branch ready for review; no new code contract.

- [ ] **Step 1: Run focused regression suites**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/external-agent-host.test.ts packages/atoms/test/unit/observation-history.test.ts packages/atoms/test/unit/workspace-project-rail.test.ts --only-failures
```

Expected: zero failures.

- [ ] **Step 2: Regenerate web routes required by the current branch baseline**

```bash
bun run generate:routes
```

Do not stage generated output unless it differs from the committed repository after generation.

- [ ] **Step 3: Run repository quality gates**

```bash
bun run lint
bun run typecheck
bun run test
```

Expected: zero failures. If an unrelated baseline failure remains, report its exact command and error separately from changed-path verification.

- [ ] **Step 4: Audit the diff and test assertions**

```bash
git diff --check
git status --short
git diff --stat HEAD~3..HEAD
```

Confirm no unrelated generated files, hard-coded user-facing strings, weak presence-only assertions, or dependency changes are included.
