# Chat Virtual List Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chat history anchoring and jump-to-latest reliable, and render exactly one latest-value Claude thinking card per model generation.

**Architecture:** Keep React Virtuoso and strengthen the shared `VirtualList` with an explicit bottom-scroll request state and a stable keyed viewport anchor. Make the runtime event source honor the provider-owned streaming-run merge hook so both observation projection paths share Claude's latest-value semantics.

**Tech Stack:** Bun, TypeScript, React 19, React Virtuoso 4.18.11, Bun test.

## Global Constraints

- Work directly on `main` as requested earlier in this task.
- Preserve the user's existing staged changes in `packages/atoms/src/workspace-experiences/chat-room/utils/projection.ts` and `packages/atoms/test/unit/workspace-project-messages.test.ts`; never stage or commit them with this work.
- Use Bun commands only.
- Keep message persistence, sorting, pagination contracts, and agent loop semantics unchanged.
- A thinking card is scoped to one model generation, not one whole agent turn.
- Prefer a smooth jump to latest, but finish automatically at the true bottom when virtual measurement makes the smooth target stale.
- Add failing regression tests before each production change.

## File Map

- `packages/atoms/src/agent-adapters/event-source.ts`: merge complete consecutive streaming runs and delegate provider-specific merge semantics.
- `packages/atoms/test/unit/external-agent-event-source-conformance.test.ts`: runtime-path latest-value and model-generation-boundary regressions.
- `packages/ui/src/components/VirtualList.tsx`: bottom request reducer, Virtuoso last-index scrolling, keyed row anchors, and scroll/height-change coordination.
- `apps/web/test/unit/virtual-list.test.ts`: pure state and anchor compensation regressions.
- `packages/atoms/src/workspace-experiences/chat-room/components/message-list.tsx`: no behavior rewrite expected; verify its existing jump button and stable `messageRenderKey` integration against the strengthened shared list.

---

### Task 1: Honor latest-value thinking merges on the runtime event path

**Files:**
- Modify: `packages/atoms/src/agent-adapters/event-source.ts:152-178`
- Test: `packages/atoms/test/unit/external-agent-event-source-conformance.test.ts`

**Interfaces:**
- Consumes: `ExternalAgentObservationProjector.mergeStreamingRun?(events)` and `isStreamingFragment?(event)`.
- Produces: `mergeStreamingEvents(provider, projection, events)` that applies `mergeStreamingRun` once to each complete consecutive run and retains append semantics otherwise.

- [ ] **Step 1: Write failing runtime-path tests**

Append tests that use the real Claude adapter event source:

```ts
test('Claude event source keeps only the latest cumulative thinking token estimate', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter?.events) throw new Error('Claude event source is required');
  const records = [1, 17, 33, 1120].map((estimatedTokens, index) => ({
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: estimatedTokens,
    estimated_tokens_delta: index === 0 ? estimatedTokens : estimatedTokens - [0, 1, 17, 33][index]!,
    uuid: `thinking_${index}`,
    session_id: 'claude_session'
  }));

  expect(adapter.events.projectLive({
    id: 'exa_claude000000',
    output: records.map((record) => JSON.stringify(record)).join('\n')
  }).events).toMatchObject([{
    id: 'exa_claude000000:thinking-tokens',
    providerEventType: 'thinking_tokens_delta',
    text: 'Thinking… · 1120 tokens',
    raw: records
  }]);
});

test('Claude event source starts a new thinking card after a tool boundary', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter?.events) throw new Error('Claude event source is required');
  const output = [
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 25 },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 80 },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }] } },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 31 },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 150 }
  ].map((record) => JSON.stringify(record)).join('\n');

  expect(adapter.events.projectLive({ id: 'exa_claude000000', output }).events.map((event) => ({
    type: event.providerEventType,
    text: event.text
  }))).toEqual([
    { type: 'thinking_tokens_delta', text: 'Thinking… · 80 tokens' },
    { type: 'tool_use', text: 'Tool call Bash {"command":"pwd"}' },
    { type: 'thinking_tokens_delta', text: 'Thinking… · 150 tokens' }
  ]);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts --only-failures
```

