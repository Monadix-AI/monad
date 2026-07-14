# Third-party Kanban Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Power Pack Kanban as a third-party, three-stage project-work Experience with parallel project sessions and approval-safe autopilot.

**Architecture:** The Monad host adds only versioned, generic Experience primitives: authenticated API context, pack-private state, project-session/runtime operations, event delivery, and an ExperienceWorker. `@monad/monad-power-pack` owns Kanban task state, Proposal/acceptance semantics, scheduler, private API routes, and web component; it never adds a Kanban-specific host table, action, snapshot field, or renderer.

**Tech Stack:** TypeScript, Bun, SQLite/Drizzle, Elysia transport, Atom Pack SDK, `@monad/sdk-experience`, web components, Bun test.

## Global Constraints

- The only active Kanban lanes are exactly `requirements`, `execution`, and `acceptance`.
- One pack-owned project task owns exactly one host project session; a session may not appear on more than one active card.
- The host remains unaware of Proposal, execution iteration, acceptance, and Kanban task states.
- The pack uses `apiBaseUrl` and published SDK contracts; it cannot import web-host internals or add a host-component entry.
- High-risk tool approvals remain host-owned and are never bypassed.
- The scheduler must run when no Kanban component is mounted.
- All pack lifecycle writes use expected-version CAS and append a pack audit event atomically.
- Worker delivery is at-least-once. The pack stores processed host event ids in
  its private state and makes every transition idempotent.
- Generic host capabilities enforce ownership, permission, payload-size,
  pagination, and execution-time limits before invoking pack code.
- Existing V1 Experiences remain compatible. Keep `graphCanvas` unchanged.

## Plan audit decisions

- Split delivery into two independently reviewable gates. **Gate A** (Tasks 1–3)
  ships only reusable host/SDK capabilities and can be accepted without the
  Kanban product. **Gate B** (Tasks 4–7) ships only Power Pack business logic
  and UI against Gate A's public contracts.
- Keep daemon-side extension contracts in `@monad/sdk-atom`. Keep browser-side
  host bridge types in `@monad/sdk-experience`. The browser never receives the
  daemon's `WorkspaceExperienceApiContext`; it calls its pack-owned
  `apiBaseUrl` instead.
- Current Experience API routing is exact-path matching. Kanban routes use
  fixed paths and put task ids in query/body data; the plan does not silently
  assume `:id` path parameters work.
- “Third-party” means SDK-conformant, user-consented Atom Pack code in this
  delivery. Atom Pack modules currently execute in-process and web components
  execute same-origin, so this is not an untrusted-code sandbox. Marketplace
  isolation requires a later out-of-process worker + iframe design.
- The first autopilot version starts one session turn whose agent/tool loop
  iterates internally. `session.stream_ended` closes an execution run; the
  worker does not invent a second orchestration protocol or parse free-form
  chat to guess completion.
- React Flow is not part of the primary UI. A future dependency/DAG view may be
  added as a Power Pack-owned optional asset without changing task lifecycle.

---

### Task 1: Publish generic Experience capabilities

**Files:**

- Modify: `packages/sdk-atom/src/index.ts`
- Modify: `packages/protocol/src/atom-pack.ts`
- Modify: `packages/sdk-experience/src/runtime.ts`
- Modify: `packages/sdk-experience/src/index.ts`
- Modify: `packages/sdk-atom/test/unit/capability.test.ts`
- Create: `packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts`

**Interfaces:**

- Consumes: `WorkspaceExperienceApiHandler`, `WorkspaceExperienceActions`, and
  the parsed Atom Pack manifest.
- Produces: daemon-side `WorkspaceExperienceApiContext`,
  `ExperienceStateStore`, `ProjectSessionOperations`,
  `ExperienceWorkerScheduler`, `ExperienceWorker`; browser-side
  `openProjectSession(sessionId)`; and explicit pack permissions.

- [ ] **Step 1: Write the failing SDK contract test.**

