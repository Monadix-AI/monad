import type { AgentMessagePayload, AgentTokenPayload, Event } from '@monad/protocol';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

// E2E: the full HTTP + SSE stack against a deterministic mock model (no network), covering both
// generation interfaces and resume. Runs identically over TCP loopback AND the unix socket.

for (const kind of TRANSPORTS) {
  describe(`daemon over ${kind}`, () => {
    let t: TransportHandle;

    beforeAll(() => {
      // 30ms/token spacing keeps a streaming round in flight long enough to test resume.
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(['Hel', 'lo', ' ', 'wor', 'ld'], 30))));
    });

    afterAll(() => t.stop());

    async function createSession(title: string): Promise<string> {
      const res = await t.fetch('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title })
      });
      return ((await res.json()) as { sessionId: string }).sessionId;
    }

    function send(sessionId: string, text: string): Promise<Response> {
      return t.fetch(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text })
      });
    }

    test('GET /health via real HTTP', async () => {
      const res = await t.fetch('/health');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('ok');
    });

    test('GET /health includes upgrade info when the daemon monitor has a result', async () => {
      const withUpgrade = serveTransport(
        kind,
        createHttpTransport(
          buildHandlers(mockModel([]), undefined, {
            getUpgradeInfo: () => ({
              latestVersion: '9.9.9',
              latestVersionCheckedAt: '2026-07-01T00:00:00.000Z'
            })
          })
        )
      );
      try {
        const res = await withUpgrade.fetch('/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          status: 'ok',
          latestVersion: '9.9.9',
          latestVersionCheckedAt: '2026-07-01T00:00:00.000Z'
        });
      } finally {
        await withUpgrade.stop();
      }
    });

    test('loopback browser requests receive CORS headers on validation errors', async () => {
      const sessionId = await createSession('cors-validation');
      const res = await t.fetch(`/v1/sessions/${sessionId}/messages?limit=abc`, {
        headers: { origin: 'http://localhost:3000' }
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      expect(((await res.json()) as { code?: string }).code).toBe('VALIDATION');
    });

    test('GET /sessions/:id/ui-items accepts browser query strings', async () => {
      const sessionId = await createSession('ui-items-query');
      const res = await t.fetch(
        `/v1/sessions/${sessionId}/ui-items?limit=50&includeInactive=false&includeAncestors=false`,
        { headers: { origin: 'http://localhost:3000' } }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect((await res.json()) as { items: unknown[] }).toEqual({ items: [] });
    });

    test('streaming: SSE delivers ordered agent.token events then a final agent.message', async () => {
      const sessionId = await createSession('stream');

      // Subscribe first, then send, so we observe the whole round.
      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (e) => e.type === 'agent.message',
        timeoutMs: 3000
      });
      await Bun.sleep(50); // let the subscription attach
      await send(sessionId, 'hi');

      const events = await eventsP;
      const tokens = events.filter((e) => e.type === 'agent.token');
      const finals = events.filter((e) => e.type === 'agent.message');

      expect(tokens.length).toBeGreaterThan(0);
      // token deltas concatenate to the full reply, in order
      const text = tokens.map((e) => (e.payload as unknown as AgentTokenPayload).delta).join('');
      expect(text).toBe('Hello world');
      expect(tokens.map((e) => (e.payload as unknown as AgentTokenPayload).index)).toEqual(tokens.map((_e, i) => i));
      expect(finals).toHaveLength(1);
      expect((finals[0]?.payload as unknown as AgentMessagePayload).text).toBe('Hello world');
    });

    test('block: POST .../messages/block returns the full assistant message synchronously', async () => {
      const sessionId = await createSession('block');
      const res = await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' })
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { message: { role: string; text: string } };
      expect(body.message.role).toBe('assistant');
      expect(body.message.text).toBe('Hello world');
    });

    test('resume: reconnecting with Last-Event-ID delivers the final message without duplicating seen events', async () => {
      const sessionId = await createSession('resume');

      // Reader A: attach, send, then bail out after the 2nd token (mid-stream).
      const firstLeg = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (e) => e.type === 'agent.token' && (e.payload as unknown as AgentTokenPayload).index === 1,
        timeoutMs: 3000
      });
      await Bun.sleep(50);
      await send(sessionId, 'hi');
      const seenA = await firstLeg;
      const cursor = seenA[seenA.length - 1]?.id;
      expect(cursor).toBeDefined();

      // Reader B: resume from the cursor; must reach the final agent.message.
      const seenB = await t.sse(`/v1/sessions/${sessionId}/events`, {
        headers: { 'Last-Event-ID': cursor as string },
        until: (e) => e.type === 'agent.message',
        timeoutMs: 3000
      });

      // The terminal message is always delivered on resume, carrying the full text…
      const finalB = seenB.find((e) => e.type === 'agent.message') as Event | undefined;
      expect(finalB).toBeDefined();
      expect((finalB?.payload as unknown as AgentMessagePayload).text).toBe('Hello world');

      // …and token deltas are never gapped or duplicated across the reconnect: B's tokens
      // are exactly the ones A had not yet seen (resumed from the hot buffer), or none at
      // all (round already finished → recovered via the terminal message). Either way the
      // token streams are disjoint and together prefix the full reply.
      const tokenIndex = (e: Event) => (e.payload as unknown as AgentTokenPayload).index;
      const aTokens = seenA.filter((e) => e.type === 'agent.token').map(tokenIndex);
      const bTokens = seenB.filter((e) => e.type === 'agent.token').map(tokenIndex);
      expect(aTokens).toEqual([0, 1]);
      expect(bTokens.some((i) => aTokens.includes(i))).toBe(false); // no duplicate tokens
      // contiguous: A's tokens then B's tokens form a gap-free prefix 0,1,2,…
      expect([...aTokens, ...bTokens]).toEqual(aTokens.concat(bTokens).map((_v, i) => i));
    });

    test('POST /sessions/:id/reset clears messages, returns clearedCount, keeps the session', async () => {
      const sessionId = await createSession('reset-me');

      // Send a blocking round so there are messages to clear.
      await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' })
      });

      // Confirm messages exist before reset.
      const before = await t.fetch(`/v1/sessions/${sessionId}/messages`);
      const { messages: beforeMsgs } = (await before.json()) as { messages: unknown[] };
      expect(beforeMsgs.length).toBeGreaterThan(0);

      // Reset: clear all messages + events.
      const res = await t.fetch(`/v1/sessions/${sessionId}/reset`, { method: 'POST' });
      expect(res.status).toBe(200);
      const { clearedCount } = (await res.json()) as { clearedCount: number };
      expect(clearedCount).toBeGreaterThan(0);

      // Session still exists but has no messages.
      const after = await t.fetch(`/v1/sessions/${sessionId}/messages`);
      const { messages: afterMsgs } = (await after.json()) as { messages: unknown[] };
      expect(afterMsgs).toHaveLength(0);
    });
  });
}
