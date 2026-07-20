# Managed Instruction Delivery Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver managed immutable instructions through provider-native channels exactly where supported, atomically deliver the first mutable turn, and make valid native-session resume invisible to project users.

**Architecture:** Replace provider-shaped launcher fields with one SDK-owned `immutableInstructions` value bundled with `initialTurn`. The host starts and delivers that turn as one awaited operation. Each adapter maps immutable instructions to its own native facility; generic daemon code never concatenates prompts. Explicit member join remains a mutable join greeting, while ordinary native resume receives only its triggering project notice.

**Tech Stack:** TypeScript, Bun, Zod, built-in MeshAgent adapters, Bun test.

---

### Task 1: Lock the provider-neutral startup contract with failing tests

**Files:**
- Modify: `packages/atoms/test/unit/mesh-agent-session-event-adapters.test.ts`
- Modify: `apps/monad/test/unit/mesh-agent-session-event-runtime.test.ts`
- Modify: `apps/monad/test/unit/managed-mesh-agent-start-race.test.ts`

- [ ] Add exact adapter assertions that Codex uses `developer_instructions` only on new-session launch and always keeps stdin mutable-only; Claude/Qwen use their native append facilities; Gemini uses additive managed context without `GEMINI_SYSTEM_MD`.
- [ ] Add an executor test proving `open(initialTurn)` does not resolve until the initial turn completes and a later `input` stays mutable-only.
- [ ] Add a managed runtime test proving one `meshAgentHost.start` call receives immutable instructions and initial input together, including recovery after a failed native resume.
- [ ] Run `bun run scripts/bun-test.ts packages/atoms/test/unit/mesh-agent-session-event-adapters.test.ts apps/monad/test/unit/mesh-agent-session-event-runtime.test.ts apps/monad/test/unit/managed-mesh-agent-start-race.test.ts --only-failures` and confirm failures are contract mismatches, not fixture errors.

### Task 2: Introduce atomic immutable-plus-initial startup

**Files:**
- Modify: `packages/sdk-atom/src/agent-adapter.ts`
- Modify: `apps/monad/src/services/mesh-agent/host/session-event-runtime-launcher.ts`
- Modify: `apps/monad/src/services/mesh-agent/session-event-runtime/executor.ts`
- Modify: `apps/monad/src/services/mesh-agent/host/index.ts`
- Modify: `apps/monad/src/handlers/session/handlers/managed-mesh-agent-runtime.ts`

- [ ] Add `MeshAgentImmutableInstructions` and `MeshAgentSessionStartInput` to the SDK context; remove `systemPromptFile` and `developerInstructions`.
- [ ] Pass the managed prompt text/file and initial turn into `createSessionRuntime` before adapter construction.
- [ ] Let the executor deliver `initialTurn` during `open` for resident and per-turn definitions and await its completion.
- [ ] Change managed start and cold-start recovery to one `meshAgentHost.start` call; retain normal `input` only for later messages.
- [ ] Run the Task 1 focused tests and make the host/executor contract green.

### Task 3: Map immutable instructions inside Codex, Claude, Gemini, and Qwen adapters

**Files:**
- Modify: `packages/atoms/src/agent-adapters/codex/session-runtime.ts`
- Modify: `packages/atoms/src/agent-adapters/claude-code/index.ts`
- Modify: `packages/atoms/src/agent-adapters/gemini/index.ts`
- Modify: `packages/atoms/src/agent-adapters/qwen/index.ts`
- Modify: `packages/atoms/src/agent-adapters/legacy/runtime.ts`

- [ ] Encode Codex immutable text as a TOML-safe `developer_instructions` config override only for a new native session; never concatenate it into stdin.
- [ ] Read Claude and Qwen native append values from `immutableInstructions.file`/`text` inside their adapters.
- [ ] Expose Gemini immutable instructions as additive managed `GEMINI.md` context through its included managed workspace and remove `GEMINI_SYSTEM_MD` replacement.
- [ ] Remove obsolete adapter capability flags used by the generic launcher.
- [ ] Run the Task 1 focused tests and make all provider mappings green.

### Task 4: Remove ephemeral/startup behavior from immutable content

**Files:**
- Modify: `packages/protocol/src/mesh-agent/mesh-agent-runtime-spec.ts`
- Modify: `apps/monad/src/services/mesh-agent/managed-project.ts`
- Modify: `apps/monad/src/services/mesh-agent/prompts/managed-project-runtime-mcp.prompt.md`
- Modify: `apps/monad/src/services/mesh-agent/prompts/managed-project-runtime.prompt.md`
- Modify: `apps/monad/test/unit/mesh-agent-managed-project.test.ts`

- [ ] Remove `meshSessionId` from immutable prompt input while retaining `MONAD_MESH_SESSION_ID` as runtime binding data.
- [ ] Remove the unconditional startup join instruction; the explicit join greeting remains the sole join trigger.
- [ ] Assert the rendered immutable prompt contains stable identity and bridge rules but no ephemeral Mesh id or unconditional join behavior.
- [ ] Run `bun run scripts/bun-test.ts apps/monad/test/unit/mesh-agent-managed-project.test.ts --only-failures`.

### Task 5: Keep ownership lifecycle engineering events out of the transcript

**Files:**
- Modify: `apps/monad/src/handlers/session/ui-projection-tool-events.ts`
- Modify: `apps/monad/test/unit/sessions/ui-projection.test.ts`
- Modify: `packages/atoms/test/unit/workspace-project-messages.test.ts`

- [ ] Add failing projection assertions that `mesh.idle_suspended` and `mesh.idle_resumed` produce no user-visible messages.
- [ ] Remove transcript projection for those engineering events while preserving event compatibility for existing stored data.
- [ ] Run the two focused projection test files.

### Task 6: Verify the full affected surface

**Files:**
- Test: all files above plus managed delivery, forwarding, protocol, SDK boundaries.

- [ ] Run focused tests for adapters, executor, managed start/recovery, managed prompt, UI projection, protocol, and SDK.
- [ ] Run `bun run lint` once and collect all failures.
- [ ] Run `bun run typecheck` once and collect all failures.
- [ ] Run `bun run test` once and collect all failures.
- [ ] Review the final diff for provider leakage, weak assertions, user-visible lifecycle copy, and unrelated changes.
- [ ] Commit the implementation with a scoped message.
