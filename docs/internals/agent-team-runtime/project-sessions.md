---
title: "Projects, Members, and Session Bindings"
description: "Monad separates the collaboration environment from each conversation that happens inside it:"
---
Monad separates the collaboration environment from each conversation that happens
inside it:

```text
Third-party agent profile
        |
        v
Workplace Project -> ProjectMember -> SessionBinding -> native runtime session
        |
        +---------------------------> Session
```

## Project and session ownership

A Workplace Project owns the workspace root, project lifecycle, ordering, reusable
member configuration, and the durable Project Member roster. It is not a transcript.

A Session owns one conversation: messages, streams, approvals, deliveries, optional
Plan, and runtime participation. `Session.projectId` is absent for a standalone chat
and set for a project session. Both kinds use the same `ses_…` ID and the same
session APIs.

Project creation does not create an implicit session. Sessions are created and listed
explicitly under their project:

```text
POST /v1/projects/:id/sessions
GET  /v1/projects/:id/sessions
```

After creation, the normal flat session routes are authoritative:

```text
/v1/sessions/:sessionId/...
```

The web sidebar lists multiple sessions under a project and supports creating,
switching, archiving, and deleting them. The selected session, not the project, is the
transcript and routing target.

## Managed workspace scopes

Managed project agents use four collaboration scopes under the project's Monad data
directory. This directory is separate from `Session.cwd`, which remains the source
working directory used to launch the provider.

```text
<MONAD_HOME>/workplace/<projectId>/
├── shared/                              project-wide shared content
├── agents/<projectMemberId>/            one member across project sessions
├── sessions/<sessionId>/                all members in one session
└── runtime/<sessionId>/<projectMemberId>/
                                         one member in one session
```

The runtime receives the resolved absolute paths through these environment variables:

| Variable | Scope | Managed-agent access | Intended content |
|---|---|---|---|
| `MONAD_PROJECT_WORKSPACE` | Project namespace | Path discovery only; the project root is not added as one broad provider write root | Scope directories managed by Monad |
| `MONAD_SHARED_WORKSPACE` | Project | Every managed agent in every project session can read and write | Durable project knowledge and shared assets |
| `MONAD_AGENT_WORKSPACE` | Project Member | Only runtimes for that Project Member receive the path; it remains stable across sessions | Member-specific durable state |
| `MONAD_SESSION_WORKSPACE` | Session | Every managed agent bound to the session can read and write | Session documents and collaborative artifacts |
| `MONAD_RUNTIME_WORKSPACE` | Project Member + Session | Only that managed runtime receives the path | Private scratch, generated prompt, token, and provider state |

Monad passes the four concrete shared, agent, session, and runtime directories to the
provider adapter as additional working roots. It does not pass the containing project
directory as one broad root. The provider's sandbox is responsible for enforcing those
roots; host processes and users still have their normal operating-system access.

Use stable IDs in paths. `projectMemberId` keeps one member's agent workspace stable
across sessions, while `sessionId` makes a session workspace common to every bound
member. Display names and provider names are mutable and must not determine storage
identity.

The shared workspace owns `MEMORY.md` and `memories/`. Writers use `MEMORY.md.lock`
when updating that shared index or its detail files. Runtime tokens stay in the private
runtime workspace and are written with owner-only permissions where the platform
supports them.

### Experience-owned documents

An Experience may impose a narrower ownership rule than the filesystem. The Kanban
Experience stores its stage documents in the session scope:

```text
<MONAD_SESSION_WORKSPACE>/docs/kanban/<taskId>/product-design.md
<MONAD_SESSION_WORKSPACE>/docs/kanban/<taskId>/tech-design.md
```

All agents in the session can access that directory. Kanban nevertheless treats the
assigned host as the sole document maintainer: only a host-published attachment from
the task's canonical session path satisfies the stage requirement. This is an
Experience/API authorization rule, not a filesystem ACL.

## Identity versus participation

These records have separate lifetimes:

- **Profile** — reusable provider and launch defaults.
- **ProjectMember** — stable project-local identity: profile reference, display name,
  custom prompt, launch/working-directory overrides, and enabled/disabled lifecycle.
  Creating two members from one Profile creates two identities.
- **SessionBinding** — one Project Member's participation in one Session: delivery and
  visibility cursors, current native runtime reference, participation lifecycle, and
  last health.
- **Native runtime session** — replaceable provider execution state, process/session
  reference, working path, and reconnect metadata.

One Project Member may bind to several sessions. Each binding advances delivery
independently and may point at a different native runtime session. Replacing or
restarting one runtime does not change Project Member identity or another binding's
cursor.

The canonical wire view is `{ member, binding }` from
`sessionMemberBindingSchema`. Session member APIs include:

```text
GET    /v1/sessions/:id/members
GET    /v1/sessions/:id/project-roster
POST   /v1/sessions/:id/members                 (invite a template, or spawn an ad-hoc member)
PUT    /v1/sessions/:id/members/:memberId       (bind an existing Project Member)
DELETE /v1/sessions/:id/members/:memberId
```

The project roster includes disabled or currently unbound identities so historical
attribution and Plan assignees still resolve. The session member list contains active
bindings only.

## Compatibility member inputs

`WorkplaceProject.memberTemplates` and the legacy `session_members` storage remain as
compatibility/authoring inputs while the canonical runtime model is
`ProjectMember` plus `SessionBinding`. Inviting a template or spawning an ad-hoc member
must resolve to a durable project identity and a session-local binding; clients must
not invent a second session-member view model on the wire.

## Invariants

- Projects never receive chat messages directly.
- Every message, observation, delivery, approval, and Plan mutation is Session-scoped.
- Durable fanout creates Delivery records; it is not a hidden task scheduler.
- Provider/runtime identifiers never replace Project Member identity.
- Runtime recovery reconciles existing bindings and delivery cursors before sending
  more work.
- Profile, Project Member, Session Binding, and native runtime configuration are
  resolved in that order and frozen where required for audit/resume.

Code map:

| Contract or behavior | Source |
|---|---|
| `Session.projectId`, `OperationSource` | `packages/protocol/src/domain.ts` |
| Project create/list and compatibility templates | `packages/protocol/src/workplace-project.ts` |
| `ProjectMember` | `packages/protocol/src/mesh-agent/project-member.ts` |
| `SessionBinding` and joined member view | `packages/protocol/src/mesh-agent/session-binding.ts`, `session-member-binding.ts` |
| Tables and indexes | `apps/monad/src/store/db/schema.ts` |
| Project/session lifecycle | `apps/monad/src/handlers/session/handlers/lifecycle/` |
| Membership and binding handlers | `apps/monad/src/handlers/session/handlers/session-members.ts` |
| Managed workspace resolution and runtime environment | `apps/monad/src/services/mesh-agent/managed-project.ts` |
| Provider working-root grant | `apps/monad/src/services/mesh-agent/host/session-event-runtime-launcher.ts` |