Expected: the first test receives concatenated `Thinking…` labels; the boundary test also exposes concatenation inside each run.

- [ ] **Step 3: Merge complete streaming runs**

Replace pairwise folding with run settlement:

```ts
function mergeStreamingEvents(
  provider: ExternalAgentProvider,
  projection: ExternalAgentObservationProjector,
  events: ExternalAgentObservationEvent[]
): ExternalAgentObservationEvent[] {
  const merged: ExternalAgentObservationEvent[] = [];
  let run: ExternalAgentObservationEvent[] = [];
  const settle = () => {
    if (run.length === 0) return;
    const first = run[0]!;
    const custom = run.length > 1 ? projection.mergeStreamingRun?.(run) : undefined;
    const next = custom ?? {
      ...first,
      text: run.map((event) => event.text).join(''),
      raw: run.length === 1 ? first.raw : run.map((event) => event.raw)
    };
    merged.push({ ...compactEvent(next), dedupeKey: eventDedupeKey(provider, next) });
    run = [];
  };

  for (const event of events) {
    const first = run[0];
    const sameRun =
      first &&
      projection.isStreamingFragment?.(first) &&
      projection.isStreamingFragment(event) &&
      first.role === event.role &&
      first.source === event.source &&
      first.providerEventType === event.providerEventType;
    if (!projection.isStreamingFragment?.(event) || (first && !sameRun)) settle();
    if (projection.isStreamingFragment?.(event)) run.push(event);
    else merged.push(event);
  }
  settle();
  return merged;
}
```

Preserve the existing compact/dedupe behavior. If the exact tool text differs from the fixture, tighten the expected value to the real adapter contract rather than weakening the assertion.

- [ ] **Step 4: Run focused observation tests and verify GREEN**

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts packages/atoms/test/unit/external-agent-observation.test.ts --only-failures
```

Expected: all tests pass; append-style reasoning delta coverage remains green.

- [ ] **Step 5: Commit only Task 1 files**

```bash
git add packages/atoms/src/agent-adapters/event-source.ts packages/atoms/test/unit/external-agent-event-source-conformance.test.ts
git commit -m "fix(chat): merge runtime thinking token updates"
```

### Task 2: Make jump-to-latest converge on the true virtual bottom

**Files:**
- Modify: `packages/ui/src/components/VirtualList.tsx:85-105, 137-201, 224-270, 374-396`
- Test: `apps/web/test/unit/virtual-list.test.ts`

**Interfaces:**
- Produces: `BottomScrollRequest`, `BottomScrollEvent`, and `reduceBottomScrollRequest(state, event)`.
- Runtime behavior: `scrollToBottom` arms a request; height changes issue an automatic correction; `atBottom=true` or an upward user scroll ends it.

- [ ] **Step 1: Write failing bottom request reducer tests**

```ts
import {
  initialBottomScrollRequest,
  reduceBottomScrollRequest
} from '@monad/ui/components/VirtualList';

test('bottom request smooth-scrolls first and auto-corrects after virtual height changes', () => {
  const requested = reduceBottomScrollRequest(initialBottomScrollRequest, { type: 'request', behavior: 'smooth' });
  expect(requested).toEqual({ active: true, behavior: 'smooth' });
  expect(reduceBottomScrollRequest(requested, { type: 'height-changed' })).toEqual({
    active: true,
    behavior: 'auto'
  });
});