~~~ts
test('workspace Experience permissions are generic and parsed from the manifest', () => {
  const manifest = parseAtomPackManifest({
    name: 'board', version: '1.0.0', sdkVersion: '0',
    atoms: ['workspace-experience'],
    permissions: ['experience.state', 'project.sessions.read']
  });
  expect(manifest.permissions).toEqual(['experience.state', 'project.sessions.read']);
});
~~~

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun test packages/sdk-atom/test/unit/capability.test.ts packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts`

Expected: FAIL because the exported generic capability types do not exist.

- [ ] **Step 3: Add the minimal public types.**

~~~ts
export interface ExperienceStateStore {
  get<T>(projectId: string, key: string): Promise<{ value: T; version: number } | null>;
  list<T>(projectId: string, prefix: string): Promise<Array<{ key: string; value: T; version: number }>>;
  compareAndSwap<T>(input: { projectId: string; key: string; expectedVersion: number | null; value: T; event: unknown }): Promise<boolean>;
}
export interface ProjectSessionOperations {
  list(projectId: string): Promise<Array<{ id: string; title: string; state: string }>>;
  create(projectId: string, input: { title: string; cwd?: string; idempotencyKey: string }): Promise<{ id: string }>;
  sendMessage(sessionId: string, input: { text: string; idempotencyKey: string }): Promise<void>;
  listMessages(sessionId: string, cursor?: string): Promise<{ items: Array<{ id: string; role: string; text: string; createdAt: string }>; nextCursor: string | null }>;
  listObservations(sessionId: string, cursor?: string): Promise<{ items: Array<{ id: string; kind: string; text: string; createdAt: string }>; nextCursor: string | null }>;
  runTurn(sessionId: string, input: { text: string; idempotencyKey: string }): Promise<{ runId: string }>;
  pause(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  listPendingApprovals(projectId: string, sessionId?: string): Promise<Array<{ id: string; sessionId: string; summary: string }>>;
  resolveApproval(approvalId: string, decision: 'approved' | 'denied'): Promise<void>;
}
export interface ProjectExperienceEvent {
  id: string; projectId: string; sessionId: string;
  type: string; payload: Record<string, unknown>; createdAt: string;
}
export interface ExperienceWorkerScheduler {
  schedule(projectId: string, input: { key: string; runAt: string }): Promise<void>;
  cancel(projectId: string, key: string): Promise<void>;
}
export interface ExperienceWorker {
  experienceId: string;
  onProjectStart(projectId: string, context: WorkspaceExperienceApiContext): Promise<void>;
  onEvent(event: ProjectExperienceEvent, context: WorkspaceExperienceApiContext): Promise<void>;
  onWake(input: { projectId: string; key: string; now: string }, context: WorkspaceExperienceApiContext): Promise<void>;
}
export interface WorkspaceExperienceApiContext {
  atomPackId: string;
  principalId: string;
  experienceState: ExperienceStateStore;
  projectSessions: ProjectSessionOperations;
  workerScheduler: ExperienceWorkerScheduler;
}
export type WorkspaceExperienceApiHandler =
  (request: Request, context: WorkspaceExperienceApiContext) => Response | Promise<Response>;
~~~

Add this closed initial permission set to `@monad/protocol`:

~~~ts
export const workspaceExperiencePermissionSchema = z.enum([
  'experience.state', 'experience.worker',
  'project.sessions.read', 'project.sessions.create', 'project.sessions.send',
  'project.observations.read', 'project.approvals.read', 'project.approvals.resolve'
]);
~~~

Define daemon-side context types only in `@monad/sdk-atom`. Add the permission
schema to `@monad/protocol`. In `@monad/sdk-experience`, add only the optional
browser action `openProjectSession(sessionId)` and keep the existing V1 host API
alias/version compatibility behavior unchanged.

- [ ] **Step 4: Run the contract test to verify it passes.**

Run: `bun test packages/sdk-atom/test/unit/capability.test.ts packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add packages/protocol/src/atom-pack.ts packages/sdk-atom/src/index.ts packages/sdk-atom/test/unit/capability.test.ts packages/sdk-experience/src/runtime.ts packages/sdk-experience/src/index.ts packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts
git commit -m "feat(sdk): add generic experience capabilities"
~~~

### Task 2: Scope workspace-Experience API requests

**Files:**

- Modify: `apps/monad/src/handlers/atom-pack/atom-pack-registry.ts`
- Modify: `apps/monad/src/handlers/atom-pack/atom-pack-manager.ts`
- Create: `apps/monad/src/handlers/atom-pack/experience-capabilities.ts`
- Modify: `apps/monad/test/e2e/workspace-experience-api.test.ts`
- Create: `apps/monad/test/unit/atoms/experience-capabilities.test.ts`

**Interfaces:**

