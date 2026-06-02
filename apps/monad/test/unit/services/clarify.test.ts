import type { Event } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createClarifyTool } from '@/capabilities/tools/registry/clarify.ts';
import { ClarifyService } from '@/services/generation/clarify.ts';

function capture(opts?: { timeoutMs?: number; maxPending?: number }) {
  const events: Event[] = [];
  const clarify = new ClarifyService({ publish: (e) => events.push(e), timeoutMs: 1000, ...opts });
  return { events, clarify };
}
const requested = (e: Event[]) => e.filter((x) => x.type === 'clarify.requested');
const resolved = (e: Event[]) => e.filter((x) => x.type === 'clarify.resolved');

test('ask emits a request and blocks until answered', async () => {
  const { events, clarify } = capture();
  const p = clarify.ask('ses_TEST', 'Which environment?', ['staging', 'prod']);

  expect(requested(events)).toHaveLength(1);
  expect(requested(events)[0]?.payload).toMatchObject({
    question: 'Which environment?',
    options: ['staging', 'prod']
  });
  const requestId = requested(events)[0]?.payload.requestId as string;
  expect(clarify.pendingCount).toBe(1);

  expect(clarify.respond(requestId, 'prod')).toBe(true);
  expect(await p).toBe('prod');
  expect(resolved(events)[0]?.payload).toMatchObject({ requestId, answer: 'prod' });
  expect(clarify.pendingCount).toBe(0);
});

test('respond on an unknown/expired id returns false', () => {
  const { clarify } = capture();
  expect(clarify.respond('clarify_NOPE', 'hi')).toBe(false);
});

test('caps concurrent pending questions — over the limit resolves empty', async () => {
  const clarify = new ClarifyService({ publish: () => {}, timeoutMs: 20, maxPending: 2 });
  const p1 = clarify.ask('ses_TEST', 'q1');
  const p2 = clarify.ask('ses_TEST', 'q2');
  const p3 = clarify.ask('ses_TEST', 'q3'); // over the cap → immediate empty, no entry created

  expect(await p3).toBe('');
  expect(clarify.pendingCount).toBe(2);
  await Promise.all([p1, p2]); // let the parked ones time out
});

test('times out to an empty answer with no response', async () => {
  const events: Event[] = [];
  const clarify = new ClarifyService({ publish: (e) => events.push(e), timeoutMs: 10 });
  expect(await clarify.ask('ses_TEST', 'still there?')).toBe('');
  expect(resolved(events)[0]?.payload).toMatchObject({ answer: '', reason: 'timeout' });
  expect(clarify.pendingCount).toBe(0);
});

// ── the clarify_ask tool wired to the service ────────────────────────────────────

test('createClarifyTool routes through ask and returns the answer', async () => {
  const { events, clarify } = capture();
  const tool = createClarifyTool(clarify.ask);
  const p = tool.run({ question: 'Overwrite or merge?' }, { sessionId: 'ses_TEST', log: () => {} });

  const requestId = requested(events)[0]?.payload.requestId as string;
  clarify.respond(requestId, 'merge');
  expect((await p).metadata).toEqual({ answer: 'merge' });
});

test('clarify tool rejects an empty question', () => {
  const tool = createClarifyTool(async () => '');
  const parsed = tool.inputSchema?.safeParse({ question: '' });
  expect(parsed?.success).toBe(false);
});

test('clarify tool rejects non-string options', () => {
  const tool = createClarifyTool(async () => '');
  const parsed = tool.inputSchema?.safeParse({ question: 'q', options: [1, 2] });
  expect(parsed?.success).toBe(false);
});