test('bottom request completes only at the true bottom and cancels on upward user scroll', () => {
  const requested = reduceBottomScrollRequest(initialBottomScrollRequest, { type: 'request', behavior: 'smooth' });
  expect(reduceBottomScrollRequest(requested, { type: 'at-bottom' })).toEqual(initialBottomScrollRequest);
  expect(reduceBottomScrollRequest(requested, { type: 'user-scroll-up' })).toEqual(initialBottomScrollRequest);
});
```

- [ ] **Step 2: Run the virtual-list test and verify RED**

```bash
bun scripts/bun-test.ts apps/web/test/unit/virtual-list.test.ts --only-failures
```

Expected: import/export failure for the missing reducer.

- [ ] **Step 3: Add the reducer and Virtuoso last-index coordinator**

Add the pure state contract:

```ts
export type BottomScrollRequest = { active: boolean; behavior: 'auto' | 'smooth' };
export type BottomScrollEvent =
  | { type: 'request'; behavior: 'auto' | 'smooth' }
  | { type: 'height-changed' | 'settle-timeout' | 'at-bottom' | 'user-scroll-up' };

export const initialBottomScrollRequest: BottomScrollRequest = { active: false, behavior: 'auto' };

export function reduceBottomScrollRequest(
  state: BottomScrollRequest,
  event: BottomScrollEvent
): BottomScrollRequest {
  if (event.type === 'request') return { active: true, behavior: event.behavior };
  if ((event.type === 'height-changed' || event.type === 'settle-timeout') && state.active) {
    return { active: true, behavior: 'auto' };
  }
  if (event.type === 'at-bottom' || event.type === 'user-scroll-up') return initialBottomScrollRequest;
  return state;
}
```

In `VirtualList`, keep the request in a ref and route scrolling through Virtuoso:

```ts
const bottomRequestRef = useRef<BottomScrollRequest>(initialBottomScrollRequest);

const scrollToLast = useCallback((behavior: 'auto' | 'smooth') => {
  selfScrollRef.current = true;
  handleRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior });
}, []);

const handleAtBottomChange = useCallback((nextAtBottom: boolean) => {
  if (nextAtBottom) {
    bottomRequestRef.current = reduceBottomScrollRequest(bottomRequestRef.current, { type: 'at-bottom' });
  }
  onAtBottomChange?.(nextAtBottom);
}, [onAtBottomChange]);
```

`scrollToBottom` must set `pinnedRef.current = true`, clear `userScrolledRef`, arm the reducer, and call `scrollToLast`. While a request is active, downward programmatic scroll events must not unpin it; a detected upward scroll cancels it. In `totalListHeightChanged`, reduce with `height-changed` and call `scrollToLast('auto')` before normal pinned handling. Start one 600 ms settle timer for a smooth request; if it is still active, reduce with `settle-timeout` and issue one final `scrollToLast('auto')`. Clear the timer on `atBottom`, cancellation, a new request, and unmount. Wire `handleAtBottomChange` to `atBottomStateChange`.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
bun scripts/bun-test.ts apps/web/test/unit/virtual-list.test.ts packages/atoms/test/unit/workspace-experience-runtime.test.ts --only-failures
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit only Task 2 files**

```bash
git add packages/ui/src/components/VirtualList.tsx apps/web/test/unit/virtual-list.test.ts
git commit -m "fix(ui): make virtual list bottom scrolling reliable"
```

### Task 3: Preserve a keyed viewport anchor while reading history

**Files:**
- Modify: `packages/ui/src/components/VirtualList.tsx:58-68, 137-234, 374-396`
- Test: `apps/web/test/unit/virtual-list.test.ts`

**Interfaces:**
- Produces: `ViewportAnchor { key: string; top: number }` and `anchoredScrollTop(scrollTop, anchor, current)`.
- Render contract: each item gets `data-virtual-list-item-key=<getKey(item)>`.

- [ ] **Step 1: Write failing keyed-anchor tests**

```ts
import { anchoredScrollTop } from '@monad/ui/components/VirtualList';

test('keyed viewport anchor compensates an insertion or height growth above it', () => {
  const anchor = { key: 'message-20', top: 80 };
  expect(anchoredScrollTop(640, anchor, { key: 'message-20', top: 200 })).toBe(760);
});