- Consumes: Task 1's `WorkspaceExperienceApiContext`.
- Produces: `createWorkspaceExperienceApiContext({ atomPackId, principalId,
  permissions, deps })`, per-operation permission gates, and route dispatch to
  `handler(request, context)`.

- [ ] **Step 1: Write the failing authorization test.**

~~~ts
test('workspace Experience API receives a derived pack and principal context', async () => {
  const handler = async (_request: Request, context: WorkspaceExperienceApiContext) =>
    Response.json({ pack: context.atomPackId, principal: context.principalId });
  registry.registerApiRoute('pack-a', 'GET', '/whoami', handler);
  const response = await requestAs('prn_a', '/api/atoms/pack-a/whoami');
  expect(await response.json()).toEqual({ pack: 'pack-a', principal: 'prn_a' });
});
test('pack-b cannot read a record created through pack-a context', async () => {
  await contextFor('pack-a', 'prn_a').experienceState.compareAndSwap({
    projectId: 'prj_a', key: 'task/x', expectedVersion: null,
    value: { secret: 'a' }, event: { type: 'created' }
  });
  expect(await contextFor('pack-b', 'prn_a').experienceState.get('prj_a', 'task/x')).toBeNull();
});
test('an undeclared project observation permission fails before store access', async () => {
  const context = createContext({ permissions: ['experience.state'] });
  await expect(context.projectSessions.listObservations('ses_a')).rejects.toThrow('project.observations.read');
});
~~~

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun test apps/monad/test/e2e/workspace-experience-api.test.ts apps/monad/test/unit/atoms/experience-capabilities.test.ts`

Expected: FAIL because the current handler receives only `Request`.

- [ ] **Step 3: Construct context only in generic route dispatch.**

~~~ts
export function createWorkspaceExperienceApiContext(input: {
  atomPackId: string; principalId: string;
  permissions: readonly WorkspaceExperiencePermission[];
  deps: ExperienceCapabilityDeps;
}): WorkspaceExperienceApiContext {
  const requirePermission = permissionGuard(input.permissions);
  return {
    atomPackId: input.atomPackId,
    principalId: input.principalId,
    experienceState: input.deps.state.forPack(input.atomPackId, input.principalId),
    projectSessions: input.deps.projectSessions.forPrincipal(input.principalId, requirePermission),
    workerScheduler: input.deps.workerScheduler.forPack(input.atomPackId, input.principalId, requirePermission)
  };
}
~~~

Derive the principal from the authenticated request, the pack id from the
registered route owner, and permissions from the parsed installed manifest.
Add no `kanban` branch or product-state check. Reject project/session ids the
principal does not own even when the permission is declared.

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `bun test apps/monad/test/e2e/workspace-experience-api.test.ts apps/monad/test/unit/atoms/experience-capabilities.test.ts`

Expected: PASS over every supported transport.

- [ ] **Step 5: Commit.**

~~~bash
git add apps/monad/src/handlers/atom-pack apps/monad/test/e2e/workspace-experience-api.test.ts apps/monad/test/unit/atoms/experience-capabilities.test.ts
git commit -m "feat(atoms): scope workspace experience APIs"
~~~

### Task 3: Add generic state, project operations, and worker delivery

**Files:**

- Create: `apps/monad/src/atoms/experience-state.ts`
- Create: `apps/monad/src/atoms/experience-workers.ts`
- Create: `apps/monad/src/store/db/experience-state.ts`
- Create: `apps/monad/src/store/db/experience-worker-wakeups.ts`
- Modify: `apps/monad/src/store/db/schema.ts`
- Modify: `apps/monad/src/store/db/migrations.ts`
- Modify: `apps/monad/src/store/db/index.ts`
- Modify: `apps/monad/src/atoms/lifecycle.ts`
- Modify: `apps/monad/src/services/event-bus.ts`
- Modify: `packages/sdk-atom/src/index.ts`
- Create: `apps/monad/test/unit/atoms/experience-workers.test.ts`
- Modify: `apps/monad/test/unit/atoms/experience-capabilities.test.ts`

**Interfaces:**

- Consumes: Tasks 1–2.
- Produces: pack/private opaque state CAS, project session
  create/list/send/run/pause/cancel, normalized transcript/observation reads,
  public approval summaries, worker event delivery, and durable project-scoped
  wake-ups.

- [ ] **Step 1: Write the failing state and worker tests.**

~~~ts
test('compareAndSwap appends an event only for the expected version', async () => {
  const state = createExperienceStateStore(db, 'pack-a', 'prn_a');
  expect(await state.compareAndSwap({ projectId: 'prj_a', key: 'task/x', expectedVersion: null, value: { n: 1 }, event: { type: 'created' } })).toBe(true);
  expect(await state.compareAndSwap({ projectId: 'prj_a', key: 'task/x', expectedVersion: 0, value: { n: 2 }, event: { type: 'updated' } })).toBe(false);
});
test('worker receives a permitted approval event', async () => {
  const onEvent = mock(async () => {});
  registry.register('pack-a', worker({ onEvent }));
  await registry.publish(projectEvent({ id: 'evt_1', projectId: 'prj_a', type: 'approval_requested' }));
  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(onEvent.mock.calls[0][0]).toMatchObject({ id: 'evt_1', projectId: 'prj_a' });
});
test('redelivery of the same host event is idempotent in pack state', async () => {
  const event = projectEvent({ id: 'evt_1', projectId: 'prj_a', type: 'session.stream_ended' });
  await sampleExperienceFixture.onEvent(event, context);
  await sampleExperienceFixture.onEvent(event, context);
  expect(await fixtureTransitions('evt_1')).toHaveLength(1);
});
test('a due wake-up survives daemon registry reconstruction', async () => {
  await scheduler.schedule('prj_a', { key: 'dispatch', runAt: clock.now() });
  const restarted = createWorkerRegistry(db, clock);
  await restarted.deliverDueWakeups();
  expect(onWake).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'prj_a', key: 'dispatch' }),
    expect.anything()
  );
});
~~~

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun test apps/monad/test/unit/atoms/experience-capabilities.test.ts apps/monad/test/unit/atoms/experience-workers.test.ts`

