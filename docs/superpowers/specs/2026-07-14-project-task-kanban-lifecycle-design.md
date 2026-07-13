# Project-task Kanban lifecycle design

## Goal

Turn the Power Pack's `kanban` experience from an activity topology into one
shared project workboard. A project contains multiple independently-running
work items; each work item owns exactly one project session. The board groups
those items into three user-facing stages:

1. **Requirements** — a user and AI iterate in the task session until a
   proposal is ready for approval.
2. **Execution** — after proposal approval, the assigned agent runs an
   autonomous plan → implement → verify → revise loop. Human intervention is
   limited to existing safety approvals and explicitly configured gates.
3. **Acceptance** — the task presents its proposal, execution evidence, and
   deliverables for a human to accept or return to execution.

The Experience is a projection over durable project-task, session, approval,
and artifact state. It must never infer a task's phase by parsing chat text or
tool output in the browser.

## Product model and boundaries

```text
WorkplaceProject              project environment, roster templates, workdir
  └─ ProjectTask               one durable Kanban work item
       ├─ Session              exactly one project session, its discussion and execution context
       ├─ ProposalRevision[]   approved contract for autonomous execution
       ├─ ExecutionRun[]       iteration summaries and linked evidence
       ├─ ApprovalRef[]        gates that currently interrupt progress
       └─ AcceptanceRecord     final human decision and optional return reason
```

`Session` remains a conversation/runtime boundary. It is not itself the
product work-item record: sessions own transcript, member bindings, process
state, and messages; `ProjectTask` owns lifecycle meaning, proposal revision,
and acceptance. This distinction prevents a generic chat session from
accidentally appearing as a Kanban card and preserves a stable task identity
when a session is archived or retried.

The existing `tasks` table is not reused. Its current role is an intra-session
agent DAG (`dependsOn`, `assigneeAgentId`, `pending/running/succeeded/...`).
Expanding it into the project board would couple two different lifecycles and
would make a single project task ambiguously mean both a Kanban item and a
subtask. Project work uses a new `project_tasks` table.

## Durable model

`project_tasks` is keyed by `TaskId` and includes:

- `id`, `projectId`, `sessionId` (unique), `title`, `summary`
- `stage`: `requirements | execution | acceptance | completed | cancelled | failed`
- `requirementsState`: `discussing | proposal_ready | proposal_awaiting_approval`
- `executionState`: `queued | running | waiting_approval | blocked | succeeded | failed | cancelled`
- `proposalRevision`, `executionIteration`, `version`, `createdAt`, `updatedAt`
- `acceptedAt`, `acceptedBy`, `returnReason` where applicable

`project_task_proposals` stores immutable revisions. A revision captures goal,
scope, acceptance criteria, execution plan, constraints, and its approval
decision. Editing a proposal creates a new revision; an approved revision is
never overwritten.

`project_task_runs` records compact iteration summaries: iteration number,
trigger, start/end times, outcome, result summary, and artifact/message/event
references. It does not duplicate full transcript or tool payloads.

`project_task_acceptance` records the final accept/return action and reviewer
comment. Returning a task atomically changes the task to `execution` with
`executionState=queued`, retaining all prior evidence.

All lifecycle changes use the task `version` as an optimistic-concurrency
token. The transition command checks the expected version, persists the state
and appends an auditable domain event in one transaction. Conflicting client or
agent actions receive a refreshable conflict rather than silently winning.

## Lifecycle and permissions

```text
requirements/discussing
  → requirements/proposal_ready
  → requirements/proposal_awaiting_approval
  → execution/queued
  → execution/running ↔ execution/waiting_approval
  → acceptance
  → completed

acceptance → execution/queued       (human returns with reason)
any non-terminal state → cancelled
execution/running → failed          (terminal run failure)
```

- The task session accepts normal user/AI discussion only while in
  `requirements`; proposing is an explicit command that snapshots a revision.
- Only an authorized human can approve a proposal. Approval starts the
  execution scheduler; rejection returns the task to `requirements/discussing`.