test('keyed viewport anchor ignores unrelated rows and unchanged offsets', () => {
  const anchor = { key: 'message-20', top: 80 };
  expect(anchoredScrollTop(640, anchor, { key: 'message-21', top: 200 })).toBe(640);
  expect(anchoredScrollTop(640, anchor, { key: 'message-20', top: 80 })).toBe(640);
});
```

- [ ] **Step 2: Run the virtual-list test and verify RED**

```bash
bun scripts/bun-test.ts apps/web/test/unit/virtual-list.test.ts --only-failures
```

Expected: import/export failure for `anchoredScrollTop`.

- [ ] **Step 3: Implement stable-key anchoring**

Add the pure helper:

```ts
export interface ViewportAnchor { key: string; top: number }

export function anchoredScrollTop(
  scrollTop: number,
  anchor: ViewportAnchor,
  current: ViewportAnchor
): number {
  return anchor.key === current.key ? scrollTop + current.top - anchor.top : scrollTop;
}
```

Wrap each rendered item in a stable marker:

```tsx
itemContent={(_index, item) => (
  <div data-virtual-list-item-key={getKey(item)}>{renderItem(item)}</div>
)}
```

Maintain `viewportAnchorRef`. After a genuine user scroll while unpinned, find the first marker whose bounding rectangle crosses the scroller's top edge and store its key and top relative to the scroller. On data changes and `totalListHeightChanged`, find the same marker, calculate `anchoredScrollTop`, set `selfScrollRef`, and compensate `scrollTop`. Run one additional animation-frame correction for delayed measurements. Preserve anchors before the early return for an unpinned user; the current order returns before any preservation can happen.

Clear the anchor when pinning or requesting the bottom. If the key disappears, capture the next visible row without moving the viewport.

- [ ] **Step 4: Verify chat integration remains keyed by `renderKey`**

Confirm `ChatMessageList` still passes `messageRenderKey` to `getKey`; do not change its message ordering or the user's staged projection files.

Run:

```bash
bun scripts/bun-test.ts apps/web/test/unit/virtual-list.test.ts packages/atoms/test/unit/workspace-experience-runtime.test.ts packages/atoms/test/unit/workspace-chat-message-outline.test.ts --only-failures
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit only Task 3 files**

```bash
git add packages/ui/src/components/VirtualList.tsx apps/web/test/unit/virtual-list.test.ts
git commit -m "fix(ui): preserve virtual chat history anchors"
```

### Task 4: Full verification and runtime QA

**Files:**
- No planned production changes.
- Inspect: all files changed by Tasks 1-3.

**Interfaces:**
- Verifies the combined behavior without expanding scope.

- [ ] **Step 1: Run formatting and static checks once**

```bash
bun run lint
bun run typecheck
```

Expected: both commands exit 0. If either reports multiple failures, collect the full batch before editing.

- [ ] **Step 2: Run the full test suite once**

```bash
bun run test
```

Expected: all Turbo test tasks pass.

- [ ] **Step 3: Run the web app and perform browser QA**

Start the existing Bun/Vite development command from the repository instructions. In a long chat:

1. Scroll upward until the jump button appears.
2. Allow new messages and growing cards to arrive; confirm the same visible message stays at the same pixel offset.
3. Click jump-to-latest; confirm the motion is smooth when possible and always settles at the true bottom above the composer.
4. Observe one Claude model generation with many `thinking_tokens`; confirm one card shows only the latest total.
5. Observe a tool call followed by another model generation; confirm a second thinking card is created.

If the available dev runtime or authenticated project data cannot reproduce these live conditions, record that limitation and rely on the focused deterministic regressions plus full gates; do not fabricate runtime success.

- [ ] **Step 4: Audit scope and repository state**

```bash
git diff HEAD~3 --check
git status --short
```

Confirm the user's pre-existing staged projection changes remain present and were not included in any task commit.

- [ ] **Step 5: Final handoff**

Report the three implementation commits, focused/full verification results, runtime QA result, and the preserved unrelated staged files. Do not create a cleanup commit unless verification required an actual code change.