Expected: FAIL because there is neither an opaque state store nor a worker registry.

- [ ] **Step 3: Implement generic runtime primitives.**

~~~ts
export interface ExperienceWorkerRegistry {
  register(atomPackId: string, worker: ExperienceWorker): void;
  startProjects(projectsFor: (atomPackId: string) => Promise<string[]>): Promise<void>;
  publish(event: ProjectExperienceEvent): Promise<void>;
  deliverDueWakeups(now?: string): Promise<void>;
}
export async function deliverExperienceEvent(event: ProjectExperienceEvent): Promise<void> {
  for (const registration of workerRegistry.forProject(event.projectId)) {
    await registration.worker.onEvent(event, contextFor(registration, event.projectId));
  }
}
~~~

Persist opaque JSON under `(atomPackId, principalId, projectId, key)` with monotonically increasing version. The host validates authorization, quotas, and transactions but never inspects a value's task/proposal semantics. Deliver only permission-filtered session and approval events. Worker retries and lifecycle are host-owned; worker decisions are pack-owned. Delivery is at-least-once, keyed by stable event id; the pack owns deduplication in its opaque state.

Add two generic tables to the flattened pre-release schema:

~~~sql
CREATE TABLE experience_state (
  atom_pack_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL, record_key TEXT NOT NULL,
  value TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (atom_pack_id, principal_id, project_id, record_key)
);
CREATE TABLE experience_state_events (
  id TEXT PRIMARY KEY, atom_pack_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
  record_key TEXT NOT NULL, version INTEGER NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE experience_worker_wakeups (
  atom_pack_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL, wake_key TEXT NOT NULL,
  run_at TEXT NOT NULL, attempt INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (atom_pack_id, principal_id, project_id, wake_key)
);
~~~

Execute the state update and audit insert in one SQLite transaction. Implement
`listObservations` by adapting existing neutral observation/history services;
do not expose provider-private raw events. Register workers during pack load.
After daemon startup, the host enumerates authorized projects internally and
calls `onProjectStart(projectId, context)`; packs do not receive a generic
cross-project enumeration capability. Persist scheduled wake-ups, claim them
transactionally, and retry failed delivery with backoff so expired leases and
incomplete provisioning can recover without a mounted UI.

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `bun test apps/monad/test/unit/atoms/experience-capabilities.test.ts apps/monad/test/unit/atoms/experience-workers.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add apps/monad/src/atoms apps/monad/src/services/event-bus.ts apps/monad/src/store/db packages/sdk-atom/src/index.ts apps/monad/test/unit/atoms
git commit -m "feat(atoms): add state and worker capabilities"
~~~

## Gate A verification

Before starting Task 4, run:

`bun test packages/sdk-atom/test/unit/capability.test.ts packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts apps/monad/test/e2e/workspace-experience-api.test.ts apps/monad/test/unit/atoms/experience-capabilities.test.ts apps/monad/test/unit/atoms/experience-workers.test.ts`

Expected: PASS with a synthetic non-Kanban Experience proving state isolation,
permission denial, session reads, one `runTurn`, and worker restart delivery.
Review Gate A independently; Gate B must consume it without importing daemon
internals.

### Task 4: Build the Power Pack domain and private API

**Files:**

- Create: `packages/monad-power-pack/src/experiences/kanban/domain.ts`
- Create: `packages/monad-power-pack/src/experiences/kanban/store.ts`
- Create: `packages/monad-power-pack/src/experiences/kanban/api.ts`
- Create: `packages/monad-power-pack/src/experiences/kanban/worker.ts`
- Modify: `packages/monad-power-pack/src/index.ts`
- Modify: `packages/monad-power-pack/test/unit/staged.test.ts`
- Create: `packages/monad-power-pack/test/unit/kanban-domain.test.ts`

**Interfaces:**

- Consumes: Task 3's generic capability context.
- Produces: pack-owned `ProjectTask`, immutable proposal/run/acceptance records, private task routes, and `kanbanWorker`.

- [ ] **Step 1: Write failing domain tests.**

~~~ts
test('proposal approval queues execution', () => {
  const task = makeTask({ stage: 'requirements', requirementsState: 'proposal_awaiting_approval', version: 2 });
  expect(approveProposal(task, 2)).toMatchObject({ stage: 'execution', executionState: 'queued', version: 3 });
});
test('acceptance return keeps evidence and requeues execution', () => {
  expect(returnForRevision(makeAcceptanceReadyTask(), 4, 'missing regression case'))
    .toMatchObject({ stage: 'execution', executionState: 'queued', returnReason: 'missing regression case' });
});
~~~

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun test packages/monad-power-pack/test/unit/kanban-domain.test.ts`

Expected: FAIL because no pack-owned lifecycle module exists.

- [ ] **Step 3: Implement the lifecycle, store, and routes.**

~~~ts
export type KanbanStage = 'requirements' | 'execution' | 'acceptance' | 'completed' | 'cancelled' | 'failed';
export interface ProjectTask {
  schemaVersion: 1; id: string; projectId: string; sessionId: string; stage: KanbanStage;
  version: number; proposalRevision: number; executionIteration: number;
}
export interface ProposalRevision {
  revision: number; summary: string; acceptanceCriteria: string[]; createdAt: string;
}
export interface ExecutionRun {
  iteration: number; runId: string; hostEventIds: string[];
  status: 'running' | 'waiting_approval' | 'succeeded' | 'failed';
  artifactRefs: Array<{ kind: string; uri: string; label: string }>;
}
export interface AcceptanceReview {
  runId: string; decision: 'pending' | 'accepted' | 'returned';
  checklist: Array<{ criterion: string; passed: boolean; evidenceRef?: string }>;
  reason?: string;
}
export const kanbanApi: WorkspaceExperienceApi = {
  experienceId: 'kanban',
  routes: [
    { method: 'GET', path: '/tasks', handle: listTasks },
    { method: 'POST', path: '/tasks/create', handle: createTask },
    { method: 'GET', path: '/tasks/panel', handle: getTaskPanel },
    { method: 'POST', path: '/messages/send', handle: sendTaskMessage },
    { method: 'POST', path: '/proposals/submit', handle: submitProposal },
    { method: 'POST', path: '/proposals/decide', handle: decideProposal },
    { method: 'POST', path: '/execution/control', handle: controlExecution },
    { method: 'POST', path: '/acceptance/decide', handle: decideAcceptance }
  ]
};
~~~

Declare these Power Pack permissions next to its existing
`workspace-experience` atom declaration:

~~~ts
permissions: [
  'experience.state', 'experience.worker',
  'project.sessions.read', 'project.sessions.create', 'project.sessions.send',
  'project.observations.read', 'project.approvals.read', 'project.approvals.resolve'
]
~~~

All ids live in validated query/body objects because the current registry uses
exact route matching. `createTask` is a recoverable saga:

1. CAS-create `provision/<taskId>` with caller idempotency key.
2. Call generic `projectSessions.create(..., { idempotencyKey })`.
3. CAS-bind the returned session id and create `task/<taskId>`.
4. Mark provisioning complete; on restart the worker resumes incomplete rows.

This avoids pretending a host session write and pack-state write share one
database transaction. Register the API and worker from `monadPowerPack` and
extend staging to include every new web asset.

- [ ] **Step 4: Run tests to verify they pass.**

Run: `bun test packages/monad-power-pack/test/unit/kanban-domain.test.ts packages/monad-power-pack/test/unit/staged.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add packages/monad-power-pack/src packages/monad-power-pack/test/unit
git commit -m "feat(power-pack): add kanban task lifecycle"
~~~

### Task 5: Implement approval-safe parallel autopilot

**Files:**

- Modify: `packages/monad-power-pack/src/experiences/kanban/worker.ts`
- Modify: `packages/monad-power-pack/src/experiences/kanban/store.ts`
- Create: `packages/monad-power-pack/test/unit/kanban-worker.test.ts`

**Interfaces:**

- Consumes: Task 4's private task store and Task 3's worker/event primitives.
- Produces: per-project concurrency leases, session-targeted directives, approval pauses, retry/recovery behavior.

- [ ] **Step 1: Write failing worker tests.**

~~~ts
test('worker starts no more than the configured number of tasks per project', async () => {
  const started = await dispatchRunnableTasks({ limit: 2, runnable: [taskA, taskB, taskC] });
  expect(started.map((task) => task.id)).toEqual([taskA.id, taskB.id]);
});
test('approval_requested pauses only its matching task', async () => {
  const next = await kanbanWorker.onEvent(approvalEventFor(taskA.sessionId), context);
  expect(next.task(taskA.id).executionState).toBe('waiting_approval');
  expect(next.task(taskB.id).executionState).toBe('running');
});
test('session.stream_ended moves a clean run to acceptance without parsing chat', async () => {
  const next = await kanbanWorker.onEvent(streamEndedFor(taskA.sessionId), context);
  expect(next.task(taskA.id).stage).toBe('acceptance');
});
~~~

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun test packages/monad-power-pack/test/unit/kanban-worker.test.ts`

Expected: FAIL because worker dispatch and approval mapping do not exist.

- [ ] **Step 3: Implement the minimal worker loop.**

~~~ts
export async function dispatchRunnableTasks(input: { limit: number; runnable: ProjectTask[] }) {
  const leased: ProjectTask[] = [];
  for (const task of input.runnable) {
    if (leased.length >= input.limit) break;
    const acquired = await store.acquireLease(task.id, task.version, workerId, leaseExpiresAt());
    if (acquired) leased.push(acquired);
  }
  await Promise.all(leased.map((task) => startExecution(task)));
  return leased;
}
async function startExecution(task: ProjectTask) {
  try {
    const run = await context.projectSessions.runTurn(task.sessionId, {
      text: executionDirective(task), idempotencyKey: `kanban:${task.id}:${task.executionIteration + 1}`
    });
    await store.markRunStarted(task.id, task.version, run.runId);
  } catch (error) {
    await store.releaseLeaseToQueued(task.id, String(error));
  }
}
~~~

Only host approval summaries decide `waiting_approval`; the worker never resolves an approval. After `approval_resolved`, reload state and queue the next iteration only when no pending summary remains.
Acquire the CAS lease before any external side effect. For the first delivery,
the session's agent/tool loop performs internal plan → implement → verify →
revise work inside one `runTurn`. A clean `session.stream_ended` moves the task
to Acceptance; a failed/aborted stream records a failed run. The worker never
parses prose to determine success. Scheduled wake-ups recover expired leases
and incomplete provisioning records after daemon restart.
Every queue-producing transition schedules the same project-scoped `dispatch`
wake-up key. `onProjectStart` and `onWake` both run the identical recovery +
dispatch function, making startup, retries, and normal scheduling converge on
one code path.

- [ ] **Step 4: Run the worker tests to verify they pass.**

Run: `bun test packages/monad-power-pack/test/unit/kanban-worker.test.ts packages/monad-power-pack/test/unit/kanban-domain.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add packages/monad-power-pack/src/experiences/kanban packages/monad-power-pack/test/unit
git commit -m "feat(power-pack): schedule parallel kanban execution"
~~~

### Task 6: Render the selected three-lane Kanban UI

**Files:**

- Modify: `packages/monad-power-pack/src/experiences/kanban.js`
- Create: `packages/monad-power-pack/test/unit/kanban-ui.test.ts`
- Modify: `packages/monad-power-pack/test/unit/staged.test.ts`

**Interfaces:**

- Consumes: Task 4's private routes and Task 1's browser-side
  `apiBaseUrl` / optional session-open action.
- Produces: `monad-kanban` with Requirements, Execution, and Acceptance lanes plus a component-owned selected-task right inspector.

- [ ] **Step 1: Write failing UI tests.**

~~~ts
test('kanban renders the three lanes from private API task data', async () => {
  const html = await renderKanban({ tasks: [requirementsTask, executionTask, acceptanceTask] });
  expect(html).toContain('Requirements');
  expect(html).toContain('Execution');
  expect(html).toContain('Acceptance');
});
test('selecting a requirements card opens the component inspector with the task transcript', async () => {
  const api = fakeHostApi();
  await selectTaskCard(api, requirementsTask.id);
  expect(renderedInspector(api)).toContain('Task discussion');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/tasks/panel?taskId=${requirementsTask.id}`));
});
test('selecting an execution card opens the complete observation inspector', async () => {
  const api = fakeHostApi();
  await selectTaskCard(api, executionTask.id);
  expect(renderedInspector(api)).toContain('Tool calls');
});
~~~

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun test packages/monad-power-pack/test/unit/kanban-ui.test.ts`

Expected: FAIL because the current component only renders a graph canvas.

- [ ] **Step 3: Implement the focused component.**

~~~js
const LANES = ['requirements', 'execution', 'acceptance'];
async function loadTasks(api) {
  const url = `${api.apiBaseUrl}/tasks?projectId=${encodeURIComponent(api.snapshot.projectId)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`kanban tasks request failed: ${response.status}`);
  return response.json();
}
async function selectTask(api, task) {
  const response = await fetch(`${api.apiBaseUrl}/tasks/panel?taskId=${encodeURIComponent(task.id)}`);
  if (!response.ok) throw new Error(`kanban panel request failed: ${response.status}`);
  const content = await response.json();
  renderInspector(api, task, content);
}
~~~

