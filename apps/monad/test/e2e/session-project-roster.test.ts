// GET /v1/sessions/:id/project-roster — proves the real HTTP dispatch (Elysia route,
// daemonHttpContract, buildHandlers) returns every ProjectMember of a session's project, not just
// this session's live bindings. Complements `session-members-handlers.test.ts`'s unit coverage of
// `listProjectRoster` by exercising the actual wire route over both transports.

import type { ProjectId, ProjectMemberId, SessionId } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { listProjectRosterResponseSchema } from '@monad/protocol';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

for (const kind of TRANSPORTS) {
  describe(`session project roster over ${kind}`, () => {
    let t: TransportHandle;
    let handlers: ReturnType<typeof buildHandlers>;

    beforeEach(() => {
      handlers = buildHandlers(mockModel(['ok']));
      t = serveTransport(kind, createHttpTransport(handlers));
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

    async function createProjectSession(): Promise<{ projectId: ProjectId; sessionId: SessionId }> {
      const { projectId } = (await (await json('POST', '/v1/workplace/projects', { title: 'roster e2e' })).json()) as {
        projectId: ProjectId;
      };
      const { sessionId } = (await (
        await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'roster e2e session' })
      ).json()) as { sessionId: SessionId };
      return { projectId, sessionId };
    }

    test('returns a project member never bound into this session, and matches the response schema', async () => {
      const { projectId, sessionId } = await createProjectSession();
      const otherSessionRes = await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'other session' });
      const { sessionId: otherSessionId } = (await otherSessionRes.json()) as { sessionId: SessionId };

      const at = new Date().toISOString();
      const memberId = 'pmem_rostere2emem01' as ProjectMemberId;
      handlers.store.insertProjectMember({
        id: memberId,
        projectId,
        profileId: 'codex',
        type: 'mesh-agent',
        displayName: 'Roster e2e member',
        customPrompt: null,
        launchOverrides: {},
        workingDirectoryOverride: null,
        lifecycle: 'enabled',
        createdAt: at,
        updatedAt: at
      });
      // Bound into the OTHER session, never into `sessionId`.
      handlers.store.insertSessionBinding({
        sessionId: otherSessionId,
        projectMemberId: memberId,
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        lifecycle: 'active',
        createdAt: at,
        updatedAt: at
      });

      const boundRes = await t.fetch(`/v1/sessions/${sessionId}/members`);
      expect(((await boundRes.json()) as { members: unknown[] }).members).toEqual([]);

      const rosterRes = await t.fetch(`/v1/sessions/${sessionId}/project-roster`);
      expect(rosterRes.status).toBe(200);
      const rosterBody = listProjectRosterResponseSchema.parse(await rosterRes.json());
      expect(rosterBody.members).toEqual([
        {
          id: memberId,
          projectId,
          profileId: 'codex',
          type: 'mesh-agent',
          displayName: 'Roster e2e member',
          customPrompt: null,
          launchOverrides: {},
          workingDirectoryOverride: null,
          lifecycle: 'enabled',
          createdAt: at,
          updatedAt: at
        }
      ]);
    });

    test('a session with no project returns an empty roster', async () => {
      const createRes = await json('POST', '/v1/sessions', { title: 'no-project session' });
      const { sessionId } = (await createRes.json()) as { sessionId: SessionId };

      const res = await t.fetch(`/v1/sessions/${sessionId}/project-roster`);
      expect(res.status).toBe(200);
      expect(listProjectRosterResponseSchema.parse(await res.json())).toEqual({ members: [] });
    });
  });
}
