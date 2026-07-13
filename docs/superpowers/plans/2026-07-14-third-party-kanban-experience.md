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
- Existing V1 Experiences remain compatible. Keep `graphCanvas` unchanged.

---

### Task 1: Publish generic Experience capabilities

**Files:**

- Modify: `packages/sdk-atom/src/index.ts`
- Modify: `packages/sdk-experience/src/runtime.ts`
- Modify: `packages/sdk-experience/src/index.ts`
- Create: `packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts`

**Interfaces:**

- Consumes: `WorkspaceExperienceApiHandler`, `WorkspaceExperienceActions`.
- Produces: `WorkspaceExperienceApiContext`, `ExperienceStateStore`, `ProjectSessionOperations`, `ProjectEventSubscription`, and `ExperienceWorker`.

- [ ] **Step 1: Write the failing SDK contract test.**

~~~ts
test('generic Experience capability names contain no Kanban business state', () => {
  const capabilities = ['experienceState', 'projectSessions', 'projectEvents', 'worker'];
  expect(capabilities.some((name) => /kanban|proposal|acceptance|task/i.test(name))).toBe(false);
});
~~~

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun test packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts`

Expected: FAIL because the exported generic capability types do not exist.

- [ ] **Step 3: Add the minimal public types.**

~~~ts
export interface ExperienceStateStore {
  get<T>(key: string): Promise<{ value: T; version: number } | null>;
  list<T>(prefix: string): Promise<Array<{ key: string; value: T; version: number }>>;
  compareAndSwap<T>(input: { key: string; expectedVersion: number | null; value: T; event: unknown }): Promise<boolean>;
}
export interface ProjectSessionOperations {
  list(projectId: string): Promise<Array<{ id: string; title: string; state: string }>>;
  create(projectId: string, input: { title: string; cwd?: string }): Promise<{ id: string }>;
  open(sessionId: string): Promise<void>;
  sendDirective(sessionId: string, input: { text: string }): Promise<void>;
  pause(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  listPendingApprovals(projectId: string, sessionId?: string): Promise<Array<{ id: string; sessionId: string; summary: string }>>;
}
export interface WorkspaceExperienceApiContext {
  atomPackId: string;
  principalId: string;
  experienceState: ExperienceStateStore;
  projectSessions: ProjectSessionOperations;
  projectEvents: ProjectEventSubscription;
}
export type WorkspaceExperienceApiHandler =
  (request: Request, context: WorkspaceExperienceApiContext) => Response | Promise<Response>;
~~~

Export these types through `@monad/sdk-experience`. Keep the existing V1 host API alias and its version compatibility behavior unchanged.

- [ ] **Step 4: Run the contract test to verify it passes.**

Run: `bun test packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add packages/sdk-atom/src/index.ts packages/sdk-experience/src/runtime.ts packages/sdk-experience/src/index.ts packages/sdk-experience/test/unit/workspace-experience-capabilities.test.ts
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
- Produces: `createWorkspaceExperienceApiContext({ atomPackId, principalId, deps })` and route dispatch to `handler(request, context)`.

- [ ] **Step 1: Write the failing authorization test.**

~~~ts
test('workspace Experience API receives a derived pack and principal context', async () => {
  const handler = async (_request: Request, context: WorkspaceExperienceApiContext) =>
    Response.json({ pack: context.atomPackId, principal: context.principalId });
  // Register the route, issue an authenticated request, and assert both derived values.
});
test('pack-b cannot read a record created through pack-a context', async () => {
  // Assert pack-private namespace isolation for the same principal and key.
});
~~~

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun test apps/monad/test/e2e/workspace-experience-api.test.ts apps/monad/test/unit/atoms/experience-capabilities.test.ts`

Expected: FAIL because the current handler receives only `Request`.

- [ ] **Step 3: Construct context only in generic route dispatch.**

~~~ts
export function createWorkspaceExperienceApiContext(input: {
  atomPackId: string; principalId: string; deps: ExperienceCapabilityDeps;
}): WorkspaceExperienceApiContext {
  return {
    atomPackId: input.atomPackId,
    principalId: input.principalId,
    experienceState: input.deps.state.forPack(input.atomPackId, input.principalId),
    projectSessions: input.deps.projectSessions.forPrincipal(input.principalId),
    projectEvents: input.deps.projectEvents.forPrincipal(input.principalId)
  };
}
~~~

Derive the principal from the authenticated request and pack id from the registered route owner. Add no `kanban` branch or product-state check.

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
- Modify: `apps/monad/src/atoms/lifecycle.ts`
- Modify: `apps/monad/src/services/event-bus.ts`
- Modify: `packages/sdk-atom/src/index.ts`
- Create: `apps/monad/test/unit/atoms/experience-workers.test.ts`
- Modify: `apps/monad/test/unit/atoms/experience-capabilities.test.ts`

**Interfaces:**

- Consumes: Tasks 1–2.
- Produces: pack/private opaque state CAS, project session create/list/open/send/pause/cancel, public approval summaries, and worker event delivery.

- [ ] **Step 1: Write the failing state and worker tests.**

~~~ts
test('compareAndSwap appends an event only for the expected version', async () => {
  const state = createExperienceStateStore(db, 'pack-a', 'prn_a');
  expect(await state.compareAndSwap({ key: 'task/x', expectedVersion: null, value: { n: 1 }, event: { type: 'created' } })).toBe(true);
  expect(await state.compareAndSwap({ key: 'task/x', expectedVersion: 0, value: { n: 2 }, event: { type: 'updated' } })).toBe(false);
});
test('worker receives a permitted approval event', async () => {
  // Register a worker, publish one approval event, and assert exactly one project-scoped delivery.
});
~~~

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun test apps/monad/test/unit/atoms/experience-capabilities.test.ts apps/monad/test/unit/atoms/experience-workers.test.ts`