Render only the three active lanes, concise cards, proposal/execution/acceptance detail, and their required core actions. Keep terminal cards behind history. Do not read `graphCanvas` for task data or add a host React component.
The inspector belongs inside the web component, not the host
`RightPanelProvider`. Its private API uses daemon-side capability context to
read transcript/observation data; daemon capability objects never cross into
the browser. Requirements renders complete discussion plus composer; Execution
renders normalized observation with iteration markers and approval controls;
Acceptance renders proposal, artifacts, evidence, checklist, and accept/return.
Keep “open full session” as a secondary browser host action.

Add keyboard arrow navigation between cards, Escape-to-close with focus return,
an ARIA live region for state changes, a 420–560px resizable inspector on
desktop, and a full-width overlay inspector below 900px. Paginate lanes and
panel timelines; do not render every project task or observation event at once.

- [ ] **Step 4: Run UI and staging tests to verify they pass.**

Run: `bun test packages/monad-power-pack/test/unit/kanban-ui.test.ts packages/monad-power-pack/test/unit/staged.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add packages/monad-power-pack/src/experiences/kanban.js packages/monad-power-pack/test/unit
git commit -m "feat(power-pack): render three-stage kanban"
~~~

### Task 7: Verify the complete installed-pack lifecycle

**Files:**

- Create: `apps/monad/test/e2e/kanban-experience.test.ts`
- Modify: `apps/monad/test/e2e/workspace-experience-api.test.ts`
- Modify: `packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts`

**Interfaces:**

- Consumes: all preceding tasks.
- Produces: end-to-end evidence that business behavior is pack-owned and that parallel/autopilot approvals are correct.

- [ ] **Step 1: Write the failing end-to-end tests.**

~~~ts
test('two Kanban tasks use two sessions in one shared Experience', async () => {
  const first = await createKanbanTask(projectId, 'A');
  const second = await createKanbanTask(projectId, 'B');
  expect(first.sessionId).not.toBe(second.sessionId);
  expect((await listKanbanTasks(projectId)).map((task) => task.id)).toEqual([first.id, second.id]);
});
test('an unresolved approval pauses one task and an acceptance return requeues it', async () => {
  const task = await createAndApproveProposal(projectId, 'A');
  await publishHostEvent(approvalRequested(task.sessionId, 'apr_1'));
  expect(await getKanbanTask(task.id)).toMatchObject({ executionState: 'waiting_approval' });
  await resolveApprovalAsUser('apr_1', 'approved');
  await publishHostEvent(approvalResolved(task.sessionId, 'apr_1'));
  await publishHostEvent(streamEnded(task.sessionId));
  await decideAcceptance(task.id, { decision: 'return', reason: 'add regression case' });
  expect(await getKanbanTask(task.id)).toMatchObject({ stage: 'execution', executionState: 'queued' });
});
~~~

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun test apps/monad/test/e2e/kanban-experience.test.ts`

