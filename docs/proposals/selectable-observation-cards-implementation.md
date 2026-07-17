# Selectable Observation Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every projected observation card selectable across its header, timestamp, body, and expanded raw JSON.

**Architecture:** Use the existing global `[data-selectable="true"]` contract at the shared `RawInspectableCard` root. This keeps selection behavior centralized while existing descendant buttons retain their interaction semantics.

**Tech Stack:** React 19, TypeScript, Tailwind CSS utilities, Bun test, server-rendered component tests.

## Global Constraints

- Do not change collapse, raw disclosure, or copy behavior.
- Do not affect ordinary chat messages.
- Add no new CSS or dependency.

---

### Task 1: Expose the selectable card contract

**Files:**
- Modify: `packages/ui/src/components/RawInspectableCard.tsx:60-68`
- Test: `packages/ui/test/unit/chat-cards.test.tsx:42-76`

**Interfaces:**
- Consumes: the existing global `[data-selectable="true"]` style contract.
- Produces: a `RawInspectableCard` root with `data-selectable="true"` whenever raw records wrap a projected card.

- [ ] **Step 1: Write the failing test**

Add this assertion to the controlled open/closed card test:

```tsx
// presence-ok: selectable is the shared projected-card DOM contract.
expect(closed).toContain('data-selectable="true"');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `bun scripts/bun-test.ts packages/ui/test/unit/chat-cards.test.tsx --only-failures`.

Expected: the controlled `RawInspectableCard` test fails because the root lacks `data-selectable="true"`.

- [ ] **Step 3: Add the shared selectable attribute**

Update the root wrapper:

```tsx
<div
  className={cn(
    'group/raw-card relative text-card-foreground data-[open=true]:[&>[data-slot]:first-of-type]:rounded-b-none',
    className
  )}
  data-open={open}
  data-selectable="true"
  data-slot="raw-inspectable-card"
>
```

- [ ] **Step 4: Verify GREEN and package quality gates**

Run:

```sh
bun scripts/bun-test.ts packages/ui/test/unit/chat-cards.test.tsx --only-failures
bun run --cwd packages/ui lint
bun run --cwd packages/ui typecheck
bun run check:test-assertions
```

Expected: all commands exit zero.

- [ ] **Step 5: Verify the complete UI test suite**

Run:

```sh
bun scripts/bun-test.ts packages/ui/test/ --only-failures
```

Expected: all UI tests pass with zero failures.
