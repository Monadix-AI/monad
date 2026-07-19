# MeshAgent Session Runtime Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the provider-neutral public state contracts and the internal discriminated session-event runtime authoring contracts without changing current MeshAgent behavior.

**Architecture:** `@monad/protocol` adds schema-first lifecycle, execution, connection, failure, capability, and turn-input contracts. `@monad/sdk-atom` adds a separate type-only runtime module whose resident/per-turn plans and drivers are discriminated unions; the existing launch-mode adapter API remains operational as a compatibility surface. Phase 2 will consume these contracts in the daemon executor.

**Tech Stack:** Bun, TypeScript, Zod 4, Bun test, Biome, repository TypeScript project references.

## Global Constraints

- Work directly on `main` as explicitly requested; do not create a worktree.
- Preserve all pre-existing staged and unstaged changes and use path-limited commits.
- Keep the change additive: do not remove launch modes, transports, resize, or existing adapter methods in Phase 1.
- `@monad/protocol` remains schema-first and depends only on Zod.
- Runtime plans remain internal SDK/daemon contracts and must not appear in Mesh session wire schemas.
- PTY is not a valid `SessionEventRuntimePlan` channel.
- Adapters cannot choose network hosts, ports, Unix paths, or executable paths.
- Untrusted turn content is delivered only through stdin or argv values after an explicit `--` separator.
- Tests assert exact contract shapes; no weak existence-only assertions.
- Use Bun-only commands and quiet test entry points.

---

### Task 1: Add provider-neutral session state contracts

**Files:**
- Create: `packages/protocol/src/mesh-agent/mesh-session-runtime.ts`
- Modify: `packages/protocol/src/mesh-agent/index.ts`
- Test: `packages/protocol/test/mesh-session-runtime.test.ts`

**Interfaces:**
- Consumes: `messageAttachmentRefSchema` from `mesh-agent-attachments.ts`.
- Produces: `MeshSessionLifecycle`, `MeshExecutionActivity`, `MeshConnectionCondition`, `MeshAgentRuntimeCapabilities`, `MeshAgentRuntimeFailure`, and `MeshAgentTurnInput`, with matching Zod schemas.

- [x] **Step 1: Write exact failing schema tests**

Create `packages/protocol/test/mesh-session-runtime.test.ts` with fixtures for all discriminants. Assert full parsed values for `active + idle`, `terminal + failed`, `reconnecting`, exact capabilities, and a text-plus-attachment turn. Assert that idle rejects nonzero `queuedTurnCount`, running rejects a null PID, and turn input rejects more than `NATIVE_AGENT_ATTACHMENTS_MAX` attachments.

```ts
import { expect, test } from 'bun:test';
import {
  meshAgentRuntimeCapabilitiesSchema,
  meshAgentTurnInputSchema,
  meshConnectionConditionSchema,
  meshExecutionActivitySchema,
  meshSessionLifecycleSchema
} from '../src/index.ts';

test('session runtime schemas preserve the exact active idle contract', () => {
  expect(meshSessionLifecycleSchema.parse({ state: 'active' })).toEqual({ state: 'active' });
  expect(meshExecutionActivitySchema.parse({ state: 'idle', pid: null, queuedTurnCount: 0 })).toEqual({
    state: 'idle',
    pid: null,
    queuedTurnCount: 0
  });
});

test('session runtime schemas preserve terminal failure and reconnect detail', () => {
  expect(
    meshSessionLifecycleSchema.parse({
      state: 'terminal',
      termination: {
        kind: 'failed',
        at: '2026-07-19T00:00:00.000Z',
        exitCode: 2,
        error: { code: 'provider_protocol_error', message: 'invalid frame', retryable: false }
      }
    })
  ).toEqual({
    state: 'terminal',
    termination: {
      kind: 'failed',
      at: '2026-07-19T00:00:00.000Z',
      exitCode: 2,
      error: { code: 'provider_protocol_error', message: 'invalid frame', retryable: false }
    }
  });
  expect(
    meshConnectionConditionSchema.parse({
      state: 'reconnecting',
      attempt: 2,
      nextAttemptAt: '2026-07-19T00:00:01.000Z'
    })
  ).toEqual({ state: 'reconnecting', attempt: 2, nextAttemptAt: '2026-07-19T00:00:01.000Z' });
});
```

