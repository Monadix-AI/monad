// Live E2E: the human-in-the-loop APPROVAL flow, driven by a REAL model over both transports.
// A real model is told to call a high-risk tool; the daemon's oversight gate parks the call and
// emits `tool.approval_requested`; the test answers over POST /v1/tools/approve and asserts the
// tool runs (allow) or is blocked (deny), plus that a remembered `global` grant auto-allows a
// later turn with no second prompt — the PolicyEngine feature exercised end-to-end with a model.
//
// Opt-in: skips unless OPENROUTER_API_KEY is set (offline mock gate unaffected). Non-deterministic
// (a free model may ignore the tool instruction / rate-limit) → assertions check the approval
// STATE machine, and each model-dependent test carries a retry.
//   OPENROUTER_API_KEY=sk-or-... bun test apps/monad/test/e2e/live-approvals.test.ts

import type { Event } from '@monad/protocol';
import type { Tool } from '@/capabilities/tools/types.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { buildOperatorRules, PolicyEngine } from '@/agent/approvals/engine.ts';
import { ApprovalStore } from '@/agent/approvals/store.ts';
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

// A high-risk tool with an observable side effect. `highRisk` routes every call through the gate;
// a stable `gateKey` lets a remembered rule match across turns. The module-level `runs` records
// each execution so a test can assert the tool did (or did not) actually run.
const runs: string[] = [];
const protectedTool: Tool<{ label: string }, { ok: true }> = {
  name: 'protected_action',
  description: 'Perform a protected action. Call this with `label` set to the value the user asks for.',
  scopes: [{ resource: 'memory' }],
  highRisk: true,
  gateKey: () => 'protected',
  inputSchema: z.object({ label: z.string() }),
  run: async ({ label }) => {
    runs.push(label);
    return toolResult({ ok: true });
  }
};

const reqId = (e: Event) => (e.payload as { requestId: string }).requestId;
const allowOf = (e: Event) => (e.payload as { allow: boolean }).allow;

