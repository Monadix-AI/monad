// Live E2E: real-world agent SCENARIOS driven by a real model over both transports — the things a
// mock model can't exercise: multi-turn memory, recovery from a failing tool, a multi-step tool
// loop, a clarify round-trip (agent asks → user answers → agent continues), and cancelling a
// streaming round mid-flight. Complements live-model (basic protocol) and live-approvals (gate).
//
// Opt-in: skips unless OPENROUTER_API_KEY is set. Non-deterministic (a free model may phrase things
// differently or skip an instruction) → assertions check structural facts (event sequence, tool
// side effects, session state), never exact wording, and each test carries a retry.
//   OPENROUTER_API_KEY=sk-or-... bun test apps/monad/test/e2e/live-scenarios.test.ts

import type { Event } from '@monad/protocol';
import type { Tool } from '@/capabilities/tools/types.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { toolResult } from '@/capabilities/tools/types.ts';
import { createHttpTransport } from '@/transports/http.ts';
import {
  buildHandlers,
  liveModelDeps,
  serveTransport,
  TRANSPORTS,
  type TransportHandle,
  type TransportKind
} from '../helpers.ts';

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MONAD_LIVE_MODEL ?? 'openrouter/free';
const TIMEOUT = 120_000;

// A recording tool (observable side effect) and a deliberately failing tool (exercises the loop's
// tool-error path: the throw surfaces as tool.result ok:false and the model continues).
const notes: string[] = [];
const noteTool: Tool<{ text: string }, { ok: true }> = {
  name: 'note',
  description: 'Record a short note. Call with `text` set to the value the user asks for.',
  scopes: [{ resource: 'memory' }],
  inputSchema: z.object({ text: z.string() }),
  run: async ({ text }) => {
    notes.push(text);
    return toolResult({ ok: true });
  }
};
const errorTool: Tool<Record<string, never>, { ok: true }> = {
  name: 'unstable_probe',
  description: 'Run a diagnostic probe. (It is currently failing on purpose.)',
  scopes: [{ resource: 'memory' }],
  inputSchema: z.object({}),
  run: async () => {
    throw new Error('simulated probe failure');
  }
};

