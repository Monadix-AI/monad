import { z } from 'zod';

import { projectMemberIdSchema, sessionIdSchema } from '../ids.ts';
import { projectMemberSchema } from './project-member.ts';
import { sessionBindingSchema } from './session-binding.ts';

// The canonical daemon-facing member view: durable identity (ProjectMember) joined with this
// session's binding (cursors, runtime, lifecycle). It is the only session-member wire shape — the
// daemon returns identity + binding only, and any UI view-model is composed from this in the client
// layer, never pushed back down here.
export const sessionMemberBindingSchema = z
  .object({ member: projectMemberSchema, binding: sessionBindingSchema })
  .strict();
export type SessionMemberBinding = z.infer<typeof sessionMemberBindingSchema>;

// PUT /v1/sessions/:sessionId/members/:projectMemberId — bind an existing project member into a
// session. Path params are the truth (no body). Idempotent on an ACTIVE binding: re-binding returns
// the existing binding unchanged. A binding that has LEFT is a stable conflict — the PUT does not
// silently reactivate it (cursor, createdAt, and runtime stay untouched); rejoining requires a
// future explicit lifecycle transition, not a re-bind.
export const bindSessionMemberRequestSchema = z
  .object({ sessionId: sessionIdSchema, projectMemberId: projectMemberIdSchema })
  .strict();
export type BindSessionMemberRequest = z.infer<typeof bindSessionMemberRequestSchema>;

// The response is the joined view itself — a flat { member, binding }, never wrapped a second time.
export const bindSessionMemberResponseSchema = sessionMemberBindingSchema;
export type BindSessionMemberResponse = SessionMemberBinding;

// Canonical list contract: the joined `{ member, binding }` per active member. Left bindings are
// excluded by the daemon, so the array is the live roster. Lives here (not with the workplace
// schemas) so the response contracts stay below the member/binding schemas without a cycle.
export const listSessionMembersResponseSchema = z.object({ members: z.array(sessionMemberBindingSchema) });
export type ListSessionMembersResponse = z.infer<typeof listSessionMembersResponseSchema>;

// Invite and spawn return the same canonical joined view as bind — one `{ member, binding }` shape
// across every member-producing endpoint.
export const sessionMemberResponseSchema = sessionMemberBindingSchema;
export type SessionMemberResponse = SessionMemberBinding;

// GET /v1/sessions/:id/project-roster — every ProjectMember of the session's project, regardless of
// whether they're currently bound into THIS session. Distinct from `listSessionMembersResponseSchema`
// (active bindings only): an assignee target (e.g. a SessionPlan todo) can be any enabled member of
// the project per the daemon's own assignment validation, and resolving a display name for an
// already-assigned member who has since left the session (or been disabled) needs the full roster,
// not just the live binding set. Includes disabled members so a UI can still resolve their name —
// callers that need "assignable now" filter on `lifecycle === 'enabled'` themselves.
export const listProjectRosterResponseSchema = z.object({ members: z.array(projectMemberSchema) });
export type ListProjectRosterResponse = z.infer<typeof listProjectRosterResponseSchema>;
