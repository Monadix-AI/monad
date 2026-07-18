# Codex MCP Startup Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify Codex MCP startup notifications as neutral unknown observations and render consecutive updates as one deduplicated `Startup progress` card in the chat experience.

**Architecture:** The Codex adapter preserves the raw provider notification while explicitly selecting unknown projection. A focused chat-experience module recognizes only Codex startup-status unknown events, folds consecutive updates by server name, and renders the resulting view model; the generic neutral observation contract remains unchanged.

**Tech Stack:** TypeScript, React, Bun test, Zod observation contracts, React Virtuoso chat observation timeline.

## Global Constraints

- `mcpServer/startupStatus/updated` is Codex-specific and must not add a neutral observation kind.
- Adapter output must become neutral `kind: "unknown"`, never `tool-call`.
- Only consecutive matching events form a group; any other observation splits groups.
- Each server keeps only its latest status while retaining first-seen server ordering.
- Raw JSON retains every notification, including superseded updates.
- Do not stage or edit unrelated main-worktree WIP.

---

### Task 1: Classify Codex startup notifications as unknown

**Files:**
- Modify: `packages/atoms/src/agent-adapters/observation-projection.ts`
- Modify: `packages/atoms/src/agent-adapters/codex/observation/observation-app-server-notification.ts`
- Test: `packages/atoms/test/unit/external-agent-observation.test.ts`

**Interfaces:**
- Consumes: `ExternalAgentObservationEvent.projection` from `@monad/protocol`.
- Produces: `observation(args)` accepting `projection?: "normalized" | "unknown"`; startup-status records use `projection: "unknown"` while retaining source, provider event type, text, and raw.

- [ ] **Step 1: Write the failing adapter regression test**

Add a test that parses the supplied notification and asserts the neutral event's exact relevant shape:

```ts
test('Codex MCP startup status stays unknown instead of becoming a tool call', () => {
  const output = JSON.stringify({
    method: 'mcpServer/startupStatus/updated',
    params: { threadId: 'thread_1', name: 'codex-security', status: 'ready', error: null }
  });

  expect(externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output })).toMatchObject([
    {
      kind: 'unknown',
      streaming: false,
      text: 'codex-security ready',
      raw: { method: 'mcpServer/startupStatus/updated' }
    }
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
```

Expected: FAIL because the event currently has `kind: "tool-call"`.

- [ ] **Step 3: Add explicit unknown projection support**

Extend the helper input and parsed event:

```ts
projection?: ExternalAgentObservationEvent['projection'];
```

```ts
projection: args.projection,
```

Then change the startup-status projection to use a system role and explicit unknown projection:

```ts
return observation({
  id: `${id}:json:${recordIndex}:mcp-status`,
  projection: 'unknown',
  role: 'system',
  text: error ? `${name} ${status}: ${error}` : `${name} ${status}`,
  source: 'codex-app-server',
  providerEventType: method,
  raw: record
});
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: PASS with zero failures.

- [ ] **Step 5: Commit the adapter boundary**

```bash
git add packages/atoms/src/agent-adapters/observation-projection.ts packages/atoms/src/agent-adapters/codex/observation/observation-app-server-notification.ts packages/atoms/test/unit/external-agent-observation.test.ts
git commit -m "fix(chat): keep codex startup status unknown"
```

### Task 2: Project and render startup progress in chat experience

**Files:**
- Create: `packages/atoms/src/workspace-experiences/chat-room/components/observation/codex-startup-progress.tsx`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/observation/types.ts`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline.tsx`
- Test: `packages/atoms/test/unit/external-agent-observation.test.ts`

**Interfaces:**
- Produces: `codexMcpStartupUpdate(item, provider): CodexMcpStartupUpdate | null`.
- Produces: `collapseCodexMcpStartupUpdates(updates): CodexMcpStartupUpdate[]`.
- Produces: `codexMcpStartupText(update): string`.
- Produces: `CodexMcpStartupProgressCard({ updates }): ReactElement`.
- Extends `PublicObservationCard` with `{ type: "codex-mcp-startup-progress"; updates: CodexMcpStartupUpdate[] }`.

- [ ] **Step 1: Write failing projection tests**

Build neutral unknown fixtures whose raw payloads contain startup notifications and assert:

```ts
expect(observationTimelineEntries(items, 'codex')).toMatchObject([
  {
    kind: 'public',
    card: {
      type: 'codex-mcp-startup-progress',
      updates: [
        { name: 'codex-security', status: 'ready' },
        { name: 'node_repl', status: 'ready' }
      ]
    },
    raw: [startingRaw, securityReadyRaw, nodeReadyRaw]
  }
]);
```

Add a second fixture with a non-startup message between updates and assert two startup-progress entries. Add exact assertions for provider gating, malformed raw, missing fields, and `codexMcpStartupText({ name: 'codex-security', status: 'failed', error: 'timeout' }) === 'MCP Server codex-security failed: timeout'`.

- [ ] **Step 2: Run the focused test and verify RED**

Run the Task 1 focused command. Expected: FAIL because the startup card type and projector do not exist.

- [ ] **Step 3: Implement the provider-specific view model**

Create the focused module with strict raw checks:

```ts
export type CodexMcpStartupUpdate = { name: string; status: string; error?: string };

