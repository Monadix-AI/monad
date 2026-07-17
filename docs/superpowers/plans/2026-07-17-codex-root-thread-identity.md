# Codex Root Thread Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Codex multi-agent v2 child thread status notifications from replacing the managed root thread used for fanout delivery.

**Architecture:** Pass the current runtime handle into Codex notification dispatch and make `thread/status/changed` identity-aware. The successful `thread/start` or `thread/resume` response remains the canonical identity source; status notifications only preserve that identity when their thread ID matches it.

**Tech Stack:** TypeScript, Bun test, Codex app-server JSON-RPC adapter.

## Global Constraints

- Do not match the provider error string or retry a failed delivery.
- Do not change non-Codex providers or non-app-server launch modes.
- Preserve stateless parser compatibility when no runtime handle is supplied.
- Use TDD and verify the focused adapter suite before repository quality gates.

---

### Task 1: Guard Codex root thread identity

**Files:**
- Modify: `apps/monad/test/unit/external-agent-adapters.test.ts`
- Modify: `packages/atoms/src/agent-adapters/codex/events.ts`

**Interfaces:**
- Consumes: `ExternalAgentRuntimeHandle.providerSessionRef` and Codex `thread/status/changed` notifications.
- Produces: `parseCodexServerNotification(record, handle)` behavior that emits `session_ref` only for the canonical root thread.

- [ ] **Step 1: Write the failing regression test**

Add a test that parses two status notifications with a handle whose `providerSessionRef` is `codex-root-thread`: one for `codex-child-thread`, then one for `codex-root-thread`. Assert the child result is `[]` and the root result is the exact existing `session_ref` payload.

```ts
test('Codex adapter keeps child status notifications from replacing the managed root thread', () => {
  const handle = {
    launchMode: 'app-server' as const,
    providerSessionRef: 'codex-root-thread',
    appServer: { send() {}, close() {} },
    kill() {}
  };

  const childEvents = codexExternalAgentAdapter.parseOutput(
    JSON.stringify({
      method: 'thread/status/changed',
      params: { threadId: 'codex-child-thread', status: { type: 'idle' } }
    }),
    handle
  );
  const rootEvents = codexExternalAgentAdapter.parseOutput(
    JSON.stringify({
      method: 'thread/status/changed',
      params: { threadId: 'codex-root-thread', status: { type: 'idle' } }
    }),
    handle
  );

  expect(childEvents).toEqual([]);
  expect(rootEvents).toEqual([
    {
      type: 'session_ref',
      payload: { providerSessionRef: 'codex-root-thread', status: { type: 'idle' } }
    }
  ]);
});
```

- [ ] **Step 2: Run RED**

Run:

```sh
bun scripts/bun-test.ts apps/monad/test/unit/external-agent-adapters.test.ts --only-failures
```

Expected: the new test fails because the child notification currently emits a `session_ref` for `codex-child-thread`.

- [ ] **Step 3: Implement the minimal identity guard**

Extend `CodexNotificationHandler` and notification dispatch to receive the optional runtime handle. For `thread/status/changed`, return no events when a handle has no established provider reference or when the notification thread differs from it; retain the existing stateless behavior when no handle is supplied.

```ts
type CodexNotificationHandler = (
  record: CodexJsonRpcNotification,
  params: Record<string, unknown>,
  handle?: ExternalAgentRuntimeHandle
) => ExternalAgentOutputEvent[];

'thread/status/changed': (_record, p, handle) =>
  typeof p.threadId === 'string' && (!handle || p.threadId === handle.providerSessionRef)
    ? [{ type: 'session_ref', payload: compactObject({ providerSessionRef: p.threadId, status: p.status }) }]
    : []
```

Pass `handle` through `dispatchCodexNotification`, `parseCodexServerNotification`, and the app-server parsing call site. Approval parsing remains handle-independent.

- [ ] **Step 4: Run GREEN and focused package checks**

Run:

```sh
bun scripts/bun-test.ts apps/monad/test/unit/external-agent-adapters.test.ts --only-failures
bun run --cwd packages/atoms typecheck
bun run --cwd apps/monad typecheck
git diff --check
```

Expected: adapter tests pass with zero failures, both typechecks exit 0, and `git diff --check` is clean.

- [ ] **Step 5: Commit implementation**

```sh
git add apps/monad/test/unit/external-agent-adapters.test.ts packages/atoms/src/agent-adapters/codex/events.ts docs/superpowers/plans/2026-07-17-codex-root-thread-identity.md
git commit -m "fix(external-agent): preserve Codex root thread identity"
```

### Task 2: Verify, merge, deploy, and repair the live member

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: committed root-thread identity guard and local Monad deployment commands.
- Produces: deployed daemon and a running GPT member bound to a fresh root Codex thread.

- [ ] **Step 1: Run repository gates**

```sh
bun run lint
bun run typecheck
bun run test
```

Expected: all commands exit 0.

- [ ] **Step 2: Merge the worktree branch into `main` and rerun the same gates on `main`**

Use a fast-forward merge after confirming both trees are clean. Expected: the implementation commit is an ancestor of `main`, and lint, typecheck, and test exit 0 on merged `main`.

- [ ] **Step 3: Deploy and restart the affected member**

Run `bun run deploy:local`, verify `https://127.0.0.1:52749/health` returns 200, then invite/start `pmem_codex_9552476e00d6` in `ses_heN3EUtBUB8x` through the deployed session-member API.

- [ ] **Step 4: Verify live acceptance**

Post one project message after the GPT member is running. Verify the resulting provider events contain an accepted root turn and do not contain `direct app-server input is not allowed for multi-agent v2 sub-agents`.

- [ ] **Step 5: Clean task-owned worktrees and branches**

Remove only the worktree and branch created for this task after confirming they are merged and clean.