Expected: FAIL until the generic host capability and Power Pack flow exist.

- [ ] **Step 3: Implement the installed-pack fixture.**

Mount the Power Pack fixture through the same manifest registration helper used
by `workspace-experience-api.test.ts`. Create and advance tasks only with the
eight fixed routes declared in Task 4, publish host events through the generic
worker registry, and read UI data through `/tasks` and `/tasks/panel`. Assert
that the host snapshot has no `projectKanban` field and its route registry has
no host-owned route containing `kanban`, `proposal`, or `acceptance`.

- [ ] **Step 4: Run focused verification.**

Run: `bun test packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts apps/monad/test/unit/atoms/experience-capabilities.test.ts apps/monad/test/unit/atoms/experience-workers.test.ts packages/monad-power-pack/test/unit/kanban-domain.test.ts packages/monad-power-pack/test/unit/kanban-worker.test.ts packages/monad-power-pack/test/unit/kanban-ui.test.ts apps/monad/test/e2e/workspace-experience-api.test.ts apps/monad/test/e2e/kanban-experience.test.ts`

Expected: PASS.

- [ ] **Step 5: Run typechecks and inspect scope.**

Run: `bun run --cwd packages/sdk-atom typecheck && bun run --cwd packages/sdk-experience typecheck && bun run --cwd packages/monad-power-pack typecheck && bun run --cwd apps/monad typecheck`