- The execution scheduler may continue a task automatically after a successful
  iteration. It pauses only for a registered approval, an unrecoverable
  execution failure, cancellation, or the configured retry budget.
- Existing tool and external-agent approval events remain the source of truth
  for safety decisions. A projection links unresolved events to their
  `ProjectTask`; resolving an approval uses the existing host action, then the
  scheduler decides whether execution can resume.
- Only a human may accept or return a task. Acceptance is unavailable while
  unresolved approvals exist or the latest execution run has not succeeded.

## Kanban projection and interaction

The `kanban` web component receives `projectKanban` in its workspace-experience
snapshot rather than fetching or reconstructing state itself. The projection
contains the selected task plus a lightweight summary for every project task:

- identity, title, stage/substate, current iteration, and updated time
- proposal status and approval counts
- current agent presence, latest run outcome, and compact evidence links
- acceptance status and return reason

The board has exactly three lanes: **Requirements**, **Execution**, and
**Acceptance**. Cards remain in their lane even while showing richer substates
(`discussing`, `awaiting approval`, `iteration 3`, `ready for review`).
Completed, cancelled, and failed items leave the active board but remain
available through a compact history filter.

Selecting a card changes the active task/session context for the shared
Experience; it does not create another Experience instance. The details panel
shows the requirement discussion/proposal in Requirements, an execution-loop
timeline plus approvals in Execution, and an evidence-led acceptance packet in
Acceptance. The primary actions are stage-specific: create task, submit
proposal, approve/reject proposal, pause/cancel, approve/reject safety gate,
and accept/return.

## Parallel execution and isolation

Parallel cards are supported because every `ProjectTask` owns a distinct
session and therefore distinct `session_members` and external-agent bindings.
The project member template catalog seeds each task session but never shares a
running external-agent process across tasks.

The scheduler enforces a per-project concurrency limit and a task lease. A task
cannot start two execution runs simultaneously; recovery reclaims expired
leases only after checking the latest task version and run state. The scheduler
also exposes a task's workdir and optional branch/worktree strategy. Initial
delivery keeps conflict prevention explicit: tasks sharing a workdir may run
only if their execution plan declares no overlapping write scope; otherwise the
second task is queued or requires an isolated worktree. The system must not
claim that separate sessions alone prevent filesystem conflicts.

## API and compatibility

Add project-scoped task endpoints for create/list/detail and lifecycle
commands. `createProjectTask` creates the durable task and its project session
in one transaction, cloning project member templates into that session.

The workspace experience SDK gains an additive `projectKanban` snapshot field
and task-lifecycle actions. Existing Experiences remain compatible because the
field is optional. The Power Pack Kanban declares the minimum API version it
needs and renders a clear unavailable-state when connected to an older host.

The current `graphCanvas` remains an independent generic activity projection;
it is not repurposed as the board's data channel. This preserves its use for
other Experiences and avoids breaking the existing Kanban migration work.

## Delivery slices

1. **Domain foundation:** protocol types, migration, store, lifecycle
   transition service, immutable proposal/run/acceptance records, and focused
   transition/concurrency tests.
2. **Runtime and scheduler:** create task + session atomically, session member
   template cloning, leases/concurrency policy, approval-event linking, and
   project task APIs.
3. **Experience contract:** aggregate projection for all project tasks, SDK
   actions, web client endpoints, and compatibility tests.
4. **Kanban UI:** replace graph rendering with the three-lane board based on
   selected visual direction 2; implement task selection and all core
   stage-specific actions.
5. **Verification:** migration/backfill tests, lifecycle race tests, scheduler
   recovery tests, projection contract tests, and browser-level parallel-task,
   approval, return-to-execution, and acceptance journeys.

## Non-goals

- Inferring project-task lifecycle from free-form chat.
- Treating general session-subtasks as project Kanban cards.
- Bypassing current high-risk tool approval policy during autopilot.
- Solving arbitrary concurrent filesystem merges in the first delivery.
- Replacing the existing generic activity graph or its consumers.
