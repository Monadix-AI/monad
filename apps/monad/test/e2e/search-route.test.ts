// Verifies the static GET /v1/sessions/search route resolves (not captured by /sessions/:id)
// and returns keyword hits end-to-end — over BOTH transports (TCP loopback + Unix socket), per
// the all-transports rule in AGENTS.md.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

for (const kind of TRANSPORTS) {
  describe(`session search over ${kind}`, () => {
    let t: TransportHandle;

    beforeEach(() => {
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(['the answer is 42']))));
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

    test('GET /v1/sessions/search resolves the static route and returns keyword hits', async () => {
      const { sessionId } = (await (await json('POST', '/v1/sessions', { title: 'search route' })).json()) as {
        sessionId: string;
      };
      // a block turn persists the user + assistant messages
      await json('POST', `/v1/sessions/${sessionId}/messages/block`, { text: 'what is the answer' });

      const res = await t.fetch(`/v1/sessions/search?q=${encodeURIComponent('answer')}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hits: { sessionId: string }[]; indexingPending?: number };
      expect(body.hits.some((h) => h.sessionId === sessionId)).toBe(true);
      // no embedding model configured here ⇒ keyword path, no indexing-pending hint
      expect(body.indexingPending).toBeUndefined();
    });

    test('GET /v1/sessions/search accepts a project session scope', async () => {
      const { projectId } = (await (
        await json('POST', '/v1/workplace/projects', { title: 'project search route' })
      ).json()) as {
        projectId: string;
      };
      const { sessionId } = (await (
        await json('POST', `/v1/projects/${projectId}/sessions`, { title: 'project search session' })
      ).json()) as { sessionId: string };
      await json('POST', `/v1/sessions/${sessionId}/messages/block`, { text: 'project transcript contains bananas' });

      const params = new URLSearchParams({ q: 'bananas', sessionId });
      const res = await t.fetch(`/v1/sessions/search?${params}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        hits: { sessionId: string; transcriptTargetTitle: string }[];
      };
      expect(body.hits).toHaveLength(1);
      expect(body.hits[0]).toMatchObject({
        sessionId,
        transcriptTargetTitle: 'project search session'
      });
    });
  });
}