Expected: changed-package typechecks pass; report unrelated baseline failure separately.

Run: `git diff --check HEAD~7..HEAD && git diff --stat HEAD~7..HEAD`

Expected: no whitespace errors; changes are limited to generic Experience capabilities, SDK contracts, tests, and Power Pack Kanban files.

- [ ] **Step 6: Commit verification coverage.**

~~~bash
git add apps/monad/test/e2e packages/sdk-experience/test/unit
git commit -m "test: cover third-party kanban lifecycle"
~~~

## Deferred extension seams

These are deliberate follow-ons, not hidden MVP requirements:

| Extension | Existing seam | Add later without changing the three-stage contract |
| --- | --- | --- |
| Task dependencies / DAG | `ProjectTask.schemaVersion` and pack-private records | Add `dependsOn` plus cycle validation in the Power Pack. React Flow may render an optional dependency view; the Kanban remains the operating surface. |
| Reusable workflow templates | Proposal snapshot and task creation API | Add pack-owned task templates and policy presets; do not add task types to the host. |
| Rich artifacts and checks | Immutable run and acceptance records | Store typed artifact references and check results in pack state; blobs continue through generic host file/artifact facilities. |
| Notifications and external automation | Stable pack audit events and worker events | Add pack-owned webhook/notification adapters with explicit permissions, signing, retry, and delivery logs. |
| Team review | Principal-scoped capability context | Add generic project-role/actor context first, then pack-owned comments, reviewers, and acceptance policy. |
| Marketplace-grade isolation | Manifest permissions and Gate A capability boundary | Move daemon workers out of process and web UI into an iframe/sandbox before treating arbitrary third-party code as untrusted. |
| Portfolio analytics | Cursor-paginated task and audit APIs | Build aggregate, read-only Power Pack views; do not denormalize Kanban state into host snapshots. |

Do not add these schemas or UI controls during Tasks 1–7 except for the
version, cursor, event-id, and artifact-reference fields needed to preserve the
seams. The next review checkpoint after MVP is real usage evidence: queue
depth, approval wait time, execution iterations, acceptance return rate, worker
recovery count, and inspector load latency.
