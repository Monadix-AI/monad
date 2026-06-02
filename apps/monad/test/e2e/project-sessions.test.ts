// Verifies the Track B project-session endpoints (POST/GET /v1/projects/:id/sessions) create a
// real session bound to a project — over BOTH transports (TCP loopback + Unix socket), per the
// all-transports rule in AGENTS.md. Additive: does not touch the existing /workplace/projects/*
// or /projects/:id/messages behavior, which stays untouched by this slice.

import type { SessionId } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { listSessionMembersResponseSchema } from '@monad/protocol';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

for (const kind of TRANSPORTS) {
  describe(`project sessions over ${kind}`, () => {
    let t: TransportHandle;

    beforeEach(() => {
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(['ok']))));
    });
    afterEach(async () => {
      await t.stop();
    });

    const json = (method: string, path: string, body?: unknown) =>
      t.fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    test('a fresh project has zero sessions — no default is auto-created', async () => {
      const { projectId } = (await (await json('POST', '/v1/workplace/projects', { title: 'p1' })).json()) as {
        projectId: string;
      };
      const res = await t.fetch(`/v1/projects/${projectId}/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: unknown[] };
      expect(body.sessions).toEqual([]);
    });

    test('project cwd remains immutable after creation', async () => {
      const initialCwd = process.cwd();
      const { projectId } = (await (
        await json('POST', '/v1/workplace/projects', { title: 'immutable cwd', cwd: initialCwd })
      ).json()) as { projectId: string };

      const update = await json('PATCH', `/v1/workplace/projects/${projectId}`, { cwd: '/tmp' });
      const project = (await (await t.fetch(`/v1/workplace/projects/${projectId}`)).json()) as {
        project: { cwd?: string; title: string };
      };

      expect(update.status).toBe(200);
      expect(project).toEqual({ project: expect.objectContaining({ cwd: initialCwd, title: 'immutable cwd' }) });
    });

    test('POST creates a session bound to the project, distinct from a plain chat session', async () => {
      const { projectId } = (await (await json('POST', '/v1/workplace/projects', { title: 'p2' })).json()) as {
        projectId: string;
      };
      const createRes = await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'first session' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };
      expect(sessionId.startsWith('ses_')).toBe(true);

      const listRes = await t.fetch(`/v1/projects/${projectId}/sessions`);
      const listed = (await listRes.json()) as { sessions: { id: string; projectId?: string; title: string }[] };
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]).toMatchObject({ id: sessionId, projectId, title: 'first session' });

      // A plain chat session (no project) is unaffected — it never shows up in the project's list.
      const { sessionId: chatSessionId } = (await (
        await json('POST', '/v1/sessions', { title: 'unrelated chat session' })
      ).json()) as { sessionId: SessionId };
      const listAfter = (await (await t.fetch(`/v1/projects/${projectId}/sessions`)).json()) as {
        sessions: { id: string }[];
      };
      expect(listAfter.sessions.map((s) => s.id)).not.toContain(chatSessionId);
    });

    test('a project can hold more than one session', async () => {
      const { projectId } = (await (await json('POST', '/v1/workplace/projects', { title: 'p3' })).json()) as {
        projectId: string;
      };
      await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'session a' });
      await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'session b' });

      const res = await t.fetch(`/v1/projects/${projectId}/sessions`);
      const body = (await res.json()) as { sessions: { title: string }[] };
      expect(body.sessions.map((s) => s.title).sort()).toEqual(['session a', 'session b']);
    });

    test('DELETE tears down every project session and preserves unrelated sessions', async () => {
      const { projectId } = (await (await json('POST', '/v1/workplace/projects', { title: 'delete me' })).json()) as {
        projectId: string;
      };
      const { sessionId: first } = (await (
        await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'first' })
      ).json()) as { sessionId: SessionId };
      const { sessionId: second } = (await (
        await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'second' })
      ).json()) as { sessionId: SessionId };
      const { sessionId: unrelated } = (await (await json('POST', '/v1/sessions', { title: 'keep me' })).json()) as {
        sessionId: SessionId;
      };

      const response = await json('DELETE', `/v1/workplace/projects/${projectId}`);

      expect(response.status).toBe(200);
      expect({
        project: (await t.fetch(`/v1/workplace/projects/${projectId}`)).status,
        first: (await t.fetch(`/v1/sessions/${first}`)).status,
        second: (await t.fetch(`/v1/sessions/${second}`)).status,
        unrelated: (await t.fetch(`/v1/sessions/${unrelated}`)).status
      }).toEqual({ project: 404, first: 404, second: 404, unrelated: 200 });
    });

    test('project member updates leave the active session roster unchanged', async () => {
      const { projectId } = (await (await json('POST', '/v1/workplace/projects', { title: 'member sync' })).json()) as {
        projectId: string;
      };
      await json('PATCH', `/v1/workplace/projects/${projectId}`, {
        memberTemplates: [
          {
            id: 'pmem_fable',
            type: 'mesh-agent',
            name: 'claude-code',
            displayName: 'Fable',
            settings: { managedProjectAgent: true, modelId: 'fable' }
          }
        ]
      });
      const { sessionId } = (await (
        await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'active session' })
      ).json()) as { sessionId: SessionId };

      const update = await json('PATCH', `/v1/workplace/projects/${projectId}`, {
        memberTemplates: [
          {
            id: 'pmem_opus',
            type: 'mesh-agent',
            name: 'claude-code',
            displayName: 'Opus',
            settings: { managedProjectAgent: true, modelId: 'opus' }
          }
        ]
      });
      const members = await t.fetch(`/v1/sessions/${sessionId}/members`);

      expect(update.status).toBe(200);
      expect(members.status).toBe(200);
      // Strict-parse the raw JSON: sessionMemberBindingSchema is `.strict()`, so this fails if the wire
      // ever leaks a legacy extra (name/agentSession/meshSessionId) alongside the canonical { member, binding }.
      const memberBody = listSessionMembersResponseSchema.parse(await members.json());
      expect(memberBody.members).toHaveLength(1);
      const entry = memberBody.members[0];
      if (!entry) throw new Error('expected one active session member');
      expect(entry.member.id).toMatch(/^pmem_/);
      expect({
        belongsToProject: entry.member.projectId === projectId,
        profileId: entry.member.profileId,
        type: entry.member.type,
        displayName: entry.member.displayName,
        customPrompt: entry.member.customPrompt,
        launchOverrides: entry.member.launchOverrides,
        workingDirectoryOverride: entry.member.workingDirectoryOverride,
        lifecycle: entry.member.lifecycle
      }).toEqual({
        belongsToProject: true,
        profileId: 'pmem_fable',
        type: 'mesh-agent',
        displayName: 'Fable',
        customPrompt: null,
        launchOverrides: { managedProjectAgent: true, modelId: 'fable' },
        workingDirectoryOverride: null,
        lifecycle: 'enabled'
      });
      expect({
        boundToOwnMember: entry.binding.projectMemberId === entry.member.id,
        sessionId: entry.binding.sessionId,
        lastDeliveredSeq: entry.binding.lastDeliveredSeq,
        lastVisibleSeq: entry.binding.lastVisibleSeq,
        lifecycle: entry.binding.lifecycle
      }).toEqual({
        boundToOwnMember: true,
        sessionId,
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        lifecycle: 'active'
      });
    });

    test('automatic project-member invites can be disabled for newly created sessions', async () => {
      const { projectId } = (await (
        await json('POST', '/v1/workplace/projects', { title: 'manual roster' })
      ).json()) as {
        projectId: string;
      };
      const update = await json('PATCH', `/v1/workplace/projects/${projectId}`, {
        autoInviteProjectMembers: false,
        memberTemplates: [{ id: 'pmem_codex', type: 'mesh-agent', name: 'codex', displayName: 'Reviewer' }]
      });
      const { sessionId } = (await (
        await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'empty session' })
      ).json()) as { sessionId: SessionId };
      const members = listSessionMembersResponseSchema.parse(
        await (await t.fetch(`/v1/sessions/${sessionId}/members`)).json()
      );

      expect({
        autoInviteProjectMembers: ((await update.json()) as { project: { autoInviteProjectMembers: boolean } }).project
          .autoInviteProjectMembers,
        members: members.members
      }).toEqual({ autoInviteProjectMembers: false, members: [] });
    });

    test('creating a session for an unknown project 404s', async () => {
      const res = await json('POST', '/v1/projects/prj_ZZZZZZZZZZZZ/sessions', { title: 'x' });
      expect(res.status).toBe(404);
    });

    test('listing sessions for an unknown project 404s', async () => {
      const res = await t.fetch('/v1/projects/prj_ZZZZZZZZZZZZ/sessions');
      expect(res.status).toBe(404);
    });
  });
}