describe.skipIf(!KEY)(`live model scenarios (${MODEL})`, () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  function serve(kind: TransportKind, opts?: { tools?: Tool[]; clarifyTool?: boolean }): TransportHandle {
    const { router, deps } = liveModelDeps(KEY as string, MODEL);
    const t = serveTransport(
      kind,
      createHttpTransport(buildHandlers(router, deps, { defaultModel: 'default', ...opts }))
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

  function send(t: TransportHandle, sid: string, text: string): Promise<Response> {
    return t.fetch(`/v1/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
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

  // Subscribe → send → collect events up to the final message (or a custom `until`). `onEvent` runs
  // for every event (fire-and-forget side effects, e.g. answering a clarify mid-stream).
  function runStream(
    t: TransportHandle,
    sid: string,
    text: string,
    opts?: { onEvent?: (e: Event) => void; until?: (e: Event) => boolean }
  ): Promise<Event[]> {
    const until = opts?.until ?? ((e: Event) => e.type === 'agent.message');
    const eventsP = t.sse(`/v1/sessions/${sid}/events`, {
      until: (e: Event) => {
        opts?.onEvent?.(e);
        return until(e);
      },
      timeoutMs: TIMEOUT
    });
    return Bun.sleep(50)
      .then(() => send(t, sid, text))
      .then(() => eventsP);
  }

  for (const kind of TRANSPORTS) {
    describe(`over ${kind}`, () => {
      test(
        'multi-turn: the model recalls a fact from an earlier turn in the same session',
        async () => {
          const t = serve(kind);
          const sid = await createSession(t, 'multiturn');
          await blockRound(t, sid, 'Remember this code word: BANANA42. Reply with just: OK.');
          const reply = await blockRound(t, sid, 'What was the code word I gave you? Reply with only that word.');
          expect(reply.toUpperCase()).toContain('BANANA42'); // history was threaded back into context
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'tool error: a throwing tool surfaces ok:false and the model still completes the round',
        async () => {
          const t = serve(kind, { tools: [errorTool as Tool] });
          const sid = await createSession(t, 'tool-error');
          const events = await runStream(
            t,
            sid,
            'Call the unstable_probe tool exactly once. It will fail — when it does, just tell me you tried.'
          );
          const results = events.filter((e) => e.type === 'tool.result');
          expect(
            results.some(
              (e) =>
                (e.payload as { tool: string }).tool === 'unstable_probe' && (e.payload as { ok: boolean }).ok === false
            )
          ).toBe(true);
          expect(events.some((e) => e.type === 'agent.message')).toBe(true); // recovered, didn't crash the round
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'sequential tools: the agent loop runs the tool twice in a single turn',
        async () => {
          notes.length = 0;
          const t = serve(kind, { tools: [noteTool as Tool] });
          const sid = await createSession(t, 'multi-tool');
          await runStream(
            t,
            sid,
            'Use the note tool twice: first call it with text exactly ONE, then call it again with text exactly TWO. Then say done.'
          );
          expect(notes).toContain('ONE');
          expect(notes).toContain('TWO'); // the loop iterated for a second tool call, not just one
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'clarify: the agent asks a question, the user answers, and the round continues',
        async () => {
          const t = serve(kind, { clarifyTool: true });
          const sid = await createSession(t, 'clarify');
          const events = await runStream(
            t,
            sid,
            'I want to reserve a table. You MUST first use the clarify_ask tool to ask me how many people will attend, before doing anything else.',
            {
              onEvent: (e) => {
                if (e.type === 'clarify.requested') {
                  const { requestId } = e.payload as { requestId: string };
                  void t.fetch('/v1/clarifications/respond', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ requestId, answer: 'Four people.' })
                  });
                }
              }
            }
          );
          expect(events.some((e) => e.type === 'clarify.requested')).toBe(true);
          expect(events.some((e) => e.type === 'clarify.resolved')).toBe(true);
          expect(events.some((e) => e.type === 'agent.message')).toBe(true); // continued past the answer
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'cancel: aborting mid-stream stops the round and pauses the session',
        async () => {
          const t = serve(kind);
          const sid = await createSession(t, 'cancel');
          let abortP: Promise<{ aborted: boolean }> | undefined;
          const eventsP = t.sse(`/v1/sessions/${sid}/events`, {
            until: (e: Event) => {
              // Abort on the first streamed token — the round is still in flight, so the cancel lands.
              if (e.type === 'agent.token' && !abortP) {
                abortP = t
                  .fetch(`/v1/sessions/${sid}/abort`, { method: 'POST' })
                  .then((r) => r.json() as Promise<{ aborted: boolean }>);
              }
              return (
                (e.type === 'session.updated' && (e.payload as { state?: string }).state === 'paused') ||
                e.type === 'agent.message'
              );
            },
            timeoutMs: TIMEOUT
          });
          await Bun.sleep(50);
          await send(t, sid, 'Count from 1 to 60, one number per line. Go slowly, one line at a time.');
          const events = await eventsP;
          const abort = await (abortP ?? Promise.resolve({ aborted: false }));

          expect(events.some((e) => e.type === 'agent.token')).toBe(true); // we actually saw streaming start
          expect(abort.aborted).toBe(true); // the abort landed while the round was running
          expect(
            events.some((e) => e.type === 'session.updated' && (e.payload as { state?: string }).state === 'paused')
          ).toBe(true);
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'branch: a child session links to its parent in provenance and runs on its own',
        async () => {
          const t = serve(kind);
          const parent = await createSession(t, 'branch-parent');
          await blockRound(t, parent, 'Say hello in one short sentence.'); // give the parent some history
          const child = await t
            .fetch(`/v1/sessions/${parent}/branch`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: 'branch-child' })
            })
            .then((r) => r.json() as Promise<{ sessionId: string }>)
            .then((j) => j.sessionId);
          expect(child).not.toBe(parent);
          // Provenance is deterministic: the child knows the parent as an ancestor.
          const prov = (await (await t.fetch(`/v1/sessions/${child}/provenance`)).json()) as {
            ancestors: { id: string }[];
            self: { id: string; parentSessionId: string | null };
          };
          expect(prov.self.id).toBe(child);
          expect(prov.self.parentSessionId).toBe(parent);
          expect(prov.ancestors.some((a) => a.id === parent)).toBe(true);
          // The branch is an independent, working session — a fresh turn on it gets a real reply.
          const reply = await blockRound(t, child, 'Reply with exactly: BRANCHOK');
          expect(reply.trim().length).toBeGreaterThan(0);
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'restore: rewinding to an earlier user message truncates history and the session keeps working',
        async () => {
          const t = serve(kind);
          const sid = await createSession(t, 'restore');
          // Capture the first turn's user-message id from the stream — restore rewinds to it.
          const first = await runStream(t, sid, 'Reply with exactly: ONE');
          const firstUserId = (first.find((e) => e.type === 'user.message')?.payload as { messageId: string })
            .messageId;
          await runStream(t, sid, 'Reply with exactly: TWO');

          const restored = (await (
            await t.fetch(`/v1/sessions/${sid}/restore`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ toMessageId: firstUserId })
            })
          ).json()) as { restoredCount: number; newHeadMessageId: string | null };
          expect(restored.restoredCount).toBeGreaterThan(0); // history after the target was removed

          // The session is still usable after the rewind — a new turn completes normally.
          const reply = await blockRound(t, sid, 'Reply with exactly: THREE');
          expect(reply.trim().length).toBeGreaterThan(0);
        },
        { timeout: TIMEOUT, retry: 2 }
      );
    });
  }
});
