# Chat Card Tool Pair and Raw JSON Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render nested Claude Code `tool_use` and `tool_result` blocks as one tool card and syntax-highlight chat-card raw JSON.

**Architecture:** Normalize nested Claude tool blocks at the provider adapter boundary so the existing neutral classifier and adjacent timeline pairing receive correct event kinds. Reuse the shared Shiki-backed `CodeBlock` in `RawInspectableCard` without parsing or rewriting copied JSONL.

**Tech Stack:** TypeScript, React 19, Bun test, Shiki, Tailwind CSS.

## Global Constraints

- Work directly on `main` as explicitly requested.
- Keep provider-specific decoding inside the Claude Code adapter.
- Preserve exact raw record order and copy text.
- Do not add non-adjacent tool matching or change the tool-card structure.
- Write each production change only after its focused regression test fails for the expected reason.

---

### Task 1: Normalize nested Claude tool block types

**Files:**
- Modify: `packages/atoms/test/unit/external-agent-observation.test.ts`
- Modify: `packages/atoms/src/agent-adapters/claude-code/observation.ts:128-150`

**Interfaces:**
- Consumes: `externalAgentNeutralStreamItems({ id, provider, output }): AgentObservationEvent[]` and `observationTimelineEntries(items, provider): ObservationTimelineEntry[]`.
- Produces: nested Claude `tool_use` blocks classified as `tool-call` and nested `tool_result` blocks classified as `tool-result`.

- [ ] **Step 1: Write the failing end-to-end regression test**

Add this test near the existing Claude tool-card projection tests:

```ts
test('Claude Code observation pairs nested SDK tool result with its call', () => {
  const command = 'git status';
  const result = 'On branch main';
  const output = [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }]
      }
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: result }]
      }
    })
  ].join('\n');

  const items = externalAgentNeutralStreamItems({ id: 'exa_claude000000', provider: 'claude-code', output });
  expect(
    items.map((item) => ({
      kind: item.kind,
      name: item.kind === 'tool-call' || item.kind === 'tool-result' ? item.tool.name : undefined
    }))
  ).toEqual([
    { kind: 'tool-call', name: 'Bash' },
    { kind: 'tool-result', name: 'tool' }
  ]);

  const entries = observationTimelineEntries(items, 'claude-code');
  expect(entries.map((entry) => (entry.kind === 'public' ? entry.card.type : entry.kind))).toEqual(['command-tool']);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
```

Expected: FAIL because the second item is currently `{ kind: 'tool-call', name: 'tool' }` and the timeline produces two entries.

- [ ] **Step 3: Apply the minimal adapter fix**

In `claudeContentEvents`, change only the nested tool block event types:

```ts
if (item.type === 'tool_use') {
  const tool = textValue(item.name) ?? 'tool';
  const input = item.input;
  const inputText = input === undefined ? '' : ` ${typeof input === 'string' ? input : JSON.stringify(input)}`;
  return observation({
    id: `${args.id}:json:${args.recordIndex}:tool:${partIndex}`,
    role: 'tool',
    text: `Tool call ${tool}${inputText}`,
    source: 'claude-code-sdk',
    providerEventType: 'tool_use',
    createdAt: args.createdAt,
    raw: args.raw
  });
}
if (item.type === 'tool_result') {
  return observation({
    id: `${args.id}:json:${args.recordIndex}:tool-result:${partIndex}`,
    role: 'tool',
    text: textValue(item.content) ?? JSON.stringify(item.content ?? item),
    source: 'claude-code-sdk',
    providerEventType: 'tool_result',
    createdAt: args.createdAt,
    raw: args.raw
  });
}
```

Keep text, reasoning, timestamps, IDs, and raw records unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same `bun scripts/bun-test.ts ... --only-failures` command.

Expected: PASS with zero failures.

---

### Task 2: Syntax-highlight raw JSON without changing copied content

**Files:**
- Modify: `packages/ui/test/unit/chat-cards.test.tsx`
- Modify: `packages/ui/src/components/RawInspectableCard.tsx:1-129`

**Interfaces:**
- Consumes: `CodeBlock({ code, language: 'json' })` from `packages/ui/src/components/CodeBlock.tsx`.
- Preserves: `rawEventRecordsText(records): string` as the exact source for display and copy.

- [ ] **Step 1: Strengthen the open-card regression test**

In `RawInspectableCard renders ordered JSONL only while controlled open`, replace the contiguous raw `<code>` assertion with:

```ts
expect(open).toContain('data-language="json"');
expect(open).toContain('{&quot;type&quot;:&quot;call&quot;}');
expect(open).toContain('{&quot;type&quot;:&quot;result&quot;}');
```

Keep the existing `rawEventRecordsText preserves provider record order and exact text` test unchanged; it is the exact-copy contract.

- [ ] **Step 2: Run the focused UI test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/ui/test/unit/chat-cards.test.tsx --only-failures
```

Expected: FAIL because the expanded raw panel has no `data-language="json"` code renderer.

- [ ] **Step 3: Render the raw text with the shared CodeBlock**

Import `CodeBlock` and replace the raw `<pre><code>{text}</code></pre>` with:

```tsx
<CodeBlock
  className="max-h-64 overflow-auto border-0 bg-transparent [&_pre]:p-0 [&_pre]:text-[11px] [&_pre]:leading-relaxed"
  code={text}
  language="json"
/>
```

Do not parse or format `text`; the same exact value remains passed to `onCopy`.

- [ ] **Step 4: Run the focused UI test and verify GREEN**

Run the same UI test command.

Expected: PASS with zero failures.

---

### Task 3: Verify integrated behavior and quality gates

**Files:**
- Verify only: all files changed by Tasks 1 and 2.

**Interfaces:**
- Produces no new API; confirms the adapter-to-neutral-to-timeline flow and shared UI rendering remain valid.

- [ ] **Step 1: Run both affected package test scopes once**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-observation.test.ts packages/ui/test/unit/chat-cards.test.tsx --only-failures
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run affected package lint and typecheck**

```bash
bun run --cwd packages/atoms lint
bun run --cwd packages/atoms typecheck
bun run --cwd packages/ui lint
bun run --cwd packages/ui typecheck
```

Expected: all four commands exit 0.

- [ ] **Step 3: Audit the diff and assertion quality**

```bash
git diff --check
bun run check:test-assertions
git diff -- packages/atoms/src/agent-adapters/claude-code/observation.ts packages/atoms/test/unit/external-agent-observation.test.ts packages/ui/src/components/RawInspectableCard.tsx packages/ui/test/unit/chat-cards.test.tsx
```

Expected: no whitespace errors, no weak assertions, and only the scoped adapter, card, and regression-test changes.

- [ ] **Step 4: Commit the implementation**

```bash
git add packages/atoms/src/agent-adapters/claude-code/observation.ts packages/atoms/test/unit/external-agent-observation.test.ts packages/ui/src/components/RawInspectableCard.tsx packages/ui/test/unit/chat-cards.test.tsx
git commit -m "fix(chat): pair Claude tool results and highlight raw JSON"
```

Expected: commit hooks pass and the implementation commit is created on `main`.