describe.skipIf(!KEY)(`live model approvals (${MODEL})`, () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  // Fresh handlers + PolicyEngine + ApprovalStore per test, so a remembered rule from one test
  // never leaks into another. `oversightTimeoutMs` defaults generous (the gate timer starts when the
  // tool is invoked and we answer over SSE within milliseconds, but a slow model turn must not trip
  // it); the timeout test overrides it small. `operatorDeny` seeds immutable config.json-style deny
  // rules (deny wins, no prompt).
  async function setup(
    kind: TransportKind,
    opts: { oversightTimeoutMs?: number; operatorDeny?: string[] } = {}
  ): Promise<{ t: TransportHandle; engine: PolicyEngine }> {
    const dir = mkdtempSync(join(tmpdir(), 'live-apr-'));
    const store = await ApprovalStore.load(join(dir, 'approvals.json'));
    const operatorRules = buildOperatorRules({ deny: opts.operatorDeny ?? [], allow: [] });
    const engine = new PolicyEngine(store, () => operatorRules);
    const { router, deps } = liveModelDeps(KEY as string, MODEL);
    const t = serveTransport(
      kind,
      createHttpTransport(
        buildHandlers(router, deps, {
          tools: [protectedTool as Tool],
          defaultModel: 'default',
          engine,
          oversightTimeoutMs: opts.oversightTimeoutMs ?? TIMEOUT
        })
      )
    );
    cleanups.push(
      () => t.stop(),
      () => rmSync(dir, { recursive: true, force: true })
    );
    return { t, engine };
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

  function approve(t: TransportHandle, requestId: string, allow: boolean, scope = 'once'): Promise<Response> {
    return t.fetch('/v1/tools/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, allow, scope })
    });
  }

  // Run one turn, answering each tool.approval_requested via `respond` (fire-and-forget so the
  // sync `until` predicate isn't blocked), and resolve with every event up to the final message.
  function runTurn(
    t: TransportHandle,
    sessionId: string,
    text: string,
    respond?: (requestId: string) => void
  ): Promise<Event[]> {
    const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
      until: (e: Event) => {
        if (e.type === 'tool.approval_requested') respond?.(reqId(e));
        return e.type === 'agent.message';
      },
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
    describe(`over ${kind}`, () => {
      test(
        'allow: the gate prompts, the client approves, and the high-risk tool runs',
        async () => {
          runs.length = 0;
          const { t } = await setup(kind);
          const sid = await createSession(t, 'apr-allow');
          const events = await runTurn(
            t,
            sid,
            'Call the protected_action tool with label set to exactly APPROVED. Then say done.',
            (rid) => void approve(t, rid, true)
          );
          expect(events.some((e) => e.type === 'tool.approval_requested')).toBe(true);
          const resolved = events.filter((e) => e.type === 'tool.approval_resolved');
          expect(resolved.length).toBeGreaterThan(0);
          expect(allowOf(resolved[0] as Event)).toBe(true);
          expect(runs).toContain('APPROVED'); // run() executed only after the approval
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'deny: the gate prompts, the client rejects, and the tool never executes',
        async () => {
          runs.length = 0;
          const { t } = await setup(kind);
          const sid = await createSession(t, 'apr-deny');
          const events = await runTurn(
            t,
            sid,
            'Call the protected_action tool with label set to exactly DENIED. Then say done.',
            (rid) => void approve(t, rid, false)
          );
          expect(events.some((e) => e.type === 'tool.approval_requested')).toBe(true);
          const resolved = events.filter((e) => e.type === 'tool.approval_resolved');
          expect(resolved.length).toBeGreaterThan(0);
          expect(allowOf(resolved[0] as Event)).toBe(false);
          expect(runs).not.toContain('DENIED'); // denied → run() never reached
          expect(events.some((e) => e.type === 'agent.message')).toBe(true); // round still completes
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'remembered allow (scope:global): the real approval persists a rule the engine now honors',
        async () => {
          runs.length = 0;
          const { t, engine } = await setup(kind);
          const sid = await createSession(t, 'apr-remember');
          // A real model turn drives the approval; the client grants scope:'global'.
          const first = await runTurn(
            t,
            sid,
            'Call the protected_action tool with label set to exactly FIRST. Then say done.',
            (rid) => void approve(t, rid, true, 'global')
          );
          expect(first.some((e) => e.type === 'tool.approval_requested')).toBe(true);
          expect(allowOf(first.find((e) => e.type === 'tool.approval_resolved') as Event)).toBe(true);
          expect(runs).toContain('FIRST');

          // The global grant persisted: GET /v1/approvals lists it, and the engine now auto-resolves
          // the same (tool, key) to 'allow' — so a later turn would run with NO new prompt. (The
          // gate-level no-re-prompt path itself is covered deterministically by approvals.test.ts;
          // re-driving a second model turn here only adds free-model flakiness, not coverage.)
          const listed = (await (await t.fetch('/v1/approvals')).json()) as {
            rules: { tool: string; key?: string; scope: string }[];
          };
          expect(listed.rules.some((r) => r.tool === 'protected_action' && r.scope === 'global')).toBe(true);
          expect(engine.decide({ tool: 'protected_action', key: 'protected', sessionId: sid, agentId: null })).toBe(
            'allow'
          );
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'timeout: an unanswered approval auto-denies and the tool never executes',
        async () => {
          runs.length = 0;
          // Short gate timeout; we deliberately never answer the prompt.
          const { t } = await setup(kind, { oversightTimeoutMs: 1_500 });
          const sid = await createSession(t, 'apr-timeout');
          const events = await runTurn(
            t,
            sid,
            'Call the protected_action tool with label set to exactly TIMEOUT. Then say done.'
            // no responder → the request is left to expire
          );
          expect(events.some((e) => e.type === 'tool.approval_requested')).toBe(true);
          const resolved = events.filter((e) => e.type === 'tool.approval_resolved');
          expect(resolved.length).toBeGreaterThan(0);
          expect(allowOf(resolved[0] as Event)).toBe(false);
          expect((resolved[0]?.payload as { reason?: string }).reason).toBe('timeout');
          expect(runs).not.toContain('TIMEOUT'); // expired → run() never reached
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'session scope: a session grant binds to that session only, not globally',
        async () => {
          runs.length = 0;
          const { t, engine } = await setup(kind);
          const sid = await createSession(t, 'apr-session-scope');
          const events = await runTurn(
            t,
            sid,
            'Call the protected_action tool with label set to exactly SESSION. Then say done.',
            (rid) => void approve(t, rid, true, 'session')
          );
          expect(allowOf(events.find((e) => e.type === 'tool.approval_resolved') as Event)).toBe(true);
          expect(runs).toContain('SESSION');
          // The grant is confined to THIS session: the same (tool, key) resolves 'allow' here…
          expect(engine.decide({ tool: 'protected_action', key: 'protected', sessionId: sid, agentId: null })).toBe(
            'allow'
          );
          // …but a different session still has to ask (no global/agent rule was created).
          expect(
            engine.decide({ tool: 'protected_action', key: 'protected', sessionId: 'ses_OTHER', agentId: null })
          ).toBe('ask');
        },
        { timeout: TIMEOUT, retry: 2 }
      );

      test(
        'operator deny: a config.json deny rule blocks the tool outright — no prompt, no run',
        async () => {
          runs.length = 0;
          const { t } = await setup(kind, { operatorDeny: ['protected_action'] });
          const sid = await createSession(t, 'apr-operator-deny');
          const events = await runTurn(
            t,
            sid,
            'Call the protected_action tool with label set to exactly BLOCKED. Then say done.',
            (rid) => void approve(t, rid, true) // even an eager "allow" can't override an operator deny
          );
          // Deny-wins resolves at the policy layer: the gate never prompts the human…
          expect(events.some((e) => e.type === 'tool.approval_requested')).toBe(false);
          expect(runs).not.toContain('BLOCKED'); // …and the tool never executes
          expect(events.some((e) => e.type === 'agent.message')).toBe(true); // round still completes
        },
        { timeout: TIMEOUT, retry: 2 }
      );
    });
  }
});
