# Member Resume Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep active project-session rosters consistent, preserve immutable historical author names, and bootstrap provider history immediately after member wake/resume.

**Architecture:** The daemon reconciles template-bound rows whenever project templates change and shares removal primitives with explicit session-member APIs. Managed messages carry a stable author ID plus display-name snapshot through persistence, events, and UI projection. Live observation frames use their epoch as a safe bootstrap scope before a provider checkpoint exists.

**Tech Stack:** Bun, TypeScript, Zod, SQLite/Drizzle, React atoms, Bun test.

## Global Constraints

- Reconcile only active, non-archived sessions.
- Never remove ad-hoc session members whose `templateId` is null.
- Never rewrite historical `agentName`; `agentDisplayName` is additive and immutable.
- Verify daemon behavior over TCP loopback and Unix socket.
- Preserve existing managed-runtime start deduplication.

---

### Task 1: Historical author snapshots

**Files:**
- Modify: `packages/protocol/src/ui.ts`
- Modify: `packages/protocol/src/event-table.ts`
- Modify: `apps/monad/src/handlers/session/ui-projection-helpers.ts`
- Modify: `apps/monad/src/handlers/session/ui-projection-message-events.ts`
- Modify: `apps/monad/src/handlers/session/ui-projection.ts`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/projection.ts`
- Modify: `apps/monad/src/handlers/session/handlers/managed-external-agent-messages.ts`
- Test: `apps/monad/test/unit/sessions/ui-projection.test.ts`
- Test: `packages/atoms/test/unit/message-projection.test.ts`

**Interfaces:**
- Produces optional `agentDisplayName: string` on `AgentMessagePayload` and `UIMessageItem`.
- Managed message data becomes `{ agentName, agentDisplayName, ... }`.

- [ ] **Step 1: Write failing tests** that project both identity fields from stored data and live events, and prove `messageToView` keeps `authorId: 'pmem_fable'` while choosing `authorName: 'Fable'` over a current metadata-map value of `Opus`.
- [ ] **Step 2: Verify RED** with `bun scripts/bun-test.ts apps/monad/test/unit/sessions/ui-projection.test.ts packages/atoms/test/unit/message-projection.test.ts --only-failures`; expect failure because the field is absent.
- [ ] **Step 3: Implement the contract** by adding `agentDisplayName: z.string().optional()` beside `agentName`, parsing it from message data, retaining it across token/message updates, and using `item.agentDisplayName ?? metadataName ?? rawName` in chat projection.
- [ ] **Step 4: Persist the snapshot** when a managed thinking row is created; carry the same value into completion and `agent.token` / `agent.message` events without changing `agentName`.
- [ ] **Step 5: Verify GREEN** with the Step 2 command; expect all focused tests to pass.
- [ ] **Step 6: Commit** with `git commit -m "fix(session): preserve managed message authors"`.

### Task 2: Shared removal and legacy snapshot backfill

**Files:**
- Modify: `apps/monad/src/store/db/messages.ts`
- Modify: `apps/monad/src/store/db/index.ts`
- Create: `apps/monad/src/handlers/session/handlers/session-member-roster.ts`
- Modify: `apps/monad/src/handlers/session/handlers/session-members.ts`
- Test: `apps/monad/test/unit/store/messages.test.ts`
- Test: `apps/monad/test/unit/sessions/session-members-handlers.test.ts`

**Interfaces:**
- Produces `Store.snapshotAgentDisplayName(sessionId, agentName, agentDisplayName): number`.
- Produces a shared member removal helper that snapshots, stops, and deletes in that order.

- [ ] **Step 1: Write failing tests** with a legacy Fable message, a bound `exa_fable` runtime, and a pre-snapshotted control message. Assert the legacy data becomes exactly `{ agentName: fableId, agentDisplayName: 'Fable', source: 'managed-external-agent' }`, the control snapshot is unchanged, `stop('exa_fable')` runs once, and the member row is deleted.
- [ ] **Step 2: Verify RED** with `bun scripts/bun-test.ts apps/monad/test/unit/store/messages.test.ts apps/monad/test/unit/sessions/session-members-handlers.test.ts --only-failures`; expect failure because no backfill exists.
- [ ] **Step 3: Implement additive backfill** for assistant messages in one session whose JSON `agentName` matches and whose `agentDisplayName` is absent; update only message JSON data and return the changed-row count.
- [ ] **Step 4: Implement shared removal** deriving `displayName ?? name`, calling backfill, stopping a linked runtime if present, and deleting the member. Route explicit removal through it.
- [ ] **Step 5: Verify GREEN** with the Step 2 command; expect all focused tests to pass.
- [ ] **Step 6: Commit** with `git commit -m "fix(session): snapshot authors before member removal"`.

### Task 3: Active project-session roster reconciliation

**Files:**
- Modify: `apps/monad/src/handlers/session/handlers/session-member-roster.ts`
- Modify: `apps/monad/src/handlers/session/handlers/lifecycle/lifecycle-projects.ts`
- Modify: `apps/monad/src/handlers/session/handlers/lifecycle/index.ts`
- Test: `apps/monad/test/unit/sessions/project-member-reconciliation.test.ts`

**Interfaces:**
- Consumes the shared removal helper and existing `spawnManagedSessionMember`.
- Produces `reconcileProjectSessionMembers(project): Promise<void>`.

- [ ] **Step 1: Write failing tests** with active, completed, archived, and ad-hoc fixtures. Update `[GPT, Fable]` to `[GPT edited, Opus]`; assert the active template-bound roster equals GPT edited plus Opus, ad-hoc stays, inactive rosters are unchanged, Fable is stopped/backfilled, and Opus spawns once. Repeat the update and assert no duplicate spawn.
- [ ] **Step 2: Verify RED** with `bun scripts/bun-test.ts apps/monad/test/unit/sessions/project-member-reconciliation.test.ts --only-failures`; expect failure because project update does not reconcile sessions.
- [ ] **Step 3: Implement reconciliation** using `store.listSessions({ projectId, state: 'active', archived: false })`, comparing only non-null `templateId` rows, updating retained row data, removing absent rows through Task 2, inserting missing rows, spawning them, and persisting a returned runtime ID.
- [ ] **Step 4: Wire project updates** so `createProjectLifecycleHandlers` awaits reconciliation only when `memberTemplates !== undefined`, after the project row update succeeds.
- [ ] **Step 5: Verify GREEN** with the Step 2 command plus `bun scripts/bun-test.ts apps/monad/test/unit/sessions/session-members-handlers.test.ts --only-failures`.
- [ ] **Step 6: Commit** with `git commit -m "fix(project): reconcile active session members"`.

### Task 4: Wake/resume history bootstrap

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/observation-history.ts`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx`
- Test: `packages/atoms/test/unit/observation-history.test.ts`

**Interfaces:**
- Produces epoch-only live scope `externalAgentSessionId:observationEpoch:bootstrap`.

- [ ] **Step 1: Write a failing test** expecting `observationHistoryLoadScope({ externalAgentSessionId: 'exa_resumed', observationState: 'live', observationEpoch: 'epoch-2' })` to equal `exa_resumed:epoch-2:bootstrap`; retain the missing-epoch and checkpoint-specific cases.
- [ ] **Step 2: Verify RED** with `bun scripts/bun-test.ts packages/atoms/test/unit/observation-history.test.ts --only-failures`; expect `received undefined`.
- [ ] **Step 3: Implement bootstrap** by returning the epoch `bootstrap` scope without a checkpoint and loosening the rail guard from checkpoint-required to epoch-required. Pass undefined checkpoint into `findOlderObservationPage` so it loads the first page and uses existing deduplication.
- [ ] **Step 4: Verify GREEN** with the Step 2 command; expect all tests to pass.
- [ ] **Step 5: Commit** with `git commit -m "fix(external-agent): bootstrap resumed history"`.

### Task 5: Transport parity and quality gates

**Files:**
- Modify: `apps/monad/test/e2e/project-sessions.test.ts`
- Modify: `apps/monad/test/unit/transports/transport-matrix-write-paths.unix.test.ts`

**Interfaces:**
- Exercises project update and session-member list endpoints over both transports.

- [ ] **Step 1: Add exact TCP and Unix cases** that create a session with Fable, update the project to Opus, and compare the complete member-list response to the expected Opus contract.
- [ ] **Step 2: Run transport tests** with `bun scripts/bun-test.ts apps/monad/test/e2e/project-sessions.test.ts apps/monad/test/unit/transports/transport-matrix-write-paths.unix.test.ts --only-failures`; expect pass on both transports.
- [ ] **Step 3: Run touched scopes** with `bun scripts/bun-test.ts apps/monad/test/unit/sessions apps/monad/test/unit/store packages/atoms/test/unit/observation-history.test.ts --only-failures`.
- [ ] **Step 4: Run repository gates** once each with `bun run lint`, `bun run typecheck`, and `bun run test`; collect unrelated baseline failures separately if any.
- [ ] **Step 5: Commit transport tests** with `git commit -m "test(project): cover member reconciliation transports"`.

### Task 6: Merge, deploy, and target-session repair

**Files:**
- Create runtime backup under `/Users/zeke/.monad/backup/member-resume-consistency-<timestamp>/monad.sqlite`.

**Interfaces:**
- Consumes deployed remove/invite session-member APIs.
- Produces target roster GPT plus Opus and `msg_yZF8ijIQJbaN.agentDisplayName === 'Fable'`.

- [ ] **Step 1: Update against main and repeat merge gates** (`bun run lint`, `bun run typecheck`, `bun run test`) before merging.
- [ ] **Step 2: Merge and deploy** with the repository's existing local workflow; verify port 52749 serves the merged build before data mutation.
- [ ] **Step 3: Back up SQLite** to a timestamped directory and require `PRAGMA integrity_check` to return `ok`.
- [ ] **Step 4: Repair only `ses_heN3EUtBUB8x`** by removing `pmem_claude-code_6c9b3c101028` through the deployed API and inviting template `pmem_claude-code_f2654d392ff2`; never update historical `agentName` directly.
- [ ] **Step 5: Verify acceptance**: members are GPT and Opus; Fable has no running managed runtime; `msg_yZF8ijIQJbaN` retains Fable's member ID and snapshot `Fable`; a new Opus runtime uses Opus's member ID; epoch-only resumed history returns a non-empty first page.
- [ ] **Step 6: Run post-merge main gates** and remove only this task's fully merged worktree/branch after enumerating worktrees and confirming the backup path.
