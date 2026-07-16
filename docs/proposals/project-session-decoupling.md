# Track B: project ↔ session decoupling

Status: **implemented** — P6/P7 shipped to `main` (`session_members` store layer `271cf0698`, wire schemas `0d24c6c21`, session creation under a project `43ac097be`, id-union collapse to SessionId `2d7b2f03b`/`0d7446b0a`, member-roster materialization `127999a28`, member templates + per-session invite/spawn `d904c8135`). Companion to
[agent-observation-implementation-order.md](agent-observation-implementation-order.md) (Track B was
sketched there as P6/P7; this is the full proposal that sketch called for).

## Problem

`WorkplaceProject` and `Session` are two independently-evolved tables that both mean "a conversation
plus its metadata," duplicated almost field-for-field:

```
sessions            workplace_projects
------------------  ------------------
id                  id
title               title
state               state
archived            archived
model               model
cwd                 cwd
origin              origin
createdAt           createdAt
updatedAt           updatedAt
```

(`sessions` additionally carries `agentIds`, `restoreCount`,
and usage/cost columns — a project has none of that.)

The REST surface mirrors the duplication one-for-one: `/sessions/:id/*` and `/projects/:id/*` each
implement `messages`, `events`, `ui-items`, `ui-stream`, `external-agent-sessions`, `workspace-action`,
`workspace-meta`, `abort`, `reset` — separately, twice. `messages.transcriptTargetId` is *already*
polymorphic (`ses_… | prj_…`, typed as `TranscriptTarget = Session | WorkplaceProject` in
`packages/protocol/src/workplace-project.ts`), and several daemon handlers already branch
`store.updateSession(id, …) ?? store.updateWorkplaceProject(id, …)` — the two concepts are already
being treated as "the same thing, different table" ad hoc, without a real unification.

The conflation this proposal fixes: **a project is being used as its own single, implicit conversation.**
That's the wrong shape once a project needs more than one conversation (parallel workstreams, one thread
per feature, a scratch session vs. the main room) — today that's structurally impossible without another
full parallel table.

## Target model

- **Project = environment.** cwd, config, member roster capability, workspace lifecycle. No transcript
  of its own.
- **Session = a conversation instance.** Binds members (0 for a plain chat session; N for a project
  session). One `sessions` table serves both kinds:

```ts
sessions: {
  id: SessionId,              // single ses_… prefix for both kinds — see "id scheme" below
  projectId: ProjectId | null, // null = chat session; set = project session
  title, state, archived, model, cwd, origin,
  agentIds, restoreCount,
  inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, costUsd,
  createdAt, updatedAt
}
session_members: {            // empty for a plain chat session
  sessionId: SessionId,
  memberId: string,           // matches today's WorkplaceProjectMemberView.id shape
  ...(today's per-member fields: type, name, templateName, displayName, instanceId, settings, ...)
}
```

`workplace_projects` shrinks to pure environment state: `id, title, cwd, config,
memberTemplates, createdAt, updatedAt` — no `state`/`archived`/`origin`/`model`, since those are
per-*session* now, not per-project. (Exact leftover column list beyond `memberTemplates` — see below —
is a P6 implementation detail, not a proposal blocker.)

### Where the member roster actually lives today (traced, not assumed)

`WorkplaceProjectMemberView` (`packages/protocol/src/external-agent/external-agent-workplace.ts`) has no
backing column in `workplace_projects` and `workplaceProjectSchema` carries no `members` field — traced
the real write path (`apps/web/features/workplace/use-project-actions.ts`'s `updateProjectMembers`) and
it's stashed inside **`workplace_projects.origin.ext[workplaceProjectMembersExtKey]`** — the generic,
untrusted, size-bounded (`≤32 keys, ≤4KB serialized` per `docs/engineering/security-guidelines.md`) client extension
bag meant for small ad-hoc metadata, not a growing roster. This is real technical debt Track B fixes:
today's "roster" is really the single implicit session's member *bindings*, misfiled as project metadata
because project and session were never actually separate. It moves to two real, purpose-built places —
see the resolved member-model decision below.

### Resolved decisions

1. **Id scheme: (a) single `ses_…` prefix for every session, chat or project.** `TranscriptTargetId`
   collapses to just `SessionId`; the `ses_ | prj_` branching throughout daemon/client/web deletes
   outright. `ProjectId` (`prj_…`) still exists — it's the id of the *project* (environment), just no
   longer also the id of its conversation.
2. **No deprecation aliases.** Old `/projects/:id/*` routes are cut over immediately, not kept as an
   alias layer — matches the P0 rename precedent (pre-1.0, `~/.monad` state is disposable).
3. **No auto-created implicit session on project creation.** Creating a project yields zero sessions; the
   user (or an invite/spawn action) creates the first one explicitly. This means **P6 cannot ship as a
   silent, zero-UX-change plumbing swap** — a project with no sessions has nothing to look at, so P6 must
   land with at minimum a bare "create a session" entry point even though the full tab-strip experience
   is P7's job. See the revised P6 scope below.
   - **Migration backfill is a separate concern from this decision.** Existing `workplace_projects` rows
     (which today already have a live conversation, just conflated with the project row) get exactly one
     backfilled session carrying over their history and member bindings — that's data preservation, not
     "auto-create," and happens once during the P6 migration regardless of decision 3.
4. **Member model: project-level roster is a template/catalog, not a binding.** Two distinct pieces:
   - **Project-level `memberTemplates`** (new, on `workplace_projects`): named presets an operator
     configures once per project — agent name, default model/settings, display name pattern. Pure
     config; never itself running anything.
   - **Session-level `session_members`** (the real, live bindings): a session invites a member either
     *from* a project template (seeding its settings) or spawns one ad hoc with no template link at all.
     **Each session's binding is its own distinct external-agent session** — inviting "the same" template
     member into two sessions under one project starts two independent external-agent processes/sessions,
     never a shared one. `session_members` rows therefore need: `sessionId`, `memberId`,
     `templateId?` (nullable — set when invited from a template, absent for ad-hoc), the per-member
     runtime fields already on today's `WorkplaceProjectMemberView` (type, name, displayName, settings,
     …), and the bound `externalAgentSessionId` once it's running.

