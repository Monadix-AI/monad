import type { Event } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createClarifyTool } from '#/capabilities/tools/registry/clarify.ts';
import { ClarifyService } from '#/services/generation/clarify.ts';

function capture(opts?: { maxPending?: number; restore?: Event[]; timeoutMs?: number }) {
  const events: Event[] = [];
  const clarify = new ClarifyService({ publish: (e) => events.push(e), ...opts });
  return { events, clarify };
}
const requested = (e: Event[]) => e.filter((x) => x.type === 'clarify.requested');
const resolved = (e: Event[]) => e.filter((x) => x.type === 'clarify.resolved');

test('ask emits a request and blocks until answered', async () => {
  const { events, clarify } = capture();
  const p = clarify.ask('ses_TEST00000000', { question: 'Which environment?', options: ['staging', 'prod'] });

  expect(requested(events)).toHaveLength(1);
  expect(requested(events)[0]?.payload).toMatchObject({
    question: 'Which environment?',
    options: ['staging', 'prod']
  });
  const requestId = requested(events)[0]?.payload.requestId as string;
  expect(clarify.pendingCount).toBe(1);

  expect(clarify.respond(requestId, 'prod')).toMatchObject({ status: 'answered', answer: 'prod' });
  expect(await p).toBe('prod');
  expect(resolved(events)[0]?.payload).toMatchObject({ requestId, answer: 'prod' });
  expect(clarify.pendingCount).toBe(0);
});

test('askStructured emits selectable question metadata and resolves with the request id', async () => {
  const { events, clarify } = capture();
  const p = clarify.askStructured('ses_TEST00000000', {
    question: 'Pick reviewers',
    options: ['Lily', 'Steve'],
    mode: 'multiple',
    allowOther: true,
    asker: { id: 'pmem_codex_1', name: 'Codex reviewer' }
  });

  expect(requested(events)[0]?.payload).toMatchObject({
    question: 'Pick reviewers',
    options: ['Lily', 'Steve'],
    mode: 'multiple',
    allowOther: true,
    asker: { id: 'pmem_codex_1', name: 'Codex reviewer' }
  });
  const requestId = requested(events)[0]?.payload.requestId as string;

  expect(clarify.respond(requestId, '["Lily"]')).toMatchObject({ status: 'answered', answer: '["Lily"]' });
  await expect(p).resolves.toEqual({ requestId, answer: '["Lily"]' });
  expect(resolved(events)[0]?.payload).toMatchObject({ requestId, answer: '["Lily"]' });
});

test('respond on an unknown/expired id returns not-found', () => {
  const { clarify } = capture();
  expect(clarify.respond('clarify_NOPE', 'hi')).toEqual({ status: 'not-found' });
});

test('caps concurrent pending questions — over the limit resolves empty', async () => {
  const clarify = new ClarifyService({ publish: () => {}, maxPending: 2, timeoutMs: 10 });
  void clarify.ask('ses_TEST00000000', { question: 'q1', autoResolutionMs: 60_000 });
  void clarify.ask('ses_TEST00000000', { question: 'q2', autoResolutionMs: 60_000 });
  expect(clarify.ask('ses_TEST00000000', { question: 'q3' })).rejects.toThrow('pending clarification capacity');
  expect(clarify.pendingCount).toBe(2);
});

test('times out to an empty answer with no response', async () => {
  const events: Event[] = [];
  const clarify = new ClarifyService({ publish: (e) => events.push(e), timeoutMs: 10 });
  expect(await clarify.ask('ses_TEST00000000', { question: 'still there?', autoResolutionMs: 60_000 })).toBe('');
  expect(resolved(events)[0]?.payload).toMatchObject({ answer: '', reason: 'timeout' });
  expect(clarify.pendingCount).toBe(0);
});

test('transport abort does not cancel a required human question', async () => {
  const events: Event[] = [];
  const clarify = new ClarifyService({ publish: (e) => events.push(e) });
  const controller = new AbortController();
  const p = clarify.askStructured('ses_TEST00000000', { question: 'Pick one?' }, { signal: controller.signal });
  const requestId = requested(events)[0]?.payload.requestId as string;

  expect(clarify.pendingCount).toBe(1);
  controller.abort();
  expect(clarify.pendingCount).toBe(1);
  expect(clarify.respond(requestId, 'late')).toMatchObject({ status: 'answered', answer: 'late' });
  await expect(p).resolves.toEqual({ requestId, answer: 'late' });
});

test('restores an unresolved required question after restart and continues its durable target', async () => {
  const source = capture();
  void source.clarify.ask('ses_TEST00000000', { question: 'Must a human decide?' });
  const request = requested(source.events)[0];
  if (!request) throw new Error('missing request');

  const restored = capture({ restore: [request] });
  const continuations: Array<{ requestId: string; answer: string }> = [];
  restored.clarify.setRecoveredContinuation(async ({ requestId, answer }) => {
    continuations.push({ requestId, answer });
  });
  expect(restored.clarify.pendingCount).toBe(1);
  const restoredRequestId = (request.payload as { requestId: string }).requestId;
  expect(restored.clarify.respond(restoredRequestId, 'yes')).toMatchObject({ status: 'answered', answer: 'yes' });
  expect(resolved(restored.events)).toHaveLength(1);
  await Promise.resolve();
  expect(continuations).toEqual([{ requestId: restoredRequestId, answer: 'yes' }]);
});

// ── the clarify_ask tool wired to the service ────────────────────────────────────

test('createClarifyTool routes through ask and returns the answer', async () => {
  const { events, clarify } = capture();
  const tool = createClarifyTool(clarify.ask);
  const p = tool.run({ question: 'Overwrite or merge?' }, { sessionId: 'ses_TEST00000000', log: () => {} });

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

test('clarify tool accepts omitted auto-resolution and enforces the bounded window', () => {
  const tool = createClarifyTool(async () => '');
  expect(tool.inputSchema?.safeParse({ question: 'required' }).success).toBe(true);
  expect(tool.inputSchema?.safeParse({ question: 'optional', autoResolutionMs: 60_000 }).success).toBe(true);
  expect(tool.inputSchema?.safeParse({ question: 'too soon', autoResolutionMs: 59_999 }).success).toBe(false);
  expect(tool.inputSchema?.safeParse({ question: 'too late', autoResolutionMs: 240_001 }).success).toBe(false);
});
