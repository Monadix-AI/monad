// Live E2E: the full HTTP + SSE stack driven against a REAL model provider (OpenRouter's free
// router by default), asserted with bun:test. This is the network-bound complement to the mock
// suites — it exercises what a deterministic mock cannot: real inference, token streaming, and the
// native function-calling tool loop, over BOTH transports the daemon serves (TCP + unix).
//
// Opt-in: the whole suite skips unless OPENROUTER_API_KEY is set, so the offline mock gate (CI,
// plain `bun test`) is unaffected. Run it explicitly:
//   OPENROUTER_API_KEY=sk-or-... bun test apps/monad/test/e2e/live-model.test.ts
//
// Non-deterministic by nature — a free model can rate-limit (429) or vary wording. Assertions check
// SHAPE (non-empty reply, ordered token deltas, a tool.called event), never exact text. Keep this a
// nightly / manual job, not a PR gate (that stays with the mock e2e).

import type { Event } from '@monad/protocol';
import type { Tool } from '#/capabilities/tools/types.ts';

import { beforeAll, describe, expect, test } from 'bun:test';
import { parseEventPayload } from '@monad/protocol';
import { z } from 'zod';

import { toolResult } from '#/capabilities/tools/types.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, liveModelDeps, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MONAD_LIVE_MODEL ?? 'openrouter/free';
const TIMEOUT = 120_000;

// A trivial tool with an observable side effect — proves the model → tool-call → execution loop.
const calls: { marker: string }[] = [];
const markerTool: Tool<{ marker: string }, { ok: true }> = {
  name: 'record_marker',
  description: 'Record a marker string. Call this with marker set to the value the user asks for.',
  scopes: [{ resource: 'memory' }],
  inputSchema: z.object({ marker: z.string() }),
  run: async ({ marker }) => {
    calls.push({ marker });
    return toolResult({ ok: true });
  }
};

describe.skipIf(!KEY)(`live model (${MODEL})`, () => {
  for (const kind of TRANSPORTS) {
    describe(`over ${kind}`, () => {
      let t: TransportHandle;

      beforeAll(() => {
        const { router, deps } = liveModelDeps(KEY as string, MODEL);
        t = serveTransport(
          kind,
          createHttpTransport(buildHandlers(router, deps, { tools: [markerTool as Tool], defaultModel: 'default' }))
        );
      });

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

      test('GET /health', async () => {
        const res = await t.fetch('/health');
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe('ok');
      });

      test(
        'block: a real, non-empty assistant reply',
        async () => {
          const sessionId = await createSession('live-block');
          const res = await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'In one short sentence, what is 17 multiplied by 4? Include the number.' })
          });
          const { message } = (await res.json()) as { message: { text: string; role: string } };
          expect(message.role).toBe('assistant');
          expect(message.text.trim().length).toBeGreaterThan(0);
        },
        // retry absorbs transient free-model flakiness (429s, an empty/just-reasoning turn, an
        // occasional ignored tool instruction) without weakening the assertions.
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'streaming: ordered message deltas then a completed message',
        async () => {
          const sessionId = await createSession('live-stream');
          const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
            until: (e: Event) => e.type === 'session.message.completed',
            timeoutMs: TIMEOUT
          });
          await Bun.sleep(50);
          await send(sessionId, 'Reply with a short greeting.');

          const events = await eventsP;
          const tokens = events.filter((e) => e.type === 'session.message.delta.appended');
          const finals = events.filter((e) => e.type === 'session.message.completed');

          expect(tokens.length).toBeGreaterThan(0);
          // Token indices form a gap-free 0..n-1 prefix, in order.
          expect(tokens.map((e) => parseEventPayload('session.message.delta.appended', e.payload).index)).toEqual(
            tokens.map((_e, i) => i)
          );
          expect(finals).toHaveLength(1);
          const final = finals[0];
          if (!final) throw new Error('missing completed message');
          const reply = parseEventPayload('session.message.completed', final.payload).message.text;
          expect(reply.trim().length).toBeGreaterThan(0);
          // The concatenated deltas are a prefix of (or equal to) the final text the model settled on.
          const streamed = tokens
            .map((e) => parseEventPayload('session.message.delta.appended', e.payload).delta)
            .join('');
          expect(reply.startsWith(streamed) || streamed === reply).toBe(true);
        },
        // retry absorbs transient free-model flakiness (429s, an empty/just-reasoning turn, an
        // occasional ignored tool instruction) without weakening the assertions.
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'tool loop: the model invokes a tool and its side effect runs',
        async () => {
          calls.length = 0;
          const sessionId = await createSession('live-tool');
          const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
            until: (e: Event) => e.type === 'session.message.completed',
            timeoutMs: TIMEOUT
          });
          await Bun.sleep(50);
          await send(sessionId, 'Call the record_marker tool with marker set to exactly LIVEOK. Then say done.');

          const events = await eventsP;
          const toolCalls = events.filter((e) => e.type === 'tool.called');
          expect(toolCalls.length).toBeGreaterThan(0);
          expect((toolCalls[0]?.payload as { tool?: string } | undefined)?.tool).toBe('record_marker');
          // The tool's run() actually executed: its side effect captured the marker.
          expect(calls.map((c) => c.marker)).toContain('LIVEOK');
        },
        // retry absorbs transient free-model flakiness (429s, an empty/just-reasoning turn, an
        // occasional ignored tool instruction) without weakening the assertions.
        { timeout: TIMEOUT, retry: 2 }
      );
    });
  }
});
