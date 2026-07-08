// Live E2E: routing resilience and robustness edge cases against a real provider — model fallback
// failover, graceful surfacing of an unresolvable model, per-session isolation, and a non-ASCII
// (CJK) round-trip. Things only a real provider can prove: the mock model never fails over or errors.
//
// Opt-in: skips unless OPENROUTER_API_KEY is set. Assertions check structural facts (a real reply
// landed, an agent.error fired, the daemon stayed healthy, sessions didn't cross-contaminate), with
// a retry on the model-dependent ones.
//   OPENROUTER_API_KEY=sk-or-... bun test apps/monad/test/e2e/live-resilience.test.ts

import type { Event } from '@monad/protocol';

import { afterEach, describe, expect, test } from 'bun:test';

import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  liveModelDeps,
  serveTransport,
  TRANSPORTS,
  type TransportHandle,
  type TransportKind
} from '../helpers.ts';

type LiveBuild = ReturnType<typeof liveModelDeps>;

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MONAD_LIVE_MODEL ?? 'openrouter/free';
const TIMEOUT = 120_000;
const BOGUS_MODEL = 'monad-nonexistent-model-zzz-000';

describe.skipIf(!KEY)(`live model resilience (${MODEL})`, () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  function serve(kind: TransportKind, built: LiveBuild): TransportHandle {
    const t = serveTransport(
      kind,
      createHttpTransport(buildHandlers(built.router, built.deps, { defaultModel: 'default' }))
    );
    cleanups.push(() => t.stop());
    return t;
  }

  function createSession(t: TransportHandle, title: string): Promise<string> {
    return t
      .fetch('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title })
      })
      .then((r) => r.json() as Promise<{ sessionId: string }>)
      .then((j) => j.sessionId);
  }

  function blockRound(t: TransportHandle, sid: string, text: string): Promise<string> {
    return t
      .fetch(`/v1/sessions/${sid}/messages/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text })
      })
      .then((r) => r.json() as Promise<{ message: { text: string } }>)
      .then((j) => j.message.text);
  }

  function runStream(t: TransportHandle, sid: string, text: string, until: (e: Event) => boolean): Promise<Event[]> {
    const eventsP = t.sse(`/v1/sessions/${sid}/events`, { until, timeoutMs: TIMEOUT });
    return Bun.sleep(50)
      .then(() =>
        t.fetch(`/v1/sessions/${sid}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text })
        })
      )
      .then(() => eventsP);
  }

  // ── Routing-layer tests: transport-agnostic (the failover happens in GatewayModelRouter, below the
  // transport), so they run once over TCP rather than doubling real-model calls across both. ──
  describe('routing (tcp)', () => {
    test(
      'fallback: a broken primary model fails over to a working fallback',
      async () => {
        const built = liveModelDeps(KEY as string, BOGUS_MODEL, {
          fallbacks: [{ provider: 'openrouter', modelId: MODEL }]
        });
        const t = serve('tcp', built);
        const sid = await createSession(t, 'fallback');
        const reply = await blockRound(t, sid, 'Reply with exactly: FALLBACKOK');
        expect(reply.trim().length).toBeGreaterThan(0); // the fallback produced a real reply
      },
      { timeout: TIMEOUT, retry: 2 }
    );

    test(
      'invalid model: an unresolvable model surfaces agent.error and the daemon stays healthy',
      async () => {
        const built = liveModelDeps(KEY as string, BOGUS_MODEL); // no fallback → the chain is exhausted
        const t = serve('tcp', built);
        const sid = await createSession(t, 'invalid-model');
        const events = await runStream(
          t,
          sid,
          'Say hello.',
          (e) => e.type === 'agent.error' || e.type === 'agent.message'
        );
        expect(events.some((e) => e.type === 'agent.error')).toBe(true); // error surfaced, not swallowed
        const health = (await (await t.fetch('/health')).json()) as { status: string };
        expect(health.status).toBe('ok'); // a model failure doesn't take the daemon down
      },
      { timeout: TIMEOUT, retry: 2 }
    );
  });

  for (const kind of TRANSPORTS) {
    describe(`over ${kind}`, () => {
      test(
        'isolation: two sessions on one daemon keep separate histories',
        async () => {
          const built = liveModelDeps(KEY as string, MODEL);
          const t = serve(kind, built);
          const a = await createSession(t, 'iso-a');
          const b = await createSession(t, 'iso-b');
          await blockRound(t, a, 'Remember my secret color is RED. Reply with just OK.');
          await blockRound(t, b, 'Remember my secret color is BLUE. Reply with just OK.');
          const replyA = await blockRound(t, a, 'What secret color did I tell you? Reply with only the color.');
          const replyB = await blockRound(t, b, 'What secret color did I tell you? Reply with only the color.');
          // The real isolation guarantee is the absence of cross-talk: neither session's reply may
          // contain the OTHER session's secret. Asserting only the negatives keeps this robust to the
          // free router occasionally returning an off-topic/empty reply — cross-contamination (the bug
          // this guards) is exactly what would make a negative fail. Exact recall is covered by the
          // multi-turn test in live-scenarios, which doesn't need cross-session guarantees.
          expect(replyA.toUpperCase()).not.toContain('BLUE'); // session A never saw B's secret
          expect(replyB.toUpperCase()).not.toContain('RED'); // session B never saw A's secret
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'unicode: a non-ASCII (CJK) prompt round-trips through the pipe without corruption',
        async () => {
          const built = liveModelDeps(KEY as string, MODEL);
          const t = serve(kind, built);
          const sid = await createSession(t, 'unicode');
          const cjk = '法国的首都是哪座城市？请用中文或英文回答。🗼';
          const events = await runStream(t, sid, cjk, (e) => e.type === 'agent.message' || e.type === 'agent.error');
          // Deterministic: the echoed user.message must equal the input byte-for-byte — proof the CJK
          // (+ emoji) survived POST → store → SSE intact. (We don't assert the model's ANSWER: the
          // free router's reply quality is non-deterministic; the pipe's encoding is what's tested.)
          const echoed = events.find((e) => e.type === 'user.message');
          expect((echoed?.payload as { text: string }).text).toBe(cjk);
          expect(events.some((e) => e.type === 'agent.message')).toBe(true); // the round completed, not errored
        },
        { timeout: TIMEOUT, retry: 2 }
      );
    });
  }
});