- [x] **Step 2: Run the focused test and verify the missing exports fail**

Run: `bun scripts/bun-test.ts packages/protocol/test/mesh-session-runtime.test.ts --only-failures`

Expected: FAIL because the new schemas are not exported.

- [x] **Step 3: Implement the schema-first runtime state module**

Create discriminated unions with these exact shapes:

```ts
export const meshAgentRuntimeFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean()
});

export const meshSessionLifecycleSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('starting') }),
  z.object({ state: z.literal('active') }),
  z.object({
    state: z.literal('terminal'),
    termination: z.object({
      kind: z.enum(['exited', 'stopped', 'failed']),
      at: z.string(),
      exitCode: z.number().int().nullable().optional(),
      error: meshAgentRuntimeFailureSchema.optional()
    })
  })
]);

export const meshExecutionActivitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle'), pid: z.null(), queuedTurnCount: z.literal(0) }),
  z.object({
    state: z.literal('starting'),
    pid: z.number().int().positive().nullable(),
    queuedTurnCount: z.number().int().nonnegative()
  }),
  z.object({
    state: z.literal('running'),
    pid: z.number().int().positive(),
    queuedTurnCount: z.number().int().nonnegative()
  }),
  z.object({
    state: z.literal('suspended'),
    pid: z.null(),
    suspendedAt: z.string(),
    queuedTurnCount: z.number().int().nonnegative()
  })
]);
```

Add `meshConnectionConditionSchema`, `meshAgentRuntimeCapabilitiesSchema`, and `meshAgentTurnInputSchema`. Define turn attachments by reusing `messageAttachmentRefSchema`; do not redeclare its fields. Export every schema and inferred type from `packages/protocol/src/mesh-agent/index.ts`.

- [x] **Step 4: Run focused protocol tests**

Run: `bun scripts/bun-test.ts packages/protocol/test/mesh-session-runtime.test.ts --only-failures`

Expected: PASS.

- [x] **Step 5: Run protocol typecheck**

Run: `bun run --cwd packages/protocol typecheck`

Expected: exit 0.

- [x] **Step 6: Commit only Task 1 paths**

```bash
git add -f packages/protocol/src/mesh-agent/mesh-session-runtime.ts packages/protocol/test/mesh-session-runtime.test.ts
git add packages/protocol/src/mesh-agent/index.ts
git commit --only packages/protocol/src/mesh-agent/mesh-session-runtime.ts packages/protocol/src/mesh-agent/index.ts packages/protocol/test/mesh-session-runtime.test.ts -m "feat(protocol): add mesh session runtime contracts"
```

### Task 2: Add discriminated SDK runtime plans and drivers

**Files:**
- Create: `packages/sdk-atom/src/mesh-agent-session-runtime.ts`
- Modify: `packages/sdk-atom/src/index.ts`
- Modify: `packages/sdk-atom/package.json`
- Test: `packages/sdk-atom/test/unit/mesh-agent-session-runtime.test.ts`

**Interfaces:**
- Consumes: `MeshAgentRuntimeCapabilities`, `MeshAgentTurnInput`, and `MeshAgentRuntimeFailure` from `@monad/protocol`.
- Produces: `SessionEventRuntimeDefinition`, `ResidentSessionEventPlan`, `PerTurnSessionEventPlan`, `MeshAgentProviderDriver`, and all packet/channel/control support types.

- [x] **Step 1: Write compile-time contract fixtures**

Create a Bun test that constructs one resident definition and one per-turn definition with `satisfies SessionEventRuntimeDefinition`, then asserts their exact discriminants at runtime. Add `@ts-expect-error` fixtures proving resident drivers require `attachChannel` and `sendTurn`, per-turn drivers require `attachTurnChannel` and `completeTurn`, and a channel plan cannot carry `host`, `port`, or `path`.

```ts
test('runtime definitions preserve their process-model discriminants', () => {
  expect([resident.plan.processModel, perTurn.plan.processModel]).toEqual(['resident', 'per-turn']);
  expect([resident.driver.processModel, perTurn.driver.processModel]).toEqual(['resident', 'per-turn']);
});
```

