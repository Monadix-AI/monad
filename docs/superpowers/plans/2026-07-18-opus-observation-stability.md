# Opus Observation Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Opus observation rows stable while paging history, preserve each thinking card's Raw JSON, and eliminate false `Needs login` states from ordinary transcript content.

**Architecture:** The observation timeline will derive React and Virtuoso identity from the neutral event's stable `dedupeKey`, falling back to `id`, and tool groups will key from their stable tail. Presence detection will parse neutral observation semantics and only accept authentication text from system, unknown, or terminal events.

**Tech Stack:** TypeScript, React, React Virtuoso, Bun test, Monad neutral observation events.

## Global Constraints

- Keep provider vocabulary inside adapters and consume neutral observation events in the experience layer.
- Do not remount the list, remove virtualization, add provider-specific UI branches, or migrate persisted data.
- Use Bun-only commands and `scripts/bun-test.ts ... --only-failures` for targeted tests.
- New assertions must verify exact user-visible contracts rather than existence alone.

---

### Task 1: Stable observation timeline identity

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline.tsx`
- Test: `packages/atoms/test/unit/external-agent-observation.test.ts`

**Interfaces:**
- Consumes: `ObservationItem.dedupeKey?: string`, `ObservationItem.id: string`, and `ObservationTimelineEntry.id`.
- Produces: `observationItemIdentity(item: ObservationItem): string`; stable entry ids for individual observations, tool pairs, and prepended tool groups.

- [ ] **Step 1: Write the failing tests for repeated thinking ids and raw ownership**

Import `ObservationTimelineEntry` from the observation component types, then add a test that projects two completed thinking-token runs sharing the same provider id but carrying different dedupe keys and raw records:

```ts
import type { ObservationTimelineEntry } from '../../src/workspace-experiences/chat-room/components/observation/types.ts';
```

```ts
test('thinking timeline rows use dedupe identity and keep each run raw', () => {
  const firstRaw = [{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 25, uuid: 'think-a' }];
  const secondRaw = [{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 80, uuid: 'think-b' }];
  const entries = observationTimelineEntries(
    [
      {
        id: 'exa_claude:thinking-tokens',
        dedupeKey: 'claude-code:think-a:agent:thinking_tokens_delta',
        kind: 'reasoning',
        streaming: true,
        text: 'Thinking… · 25 tokens',
        raw: firstRaw
      },
      {
        id: 'exa_claude:thinking-tokens',
        dedupeKey: 'claude-code:think-b:agent:thinking_tokens_delta',
        kind: 'reasoning',
        streaming: true,
        text: 'Thinking… · 80 tokens',
        raw: secondRaw
      }
    ],
    'claude-code'
  );

  expect(entries.map(({ id, raw }) => ({ id, raw }))).toEqual([
    { id: 'claude-code:think-a:agent:thinking_tokens_delta', raw: firstRaw },
    { id: 'claude-code:think-b:agent:thinking_tokens_delta', raw: secondRaw }
  ]);
});
```

- [ ] **Step 2: Write the failing test for a stable prepended tool-group key**

Create an existing two-entry tool group, prepend an older adjacent tool entry, and compare the group id:

```ts
test('prepending adjacent tools preserves the existing tool group key', () => {
  const toolEntry = (id: string): ObservationTimelineEntry => ({
    id,
    kind: 'public',
    card: {
      type: 'command-tool',
      view: {
        command: id,
        commandLanguage: 'shell',
        provider: 'claude-code',
        status: 'completed',
        type: 'Bash'
      }
    },
    raw: { id }
  });
  const current = observationTimelineRows([toolEntry('call-newer'), toolEntry('call-latest')]);
  const prepended = observationTimelineRows([
    toolEntry('call-oldest'),
    toolEntry('call-newer'),
    toolEntry('call-latest')
  ]);

  expect({ current: current[0]?.id, prepended: prepended[0]?.id }).toEqual({
    current: 'tool-group:call-latest',
    prepended: 'tool-group:call-latest'
  });
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
```

Expected: FAIL because both thinking entries use `exa_claude:thinking-tokens`, and the current group key changes from `tool-group:call-newer` to `tool-group:call-oldest`.

- [ ] **Step 4: Implement stable item and group identities**

Add and use a single identity helper in `timeline.tsx`:

```ts
export function observationItemIdentity(item: ObservationItem): string {
  return item.dedupeKey ?? item.id;
}
```

Use `observationItemIdentity(item)` for individual entry ids, combine the call and result identities for tool-pair ids, and derive multi-tool row ids from the final entry:

```ts
const itemId = observationItemIdentity(item);
const nextId = observationItemIdentity(next);
id: `${itemId}:pair:${nextId}`;

const last = toolEntries.at(-1);
rows.push({ id: `tool-group:${last?.id ?? entry.id}`, entries: toolEntries });
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
```

Expected: all tests in the file pass with zero failures.

- [ ] **Step 6: Commit stable timeline identity**

```bash
git add packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline.tsx packages/atoms/test/unit/external-agent-observation.test.ts
git commit -m "fix(chat): stabilize observation timeline identity"
```

### Task 2: Semantic authentication presence

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/experience/external-agent-presence.ts`
- Test: `packages/atoms/test/unit/workspace-project-messages.test.ts`

**Interfaces:**
- Consumes: `externalAgentStreamItems({ id, provider, output })` and neutral event kinds.
- Produces: `externalAgentOutputNeedsLogin(args: { id: string; output?: string; provider?: string }): boolean` used by both live-tool and stored-session presence paths.

- [ ] **Step 1: Write the failing false-positive regression test**

Model the actual Claude tool-result shape containing harmless `sign in` text:

```ts
test('external agent presence ignores login phrases inside Claude tool results', () => {
  const session = externalAgentSession({
    agentName: 'pmem_claude',
    provider: 'claude-code',
    state: 'stopped',
    outputSnapshot: JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: "installHint: 'Install OpenClaw, then sign in with openclaw models auth login.'"
          }
        ]
      }
    })
  });

  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'pmem_claude',
      enabled: true,
      externalAgentSessions: [session],
      liveTools: []
    })
  ).toBe('online');
});
```

- [ ] **Step 2: Write the genuine authentication regression test**

Verify a structured provider system event remains visible as `needs-login`:

```ts
test('external agent presence keeps structured authentication failures', () => {
  const session = externalAgentSession({
    agentName: 'pmem_claude',
    provider: 'claude-code',
    state: 'stopped',
    outputSnapshot: JSON.stringify({
      type: 'system',
      subtype: 'connection_required',
      error: 'Please sign in'
    })
  });

  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'pmem_claude',
      enabled: true,
      externalAgentSessions: [session],
      liveTools: []
    })
  ).toBe('needs-login');
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/workspace-project-messages.test.ts --only-failures
```

Expected: the false-positive test fails with `expected "online", received "needs-login"`; the genuine authentication test remains green.

- [ ] **Step 4: Implement semantic login detection**

Add a helper that parses neutral events and scans newest-first. It accepts authentication phrases only from system, unknown, or terminal events and treats later substantive provider activity as evidence that an older login signal is stale:

```ts
function externalAgentOutputNeedsLogin(args: { id: string; output?: string; provider?: string }): boolean {
  if (!args.output) return false;
  const items = externalAgentStreamItems({ id: args.id, provider: args.provider, output: args.output });
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === 'system' || item.kind === 'unknown' || item.kind === 'turn-end') {
      if (hasExternalAgentLoginNeed(item.text)) return true;
      continue;
    }
    if (
      item.kind === 'assistant-message' ||
      item.kind === 'tool-call' ||
      item.kind === 'tool-result' ||
      item.kind === 'user-message'
    ) {
      return false;
    }
  }
  return false;
}
```

Replace both direct snapshot checks with this helper, passing the actual tool/session id and provider.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/workspace-project-messages.test.ts --only-failures
```

Expected: all tests in the file pass with zero failures.

- [ ] **Step 6: Commit semantic authentication presence**

```bash
git add packages/atoms/src/workspace-experiences/experience/external-agent-presence.ts packages/atoms/test/unit/workspace-project-messages.test.ts
git commit -m "fix(workplace): derive external agent login presence"
```

### Task 3: Integrated verification and merge readiness

**Files:**
- Verify: `packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline.tsx`
- Verify: `packages/atoms/src/workspace-experiences/experience/external-agent-presence.ts`
- Verify: `packages/atoms/test/unit/external-agent-observation.test.ts`
- Verify: `packages/atoms/test/unit/workspace-project-messages.test.ts`

**Interfaces:**
- Consumes: the stable timeline identity and semantic presence behavior from Tasks 1 and 2.
- Produces: a reviewed, merge-ready branch with no weak assertions or unrelated changes.

- [ ] **Step 1: Run the combined changed-path test scope**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-observation.test.ts packages/atoms/test/unit/workspace-project-messages.test.ts --only-failures
```

Expected: zero failures.

- [ ] **Step 2: Check assertion quality and changed files**

```bash
bun run check:test-assertions
git diff --check
git status --short
```

Expected: no weak assertions, no whitespace errors, and only planned files changed.

- [ ] **Step 3: Run merge gates**

```bash
bun run lint
bun run typecheck
bun run test
```

Expected: all three commands exit zero. If `agents:check` reports the known generated Rulesync drift, report it separately and do not modify generated instruction files as part of this fix.

- [ ] **Step 4: Verify the branch is ready for integration**

```bash
git log --oneline main..HEAD
git diff --stat main...HEAD
git status --short --branch
```

Expected: the design commit and two focused fix commits are present, the diff is scoped to the design, plan, two production files, and two test files, and the worktree is clean.
