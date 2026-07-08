// Verifies the Track B project-session endpoints (POST/GET /v1/projects/:id/sessions) create a
// real session bound to a project — over BOTH transports (TCP loopback + Unix socket), per the
// all-transports rule in AGENTS.md. Additive: does not touch the existing /workplace/projects/*
// or /projects/:id/messages behavior, which stays untouched by this slice.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createHttpTransport } from '@/transports/http.ts';
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
      ).json()) as { sessionId: string };
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

    test('creating a session for an unknown project 404s', async () => {
      const res = await json('POST', '/v1/projects/prj_01KWY9999999999999999999X/sessions', { title: 'x' });
      expect(res.status).toBe(404);
    });

    test('listing sessions for an unknown project 404s', async () => {
      const res = await t.fetch('/v1/projects/prj_01KWY9999999999999999999X/sessions');
      expect(res.status).toBe(404);
    });
  });
}