export function codexMcpStartupUpdate(item: ObservationItem, provider: string): CodexMcpStartupUpdate | null {
  if (provider !== 'codex' || item.kind !== 'unknown') return null;
  const raw = recordValue(item.raw);
  if (raw?.method !== 'mcpServer/startupStatus/updated') return null;
  const params = recordValue(raw.params);
  if (!params) return null;
  return {
    name: textValue(params.name) ?? 'unknown',
    status: textValue(params.status) ?? 'updated',
    ...(textValue(params.error) ? { error: textValue(params.error) } : {})
  };
}
```

Fold updates with a `Map<string, number>` so replacement does not change first-seen ordering. Format rows with `MCP Server ${name} ${status}` and append `: ${error}` when present.

- [ ] **Step 4: Group consecutive entries in the timeline**

Before ordinary item projection, collect the maximal consecutive run recognized by `codexMcpStartupUpdate`. Store every run item's raw value, use the final item timestamp, and emit one public startup-progress card. Advance the loop index past the run.

- [ ] **Step 5: Render the startup progress card**

Render through `ObservationCardShell` with a compact `ObservationMeta` header titled `Startup progress`, `visualRole="system"`, and one text row per collapsed update. Keep raw expansion attached to the grouped entry.

- [ ] **Step 6: Run focused tests and static checks**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
bunx biome check packages/atoms/src/workspace-experiences/chat-room/components/observation/codex-startup-progress.tsx packages/atoms/src/workspace-experiences/chat-room/components/observation/types.ts packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline.tsx packages/atoms/test/unit/external-agent-observation.test.ts
bun run --cwd packages/atoms typecheck
```

Expected: all commands exit zero.

- [ ] **Step 7: Commit the chat experience behavior**

```bash
git add packages/atoms/src/workspace-experiences/chat-room/components/observation/codex-startup-progress.tsx packages/atoms/src/workspace-experiences/chat-room/components/observation/types.ts packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline.tsx packages/atoms/test/unit/external-agent-observation.test.ts
git commit -m "feat(chat): group codex startup progress"
```

### Task 3: Verify the complete feature

**Files:**
- Verify only; no planned source edits.

**Interfaces:**
- Consumes the completed adapter and chat-experience commits.
- Produces fresh repository gate evidence.

- [ ] **Step 1: Run focused regression tests**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-observation.test.ts packages/atoms/test/unit/workspace-project-messages.test.ts --only-failures
```

Expected: zero failures.

- [ ] **Step 2: Run full merge gates**

```bash
bun run lint
bun run typecheck
bun run test
```

Expected: all commands exit zero. If an unrelated baseline failure occurs, record the exact failure and keep it separate from focused changed-path results.

- [ ] **Step 3: Audit the final diff**

```bash
git diff --check HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors and no unrelated files in the feature commits.
