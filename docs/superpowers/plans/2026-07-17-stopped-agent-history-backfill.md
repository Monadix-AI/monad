# Stopped Agent History Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover provider history for stopped external-agent members when their bounded snapshot projects no events, while preserving live checkpoint reconciliation.

**Architecture:** The daemon will treat a stopped snapshot as authoritative only when it projects observable events, then reuse the existing CLI/local provider fallback. The atom history helper will distinguish live checkpoint loading from stopped bootstrap loading and will deduplicate merged events by provider identity or stable event ID.

**Tech Stack:** Bun, TypeScript, React hooks, RTK Query, `bun:test`.

## Global Constraints

- Do not rewrite already persisted snapshots.
- Do not combine multiple external-agent runtimes into one transcript.
- Do not change runtime selection, lifecycle, fanout, or delivery observation behavior.
- Preserve provider and stored-snapshot cursor contracts.
- Keep live checkpoint reconciliation unchanged.
- Add no dependencies, environment variables, user-facing strings, or provider payload logs.

---

### Task 1: Recover provider history behind an unobservable snapshot

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/observation-resolve.ts`
- Test: `apps/monad/test/unit/external-agent-host.test.ts`

**Interfaces:**
- Consumes: `ExternalAgentObservationResolver.observe(id)` and the existing CLI/local provider-history helpers.
- Produces: `observeWithProviderHistory(id)` that accepts stored history only when it contains projected events.

- [ ] **Step 1: Write a failing invalid-snapshot regression test**

Change the existing Codex persisted-pointer fixture to store a non-empty invalid snapshot and assert the provider event text exactly:

```ts
outputSnapshot: 'truncated provider frame without parseable JSON\n'

const observation = await host.observeWithProviderHistory(externalAgentSessionId);
expect(observation).toMatchObject({
  state: 'history',
  externalAgentSessionId,
  provider: 'codex',
  events: [expect.objectContaining({ text: 'restored from provider history' })]
});
```

- [ ] **Step 2: Add a parseable-snapshot precedence regression test**

Persist a valid Codex observation record containing `snapshot remains authoritative`; configure `agents` to increment a counter if provider CLI fallback is attempted. Assert the exact returned message and `providerAttempts === 0`.

- [ ] **Step 3: Run the daemon test and verify RED**

Run:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/external-agent-host.test.ts --only-failures
```

Expected: the invalid-snapshot test fails because the resolver returns `events: []` from the non-empty snapshot.

- [ ] **Step 4: Implement observable-history fallback**

Add a private projection helper that returns `null` when provider output is empty or projects zero events:

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

Update resolution order:

```ts
const base = this.observe(id);
if (base.state === 'live' || (base.state === 'history' && (base.events?.length ?? 0) > 0)) return base;
// validate managed runtime + providerSessionRef
// try CLI projection, then local projection, then return base
```

- [ ] **Step 5: Run the daemon test and verify GREEN**

Run the same focused daemon command. Expected: zero failures.

---

### Task 2: Bootstrap stopped history while preserving live checkpoints

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/observation-history.ts`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx`
- Test: `packages/atoms/test/unit/observation-history.test.ts`

**Interfaces:**
- Produces: `observationHistoryLoadScope({ deliveryId?, externalAgentSessionId?, observationState?, observationEpoch?, providerHistoryCheckpoint? })`.
- Produces: `findOlderObservationPage({ before?, checkpoint?, load })` where missing checkpoint loads the first canonical page once.
- Preserves: live checkpoint scanning and cursor-cycle protection.

- [ ] **Step 1: Write failing stopped-bootstrap helper tests**

Extend the load-scope table:

```ts
observationHistoryLoadScope({
  externalAgentSessionId: 'exa_stopped',
  observationState: 'history'
})
```

Expected value: `exa_stopped:history`. Add an async case asserting a missing checkpoint calls `load(undefined)` once and returns that page.

- [ ] **Step 2: Write a failing stable-ID deduplication test**

Change the existing repeated-ID test expectation to:

```ts
expect(result.map((item) => item.id)).toEqual(['oldest', 'same-render-id', 'live']);
```

Provider-identity replacement remains authoritative when render IDs differ.

- [ ] **Step 3: Run atom helper tests and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/observation-history.test.ts --only-failures
```

Expected: stopped scope is undefined, checkpoint-less loading returns no items, and the duplicate render ID remains.

- [ ] **Step 4: Implement stopped scope, bootstrap, and deduplication**

Use this scope rule:

```ts
if (args.deliveryId || !args.externalAgentSessionId) return undefined;
if (args.observationState === 'history') return `${args.externalAgentSessionId}:history`;
if (!args.observationEpoch || !args.providerHistoryCheckpoint) return undefined;
return `${args.externalAgentSessionId}:${args.observationEpoch}:${args.providerHistoryCheckpoint}`;
```

For checkpoint-less initial loading, return `args.load(undefined)`. Deduplicate current items when either their provider identity or stable event ID already exists in the canonical page.

- [ ] **Step 5: Wire observation state into the rail**

Pass `uiFrame?.state` into `observationHistoryLoadScope`. Permit `loadHistoryPage` without a checkpoint only when `uiFrame.state === 'history'`; keep the current live guard. Pass the optional checkpoint to `findOlderObservationPage`.

- [ ] **Step 6: Run atom helper tests and verify GREEN**

Run the same focused atom command. Expected: zero failures.

---

### Task 3: Verify recurrence prevention and integrated behavior

**Files:**
- Verify: `apps/monad/src/services/external-agent/host/output-pipeline.ts`
- Verify: `apps/monad/test/unit/external-agent-history-cursor.test.ts`
- Verify all files modified in Tasks 1-2.

**Interfaces:**
- Confirms app-server control responses continue resolving requests without entering the observation snapshot.
- Confirms daemon HTTP history behavior remains transport-independent.

- [ ] **Step 1: Run the focused regression batch**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/external-agent-host.test.ts apps/monad/test/unit/external-agent-history-cursor.test.ts packages/atoms/test/unit/observation-history.test.ts --only-failures
```

Expected: zero failures.

- [ ] **Step 2: Run applicable daemon transport tests**

```bash
bun scripts/bun-test.ts apps/monad/test/e2e/native-agent-cli-bridge.test.ts --only-failures
```

Expected: TCP loopback and Unix-socket matrices pass.

- [ ] **Step 3: Run repository quality gates as one failure-collection pass**

```bash
bun run lint
bun run typecheck
bun run test
```

Record all failures before making any repair. If `MONAD_SUPERVISOR_PID` causes singleton-lock noise, rerun the full suite with that variable removed and report both results.

- [ ] **Step 4: Audit the final diff**

```bash
git diff --check
git status --short
```

Confirm the implementation adds no weak assertions, user-facing strings, dependencies, generated drift, or changes outside the confirmed scope.
