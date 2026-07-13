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

The Experience is a third-party Atom Pack. Its web component, task lifecycle,
automation policy, persistence schema, and projection all belong to that pack;
the Monad host supplies only generic project/session/runtime primitives through
the workspace-experience SDK. It must never infer a task's phase by parsing
chat text or tool output in the browser.

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

`Session` remains a host-owned conversation/runtime boundary. `ProjectTask` is
pack-owned business state: the Kanban Atom Pack creates it alongside one
project session and associates the two by ID. Sessions own transcript, member
bindings, process state, and messages; the pack owns lifecycle meaning,
proposal revision, execution policy, and acceptance. This distinction prevents
a generic chat session from accidentally appearing as a Kanban card and
preserves a stable task identity when a session is archived or retried.

The existing host `tasks` table is not reused. Its current role is an
intra-session agent DAG (`dependsOn`, `assigneeAgentId`,
`pending/running/succeeded/...`). Expanding it into the project board would
couple two different lifecycles and would make a single project task
ambiguously mean both a Kanban item and a subtask. The pack stores its own
`project-task` records in its private experience-state namespace rather than
adding a host `project_tasks` table.

## Durable model

The pack's `project-task` record is keyed by `TaskId` and includes:

- `id`, `projectId`, `sessionId` (unique), `title`, `summary`
- `stage`: `requirements | execution | acceptance | completed | cancelled | failed`
- `requirementsState`: `discussing | proposal_ready | proposal_awaiting_approval`
- `executionState`: `queued | running | waiting_approval | blocked | succeeded | failed | cancelled`
- `proposalRevision`, `executionIteration`, `version`, `createdAt`, `updatedAt`
- `acceptedAt`, `acceptedBy`, `returnReason` where applicable

The pack stores proposal revisions, run summaries, and acceptance records as
separate namespaced records. A proposal revision captures goal,
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
token. The pack transition command checks the expected version, persists the
state and appends a pack-owned domain event in one atomic experience-state
operation. Conflicting client or agent actions receive a refreshable conflict
rather than silently winning.

## Third-party Experience contract

The existing `WorkspaceExperienceHostApiV1` is sufficient for mounting a
same-origin web component, receiving the active `projectId`/`activeSessionId`,
sending a directive to the active session, resolving a known approval, opening
host dialogs, and loading the pack's own `apiBaseUrl`. The Kanban component
uses that bridge and renders entirely inside `monad-kanban`; it does not add a
host component or a host-owned Kanban projection.

The current contract is insufficient for a durable, multi-session autopilot
board: an API route receives only `Request`, the snapshot exposes only one
active session, and actions cannot list/create/open project sessions, target a
directive to a selected session, list pending approvals, or receive scoped
runtime updates. The host therefore needs a small **generic** capability
addition, not any Kanban-specific type, table, endpoint, or state machine:

- `WorkspaceExperienceApiHandler(request, context)`, where `context` is
  authenticated and project-authorized, and exposes generic project/session
  read and lifecycle operations.
- A pack-private `ExperienceStateStore`, namespaced by pack and project, with
  record list/get, atomic compare-and-swap, and append-only event support.
  The host stores opaque values and enforces ownership, quotas, authorization,
  and transactions; it has no knowledge of tasks, proposals, execution, or
  acceptance.
- Generic project-session primitives: list/create/open sessions and
  session-targeted `sendDirective`, pause, and cancellation actions. These are
  SDK operations usable by any Experience, not Kanban actions.
- A generic, permission-filtered project event subscription containing session
  progress and approval lifecycle events. Polling the pack API is a safe
  fallback, but subscription is required for responsive autopilot recovery.
- A generic `ExperienceWorker` registration: the host delivers authorized
  project events and scheduled wake-ups to pack-owned code with the same
  capability context. The host owns worker lifecycle, isolation, retries, and
  delivery; the pack owns every scheduling decision and task transition. A web
  component alone cannot run autopilot safely once the user closes the board.
- `listPendingApprovals` alongside the existing `resolveApproval`, scoped to a
  project/session and returning only the public approval summary needed for an
  Experience.

The pack declares the required generic capability/API version and renders a
clear unsupported-host state when it is absent. Host additions are additive and
versioned; existing Experiences continue to consume V1 unchanged.

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