- [x] **Step 2: Run the focused SDK test and verify the missing module fails**

Run: `bun scripts/bun-test.ts packages/sdk-atom/test/unit/mesh-agent-session-runtime.test.ts --only-failures`

Expected: FAIL because the new runtime types are not exported.

- [x] **Step 3: Implement the type-only runtime module**

Define these exact boundaries in `mesh-agent-session-runtime.ts`:

```ts
export type SessionEventChannelPlan =
  | { kind: 'child-stdio' }
  | { kind: 'websocket'; endpoint: 'daemon-loopback' }
  | { kind: 'unix-socket'; endpoint: 'daemon-runtime' };

export interface MeshAgentProcessLaunchPlan {
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
}

export type EncodedTurnInput =
  | { delivery: 'stdin'; bytes: Uint8Array }
  | { delivery: 'argv-tail'; separator: '--'; values: readonly string[] };

export interface ResidentSessionEventPlan {
  processModel: 'resident';
  launch: MeshAgentProcessLaunchPlan;
  channel: SessionEventChannelPlan;
  startup: StartupPolicy;
  reconnect?: ReconnectPolicy;
  suspend?: SuspendPolicy;
}

export interface PerTurnSessionEventPlan {
  processModel: 'per-turn';
  buildTurnLaunch(context: { providerSessionRef?: string }): MeshAgentProcessLaunchPlan;
  encodeTurnInput(input: MeshAgentTurnInput): EncodedTurnInput;
  startup: StartupPolicy;
  continuation: { strategy: 'provider-session-ref' };
}
```

Define `ProviderDriverBase.accept(packet, sink): Promise<void>` with an awaitable `MeshAgentEventSink.emit(event): Promise<void>`. Define required resident/per-turn driver methods and non-optional control slots using `false | { method }`. `DriverReady.providerSessionRef` is optional. Include a `provider_session_identified` driver event whose payload is `{ providerSessionRef: string }`. Keep protocol method names and request correlation out of all types.

Export the module from the package root and add `./mesh-agent-session-runtime` to `package.json` exports.

- [x] **Step 4: Run focused SDK tests and typecheck**

Run: `bun scripts/bun-test.ts packages/sdk-atom/test/unit/mesh-agent-session-runtime.test.ts --only-failures`

Expected: PASS.

Run: `bun run --cwd packages/sdk-atom typecheck`

Expected: exit 0, including all `@ts-expect-error` checks.

- [x] **Step 5: Commit only Task 2 paths**

```bash
git add -f packages/sdk-atom/src/mesh-agent-session-runtime.ts packages/sdk-atom/test/unit/mesh-agent-session-runtime.test.ts
git add packages/sdk-atom/src/index.ts packages/sdk-atom/package.json
git commit --only packages/sdk-atom/src/mesh-agent-session-runtime.ts packages/sdk-atom/src/index.ts packages/sdk-atom/package.json packages/sdk-atom/test/unit/mesh-agent-session-runtime.test.ts -m "feat(sdk): add mesh session event runtime contract"
```

### Task 3: Add the compatibility adapter factory hook

**Files:**
- Modify: `packages/sdk-atom/src/agent-adapter.ts`
- Modify: `packages/sdk-atom/src/index.ts`
- Test: `packages/sdk-atom/test/unit/agent-adapter.test.ts`

**Interfaces:**
- Consumes: `SessionEventRuntimeDefinition` from Task 2.
- Produces: optional `MeshAgentProviderAdapter.createSessionRuntime(agent, context)` for phased provider migration.

- [x] **Step 1: Add a compile-time adapter fixture using the new hook**

Add a fixture to `agent-adapter.test.ts` whose `createSessionRuntime` returns a valid per-turn definition. Assert the factory is invoked with the exact provider session reference and working path. Existing adapter fixtures must remain unchanged and continue compiling without the hook.

- [x] **Step 2: Run typecheck and verify the missing hook fails**

Run: `bun run --cwd packages/sdk-atom typecheck`

