import type { Event } from '@monad/protocol';
import type { Tool } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { invokeTool, ToolGateDeniedError } from '@/capabilities/tools/invoke.ts';
import { toolResult } from '@/capabilities/tools/types.ts';
import { OversightService } from '@/services/oversight.ts';

const gateReq = { tool: 'email_send', sessionId: 'ses_TEST', highRisk: true, input: { to: ['a@b.c'] } };

function capture() {
  const events: Event[] = [];
  const oversight = new OversightService({ publish: (e) => events.push(e), timeoutMs: 1000 });
  return { events, oversight };
}
const requested = (e: Event[]) => e.filter((x) => x.type === 'tool.approval_requested');
const resolved = (e: Event[]) => e.filter((x) => x.type === 'tool.approval_resolved');

test('gate emits an approval request and blocks until approved', async () => {
  const { events, oversight } = capture();
  const p = oversight.gate(gateReq); // executor runs synchronously → request emitted

  expect(requested(events)).toHaveLength(1);
  expect(requested(events)[0]?.payload.tool).toBe('email_send');
  const requestId = requested(events)[0]?.payload.requestId as string;
  expect(oversight.pendingCount).toBe(1);

  expect(await oversight.respond(requestId, true)).toBe(true);
  expect(await p).toEqual({ allow: true });
  expect(resolved(events)[0]?.payload).toMatchObject({ requestId, allow: true });
  expect(oversight.pendingCount).toBe(0);
});

test('denial carries the reason through to the outcome', async () => {
  const { events, oversight } = capture();
  const p = oversight.gate(gateReq);
  const requestId = requested(events)[0]?.payload.requestId as string;
  oversight.respond(requestId, false, 'looks like spam');
  expect(await p).toEqual({ allow: false, reason: 'looks like spam' });
});

test('respond on an unknown/expired id returns false', async () => {
  const { oversight } = capture();
  expect(await oversight.respond('gate_NOPE', true)).toBe(false);
});

test('caps concurrent pending approvals — over the limit is denied fail-closed', async () => {
  // Short timeout so the two parked requests auto-resolve and leave no dangling timers.
  const oversight = new OversightService({ publish: () => {}, timeoutMs: 20, maxPending: 2 });
  const p1 = oversight.gate(gateReq);
  const p2 = oversight.gate(gateReq);
  const p3 = oversight.gate(gateReq); // over the cap → immediate deny, no entry created

  expect(await p3).toEqual({ allow: false, reason: 'too many pending approvals' });
  expect(oversight.pendingCount).toBe(2);
  await Promise.all([p1, p2]); // let the parked ones time out
});

test('auto-denies (fail-closed) after the timeout with no response', async () => {
  const events: Event[] = [];
  const oversight = new OversightService({ publish: (e) => events.push(e), timeoutMs: 10 });
  const outcome = await oversight.gate(gateReq);
  expect(outcome).toEqual({ allow: false, reason: 'approval request timed out' });
  expect(resolved(events)[0]?.payload).toMatchObject({ allow: false, reason: 'timeout' });
  expect(oversight.pendingCount).toBe(0);
});

// ── integration: oversight.gate as a real ToolGate for invokeTool ───────────────

function probe(): Tool<{ x: number }, string> {
  return {
    name: 'test.high',
    description: 'high-risk probe',
    scopes: [],
    highRisk: true,
    run: async () => toolResult('ran')
  };
}

test('invokeTool with the oversight gate runs the tool once approved', async () => {
  const { events, oversight } = capture();
  const p = invokeTool(probe(), { x: 1 }, { sessionId: 'ses_TEST', log: () => {}, gate: oversight.gate });

  const requestId = requested(events)[0]?.payload.requestId as string;
  oversight.respond(requestId, true);
  expect((await p).metadata).toBe('ran');
});

test('invokeTool with the oversight gate rejects when denied', async () => {
  const { events, oversight } = capture();
  const p = invokeTool(probe(), { x: 1 }, { sessionId: 'ses_TEST', log: () => {}, gate: oversight.gate });

  const requestId = requested(events)[0]?.payload.requestId as string;
  oversight.respond(requestId, false, 'nope');
  await expect(p).rejects.toBeInstanceOf(ToolGateDeniedError);
});

// ── cancelSession ────────────────────────────────────────────────────────────

test('cancelSession immediately resolves all pending gates for that session', async () => {
  const { events, oversight } = capture();
  const p1 = oversight.gate(gateReq);
  const p2 = oversight.gate(gateReq);
  // different session — must NOT be cancelled
  const p3 = oversight.gate({ ...gateReq, sessionId: 'ses_OTHER' });

  expect(oversight.pendingCount).toBe(3);
  oversight.cancelSession('ses_TEST' as never, 'session_aborted');

  expect(await p1).toEqual({ allow: false, reason: 'session_aborted' });
  expect(await p2).toEqual({ allow: false, reason: 'session_aborted' });
  expect(oversight.pendingCount).toBe(1); // ses_OTHER still pending

  // Both resolved events emitted with correct reason
  const res = resolved(events);
  expect(res).toHaveLength(2);
  expect(res.every((e) => e.payload.reason === 'session_aborted')).toBe(true);
  expect(res.every((e) => e.payload.allow === false)).toBe(true);

  // Clean up the remaining timer
  oversight.cancelSession('ses_OTHER' as never, 'cleanup');
  await p3;
});

test('cancelSession on a session with no pending gates is a no-op', () => {
  const { oversight } = capture();
  expect(() => oversight.cancelSession('ses_EMPTY' as never, 'session_aborted')).not.toThrow();
  expect(oversight.pendingCount).toBe(0);
});