- The pack accepts normal user/AI discussion only while in
  `requirements`; proposing is an explicit command that snapshots a revision.
- Only an authorized human can approve a proposal. Approval starts the
  execution scheduler; rejection returns the task to `requirements/discussing`.
- The execution scheduler may continue a task automatically after a successful
  iteration. It pauses only for a registered approval, an unrecoverable
  execution failure, cancellation, or the configured retry budget.
- Host tool and external-agent approval events remain the source of truth for
  safety decisions. The pack links unresolved generic event summaries to their
  `ProjectTask`; resolving an approval uses the generic host action, then the
  pack scheduler decides whether execution can resume.
- Only a human may accept or return a task. Acceptance is unavailable while
  unresolved approvals exist or the latest execution run has not succeeded.

## Kanban projection and interaction

The `kanban` web component calls its pack-owned API at `apiBaseUrl` and builds
its own projection from pack state plus generic host session/approval data. It
uses the host snapshot only for mounting context and the generic update bridge.
The projection contains the selected task plus a lightweight summary for every
project task:

- identity, title, stage/substate, current iteration, and updated time
- proposal status and approval counts
- current agent presence, latest run outcome, and compact evidence links
- acceptance status and return reason

The board has exactly three lanes: **Requirements**, **Execution**, and
**Acceptance**. Cards remain in their lane even while showing richer substates
(`discussing`, `awaiting approval`, `iteration 3`, `ready for review`).
Completed, cancelled, and failed items leave the active board but remain
available through a compact history filter.

Selecting a card uses the generic `openProjectSession(sessionId)` primitive to
change the active session for the shared Experience; it does not create another
Experience instance. The details panel
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

The pack's `ExperienceWorker` scheduler enforces a per-project concurrency
limit and a task lease in its own state namespace. A task cannot start two
execution runs simultaneously; recovery reclaims expired leases only after
checking the latest task version and run state. It invokes generic host session
operations rather than hosting an agent runtime itself. The scheduler also
exposes a task's workdir and optional branch/worktree strategy. Initial
delivery keeps conflict prevention explicit: tasks sharing a workdir may run
only if their execution plan declares no overlapping write scope; otherwise the
second task is queued or requires an isolated worktree. The system must not
claim that separate sessions alone prevent filesystem conflicts.

## API and compatibility

The Power Pack registers private, project-scoped routes beneath its existing
experience `apiBaseUrl`: create/list/detail task, proposal lifecycle,
execution-control, and acceptance commands. `createProjectTask` first invokes
the generic host create-session primitive, then atomically creates its own task
record and membership/template references. If the pack write fails, it cleans
up the newly-created unused session; if cleanup fails, it records an explicit
recoverable orphan rather than hiding it.

No `projectKanban` snapshot field, host task endpoint, host task action, or
host Kanban renderer is added. The generic SDK additions in the previous
section are the only host work. The current `graphCanvas` remains an
independent generic activity projection; it is not repurposed as the board's
data channel. This preserves its use for other Experiences and avoids breaking
the existing Kanban migration work.

## Delivery slices

1. **Generic host capability foundation:** versioned API-handler context,
   experience-state namespace, project-session operations, and scoped event /
   approval subscription plus `ExperienceWorker`, with SDK contract and
   authorization tests.
2. **Power Pack domain:** pack-owned task, proposal, run, and acceptance
   records; lifecycle service; scheduler; and focused transition/concurrency
   tests.
3. **Power Pack API and integration:** private experience API routes, generic
   host capability adapters, session template cloning, leases/concurrency
   policy, approval-event linking, and recovery tests.
4. **Kanban UI:** replace graph rendering with the three-lane board based on
   selected visual direction 2; implement task selection and all core
   stage-specific actions.
5. **Verification:** lifecycle race tests, scheduler recovery tests, generic
   host-contract compatibility tests, and browser-level parallel-task,
   approval, return-to-execution, and acceptance journeys.

## Non-goals

- Inferring project-task lifecycle from free-form chat.
- Treating general session-subtasks as project Kanban cards.
- Bypassing current high-risk tool approval policy during autopilot.
- Solving arbitrary concurrent filesystem merges in the first delivery.
- Replacing the existing generic activity graph or its consumers.