## Endpoint scheme (already resolved per the earlier discussion)

- **Create/list — scoped under the owner:**
  `POST/GET /agents/:agentId/sessions` (chat sessions), `POST/GET /projects/:projectId/sessions` (project
  sessions).
- **Access — flat, by the session's own id** (not nested under project/agent, so a session URL is stable
  even if you don't know its parent):
  `GET/POST /sessions/:sid/{messages,ui-items}`, `GET /sessions/:sid/{stream,ui-stream}`.
- **Per-agent observation planes — one level under the session** (P3's shape, unaffected by Track B
  except for the outer key changing from `prj_…`/`ses_…` ambiguity to a single session id):
  `GET /sessions/:sid/agents/:agentId/{stream,ui-stream}`.
- Old `/projects/:id/*` routes: **removed outright, no deprecation alias** (resolved decision 2).

## Migration phases

### P6 — Session as a first-class entity under project, with a minimal session-creation path

Decision 3 (no auto-created session) means P6 is no longer a silent plumbing swap — it must leave a
project usable, which means it carries a slice of what was sketched as "P7 UI." Split into sub-phases so
each still ships green on its own:

**P6a — Store + protocol foundation**
1. Store migration: `sessions.projectId` (nullable), `session_members` table, `workplace_projects.
   memberTemplates` column. Backfill: one session per existing `workplace_projects` row, `projectId` set,
   carrying over today's `origin.ext` roster into `session_members` (all becoming ad-hoc — no template
   link, since there's no template concept yet to link back to). Drop the redundant project-level state
   columns once backfill is verified.
2. Protocol: collapse `TranscriptTarget = Session | WorkplaceProject`, single `ses_…` id (decision 1).
   `WorkplaceProject` shrinks to the environment-only shape; new `WorkplaceProjectMemberTemplate` type.
- **Ships green:** every existing project has exactly one backfilled session; old routes still work
  against the new schema (adapter layer, not yet removed). **Size:** large.

**P6b — Daemon + client cutover**
1. Daemon: merge the two handler trees (`handlers/session/*` absorbs project-session behavior;
   `lifecycle-projects.ts` keeps only environment lifecycle — cwd, workspace, member templates CRUD).
   New session lifecycle handlers (`create`/`list` under `/projects/:id/sessions`); member-invite/spawn
   handlers write `session_members`, each producing its own `externalAgentSessionId` per decision 4.
2. Remove `/projects/:id/*` outright (decision 2) — no alias layer.
3. Client + web: `@monad/client-rtk` endpoints collapse the two query/mutation families into one;
   `apps/web`'s project-shell moves from "the project IS the session" to "the project HAS sessions,"
   with the **minimal** UI this phase owes: a "create session" entry point when a project has zero
   sessions, and — once one exists — the shell simply opens it (no tab strip yet; that's P7).
- **Depends:** P6a. **Ships green:** a project is fully usable end-to-end again (create → one session →
  invite members from a template or ad hoc), just without multi-session switching. **Size:** large.

### P7 — Multi-session lifecycle + UI

1. **Lifecycle**: `create` / `delete` / `archive` for *additional* sessions under a project (P6b already
   built single-session creation; P7 makes it repeatable and adds delete/archive).
2. **UI**: the session-tab strip in the project shell (per-session tab, switch/create/close) — this is
   the actual "project session tab" feature the earlier gap check was asking about. Member management
   surfaces per-session (invite from a project template or spawn ad hoc) alongside project-level template
   management (project settings).
- **Depends:** P6b. **Ships green:** additive over P6 — a project with exactly one session degrades to
  P6b's single-session UI. **Size:** large (daemon lifecycle + web UI).

## Non-goals (explicitly out of scope for Track B)

- Anything ACP-related — ACP agents are sub-agents the Monad agent calls, never a first-class project
  session member (confirmed earlier in the observation-architecture work).
- P5 (generalizing *observation* to Monad-builtin/ACP agents) — depends on Track B's stable `agentId`
  per session, but is Track A's tail, not part of this proposal. Comes after P6 lands.