Expected: FAIL because `createSessionRuntime` is not part of `MeshAgentProviderAdapter`.

- [x] **Step 3: Add the optional additive hook**

Add these types without changing `buildLaunch` or existing methods:

```ts
export interface MeshAgentSessionRuntimeContext {
  workingPath: string;
  providerSessionRef?: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
}

export interface MeshAgentProviderAdapter {
  createSessionRuntime?(
    agent: MeshAgentView,
    context: MeshAgentSessionRuntimeContext
  ): SessionEventRuntimeDefinition;
}
```

Import the runtime definition as a type-only dependency. Export `MeshAgentSessionRuntimeContext` from the package root. Do not wire the daemon to this hook in Phase 1.

- [x] **Step 4: Run SDK unit tests and typecheck**

Run: `bun scripts/bun-test.ts packages/sdk-atom/test/unit/ --only-failures`

Expected: PASS.

Run: `bun run --cwd packages/sdk-atom typecheck`

Expected: exit 0.

- [x] **Step 5: Commit only Task 3 paths**

```bash
git add packages/sdk-atom/src/agent-adapter.ts packages/sdk-atom/src/index.ts packages/sdk-atom/test/unit/agent-adapter.test.ts
git commit --only packages/sdk-atom/src/agent-adapter.ts packages/sdk-atom/src/index.ts packages/sdk-atom/test/unit/agent-adapter.test.ts -m "feat(sdk): add mesh runtime factory hook"
```

### Task 4: Verify additive integration and freeze Phase 1

**Files:**
- Modify only if verification exposes a Phase 1 defect in the files from Tasks 1-3.

**Interfaces:**
- Consumes: all Phase 1 contracts.
- Produces: a passing additive contract baseline for Phase 2.

- [x] **Step 1: Run complete applicable test scopes once**

Run: `bun scripts/bun-test.ts packages/protocol/test/ packages/sdk-atom/test/ --only-failures`

Expected: PASS. Collect every failure before editing if it does not pass.

- [x] **Step 2: Run complete applicable static gates once**

Run: `bun run --cwd packages/protocol typecheck && bun run --cwd packages/sdk-atom typecheck && bun run check:test-assertions`

Expected: exit 0.

- [x] **Step 3: Verify no public topology leakage was added**

Run:

```bash
rg -n "SessionEventRuntimePlan|processModel|child-stdio|daemon-loopback|daemon-runtime" packages/protocol/src
```

Expected: no matches. Runtime-plan vocabulary belongs only to `@monad/sdk-atom` and later daemon internals.

- [x] **Step 4: Audit the diff and dirty-tree boundary**

Run:

```bash
git diff HEAD~3 -- packages/protocol/src/mesh-agent/mesh-session-runtime.ts packages/protocol/src/mesh-agent/index.ts packages/protocol/test/mesh-session-runtime.test.ts packages/sdk-atom/src/mesh-agent-session-runtime.ts packages/sdk-atom/src/agent-adapter.ts packages/sdk-atom/src/index.ts packages/sdk-atom/package.json packages/sdk-atom/test/unit/mesh-agent-session-runtime.test.ts packages/sdk-atom/test/unit/agent-adapter.test.ts
git status --short
```

Expected: the scoped diff contains only Phase 1 contracts/tests; all unrelated pre-existing WIP remains present and uncommitted by these tasks.

- [x] **Step 5: Record Phase 1 completion**

Update this plan's checkboxes and report the exact test commands and results. Do not claim the full migration complete: Phase 2 generic executor, provider conversions, state/UI cutover, compatibility release, and deletion remain separate plans.

## Completion record

- `bun scripts/bun-test.ts packages/protocol/test/ packages/sdk-atom/test/ --only-failures`: 214 passed, 0 failed.
- `bun run --cwd packages/protocol typecheck`: passed.
- `bun run --cwd packages/sdk-atom typecheck`: passed.
- `bun run check:test-assertions`: passed with no weak assertions.
- `bun run test`: 18 package tasks passed.
- `bun run typecheck`: 18 package tasks passed.
- `bun run lint`: passed across 2590 files with no fixes applied.
- Protocol topology leakage check: no runtime-plan or channel discriminant vocabulary found.
