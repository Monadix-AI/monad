// Live E2E: lifecycle hooks driven by a REAL model that actually calls a tool — covers the tool-path
// hooks (BeforeTool/AfterTool) and the per-step model hooks the offline mock can't reach, over BOTH
// transports. Hooks are in-process atom hooks recording into module state so the test can assert
// they fired around a real tool-calling turn.
//
// Opt-in: skips unless OPENROUTER_API_KEY is set (offline mock gate unaffected). Non-deterministic
// (a free model may ignore the tool instruction / rate-limit) → each test carries a retry.
//   OPENROUTER_API_KEY=sk-or-... bun test apps/monad/test/e2e/live-hooks.test.ts

import type { Event, HookEvent, HookInput } from '@monad/protocol';
import type { HookDefinition } from '@monad/sdk-atom';
import type { Tool } from '@/capabilities/tools/types.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { toolResult } from '@/capabilities/tools/types.ts';
import { createHookRunner } from '@/hooks/runner.ts';
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
const log = createLogger('e2e-live-hooks');

// A plain (non-high-risk) tool with an observable side effect — the gate is never hit, so the test
// isolates the BeforeTool/AfterTool hook path. `runs` records each execution.
const runs: string[] = [];
const echoTool: Tool<{ value: string }, { ok: true }> = {
  name: 'echo_value',
  description: 'Echo a value. Call this with `value` set to exactly what the user asks for.',
  scopes: [{ resource: 'memory' }],
  inputSchema: z.object({ value: z.string() }),
  run: async ({ value }) => {
    runs.push(value);
    return toolResult({ ok: true });
  }
};

describe.skipIf(!KEY)(`live model hooks (${MODEL})`, () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  function setup(kind: TransportKind, atomHooks: Map<HookEvent, HookDefinition[]>): TransportHandle {
    const hooks = createHookRunner({ config: {}, atomHooks, cwd: tmpdir(), log });
    const { router, deps } = liveModelDeps(KEY as string, MODEL);
    const t = serveTransport(
      kind,
      createHttpTransport(
        buildHandlers(router, deps, { tools: [echoTool as Tool], defaultModel: 'default', hooks, hookCwd: tmpdir() })
      )
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

  function runTurn(t: TransportHandle, sessionId: string, text: string): Promise<Event[]> {
    const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
      until: (e: Event) => e.type === 'agent.message',
      timeoutMs: TIMEOUT
    });
    return Bun.sleep(50)
      .then(() =>
        t.fetch(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text })
        })
      )
      .then(() => eventsP);
  }

  for (const kind of TRANSPORTS) {
    test(
      `[${kind}] the full hook lifecycle fires around a real tool-calling turn`,
      async () => {
        runs.length = 0;
        const seen: HookEvent[] = [];
        const callers: string[] = [];
        let afterToolOk: boolean | undefined;
        const rec = (event: HookEvent): HookDefinition => ({
          event,
          handler: (i: HookInput) => {
            seen.push(event);
            if (event === 'BeforeModel') callers.push(i.caller?.kind ?? '?');
            if (event === 'AfterTool') afterToolOk = i.ok;
            return undefined;
          }
        });
        const events: HookEvent[] = ['BeforeTurn', 'BeforeModel', 'BeforeTool', 'AfterTool', 'AfterModel', 'AfterTurn'];
        const atomHooks = new Map<HookEvent, HookDefinition[]>(events.map((e) => [e, [rec(e)]]));
        const t = setup(kind, atomHooks);
        const sid = await createSession(t, 'live-hooks');
        const evs = await runTurn(t, sid, 'Call the echo_value tool with value set to exactly HELLO. Then say done.');

        expect(evs.some((e) => e.type === 'agent.message')).toBe(true);
        expect(runs).toContain('HELLO'); // the real model actually called the tool
        // Lifecycle hooks fired around it — including the tool-path hooks the mock can't reach.
        for (const e of events) expect(seen).toContain(e);
        expect(afterToolOk).toBe(true);
        expect(callers).toContain('main');
      },
      { timeout: TIMEOUT, retry: 2 }
    );

    test(
      `[${kind}] a BeforeTool deny hook blocks the real model's tool call`,
      async () => {
        runs.length = 0;
        const atomHooks = new Map<HookEvent, HookDefinition[]>([
          ['BeforeTool', [{ event: 'BeforeTool', handler: () => ({ decision: 'deny', reason: 'blocked by hook' }) }]]
        ]);
        const t = setup(kind, atomHooks);
        const sid = await createSession(t, 'live-hooks-deny');
        const evs = await runTurn(t, sid, 'Call the echo_value tool with value set to exactly NOPE. Then say done.');

        expect(evs.some((e) => e.type === 'agent.message')).toBe(true); // the round still completes
        expect(runs).not.toContain('NOPE'); // BeforeTool denied → the tool never executed
      },
      { timeout: TIMEOUT, retry: 2 }
    );
  }
});