Expected: FAIL because there is neither an opaque state store nor a worker registry.

- [ ] **Step 3: Implement generic runtime primitives.**

~~~ts
export interface ExperienceWorker {
  experienceId: string;
  onEvent(event: { projectId: string; type: string; payload: Record<string, unknown> },
          context: WorkspaceExperienceApiContext): Promise<void>;
}
export async function deliverExperienceEvent(event: ProjectEvent): Promise<void> {
  for (const worker of workersFor(event.projectId)) {
    await worker.onEvent(toPublicEvent(event), workerContext(worker, event.projectId));
  }
}
~~~

Persist opaque JSON under `(atomPackId, principalId, projectId, key)` with monotonically increasing version. The host validates authorization, quotas, and transactions but never inspects a value's task/proposal semantics. Deliver only permission-filtered session and approval events. Worker retries and lifecycle are host-owned; worker decisions are pack-owned.

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `bun test apps/monad/test/unit/atoms/experience-capabilities.test.ts apps/monad/test/unit/atoms/experience-workers.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

~~~bash
git add apps/monad/src/atoms apps/monad/src/services/event-bus.ts packages/sdk-atom/src/index.ts apps/monad/test/unit/atoms
git commit -m "feat(atoms): add state and worker capabilities"
~~~

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
  id: string; projectId: string; sessionId: string; stage: KanbanStage;
  version: number; proposalRevision: number; executionIteration: number;
}
export const kanbanApi: WorkspaceExperienceApi = {
  experienceId: 'kanban',
  routes: [
    { method: 'GET', path: '/tasks', handle: listTasks },
    { method: 'POST', path: '/tasks', handle: createTask },
    { method: 'POST', path: '/tasks/:id/proposals', handle: submitProposal },
    { method: 'POST', path: '/tasks/:id/acceptance', handle: decideAcceptance }
  ]
};
~~~

`createTask` creates a project session via the generic capability, writes the private task record with CAS, and cancels an unused session on a failed pack write. Register the API and worker from `monadPowerPack`; extend staging to include every new web asset.

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
~~~

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun test packages/monad-power-pack/test/unit/kanban-worker.test.ts`

Expected: FAIL because worker dispatch and approval mapping do not exist.

- [ ] **Step 3: Implement the minimal worker loop.**

~~~ts
export async function dispatchRunnableTasks(input: { limit: number; runnable: ProjectTask[] }) {
  const leased = input.runnable.slice(0, input.limit);
  await Promise.all(leased.map((task) => startExecution(task)));
  return leased;
}
async function startExecution(task: ProjectTask) {
  await context.projectSessions.sendDirective(task.sessionId, { text: executionDirective(task) });
  await store.transition(task.id, task.version, { stage: 'execution', executionState: 'running' },
    { type: 'execution.started' });
}
~~~

Only host approval summaries decide `waiting_approval`; the worker never resolves an approval. After `approval_resolved`, reload state and queue the next iteration only when no pending summary remains.

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

- Consumes: Task 4's private routes and Task 1's `apiBaseUrl` / generic session-open action.
- Produces: `monad-kanban` with Requirements, Execution, and Acceptance lanes plus selected-task details.

- [ ] **Step 1: Write failing UI tests.**

~~~ts
test('kanban renders the three lanes from private API task data', async () => {
  const html = await renderKanban({ tasks: [requirementsTask, executionTask, acceptanceTask] });
  expect(html).toContain('Requirements');
  expect(html).toContain('Execution');
  expect(html).toContain('Acceptance');
});
test('selecting a card opens its host project session', async () => {
  const api = fakeHostApi();
  await selectTaskCard(api, executionTask.id);
  expect(api.actions.openProjectSession).toHaveBeenCalledWith(executionTask.sessionId);
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
function selectTask(api, task) {
  api.actions.openProjectSession(task.sessionId);
}
~~~

Render only the three active lanes, concise cards, proposal/execution/acceptance detail, and their required core actions. Keep terminal cards behind history. Do not read `graphCanvas` for task data or add a host React component.

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
  // Drive proposal approval, approval_requested, approval_resolved, acceptance return, then assert execution/queued.
});
~~~

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun test apps/monad/test/e2e/kanban-experience.test.ts`

Expected: FAIL until the generic host capability and Power Pack flow exist.

- [ ] **Step 3: Implement the installed-pack fixture.**

Use the mounted-pack discovery pattern from `workspace-experience-api.test.ts`, execute only public Experience API routes, and assert the host does not expose a `projectKanban` snapshot field or a Kanban-specific route.

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
