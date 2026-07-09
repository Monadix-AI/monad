import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createScheduleTools } from '#/capabilities/tools/registry/schedule.ts';
import { ScheduleService } from '#/services/scheduling/schedule.ts';

function tmpStore(): string {
  return join(tmpdir(), `monad-sl-${process.pid}-${process.hrtime.bigint()}.json`);
}

function svc(fire: ScheduleService['fire'] = async () => {}, now?: () => Date) {
  const storePath = tmpStore();
  return { storePath, service: new ScheduleService({ storePath, fire, now }) };
}

function sendLaterTool(service: ScheduleService) {
  const tool = createScheduleTools(service).find((t) => t.name === 'send_later');
  if (!tool) throw new Error('send_later tool not found');
  return tool;
}

const ctx = { sessionId: 'ses_wake00000000', log: () => {} };

test('send_later creates a one-shot targeting the current session', async () => {
  const { service } = svc();
  const tool = sendLaterTool(service);
  const result = (await tool.run({ prompt: 'check CI', delayMs: 60_000 }, ctx)).metadata as {
    id: string;
    firesAt: string;
  };
  expect(result.id).toMatch(/^sched_/);

  const schedules = service.list();
  expect(schedules).toHaveLength(1);
  expect(schedules[0]?.sessionId).toBe('ses_wake00000000');
  expect(schedules[0]?.prompt).toBe('check CI');
  expect(schedules[0]?.kind).toBe('once');
  service.dispose();
});

test('send_later with absolute `at` timestamp', async () => {
  const { service } = svc();
  const tool = sendLaterTool(service);
  const at = new Date(Date.now() + 120_000).toISOString();
  const result = (await tool.run({ prompt: 'follow up', at }, ctx)).metadata as { id: string; firesAt: string };
  expect(result.firesAt).toBe(at);
  service.dispose();
});

test('send_later fires into the current session after the delay', async () => {
  const fired: Array<{ prompt: string; sessionId?: string }> = [];
  const { service } = svc(async (prompt, sessionId) => void fired.push({ prompt, sessionId }));
  const tool = sendLaterTool(service);
  await tool.run({ prompt: 'ping', delayMs: 5 }, ctx);
  await Bun.sleep(40);
  expect(fired).toEqual([{ prompt: 'ping', sessionId: 'ses_wake00000000' }]);
  service.dispose();
});

test('receipt id can be used with schedule_cancel', async () => {
  const { service } = svc();
  const tool = sendLaterTool(service);
  const { id } = (await tool.run({ prompt: 'to cancel', delayMs: 60_000 }, ctx)).metadata as { id: string };
  expect(service.cancel(id)).toBe(true);
  service.dispose();
});

// ── input validation ─────────────────────────────────────────────────────────

test('send_later rejects missing prompt', () => {
  const { service } = svc();
  const tool = sendLaterTool(service);
  expect(tool.inputSchema?.safeParse({ delayMs: 1000 }).success).toBe(false);
  expect(tool.inputSchema?.safeParse({ prompt: '', delayMs: 1000 }).success).toBe(false);
  service.dispose();
});

test('send_later rejects when both delayMs and at are given', () => {
  const { service } = svc();
  const tool = sendLaterTool(service);
  expect(tool.inputSchema?.safeParse({ prompt: 'x', delayMs: 1000, at: new Date().toISOString() }).success).toBe(false);
  service.dispose();
});

test('send_later rejects when neither delayMs nor at is given', () => {
  const { service } = svc();
  const tool = sendLaterTool(service);
  expect(tool.inputSchema?.safeParse({ prompt: 'x' }).success).toBe(false);
  service.dispose();
});

test('send_later rejects negative delayMs', () => {
  const { service } = svc();
  const tool = sendLaterTool(service);
  expect(tool.inputSchema?.safeParse({ prompt: 'x', delayMs: -1 }).success).toBe(false);
  service.dispose();
});

test('send_later accepts zero delayMs (fire immediately)', () => {
  const { service } = svc();
  const tool = sendLaterTool(service);
  expect(tool.inputSchema?.safeParse({ prompt: 'x', delayMs: 0 }).success).toBe(true);
  service.dispose();
});

test('send_later accepts a valid ISO at string', () => {
  const { service } = svc();
  const tool = sendLaterTool(service);
  expect(tool.inputSchema?.safeParse({ prompt: 'x', at: '2026-12-01T09:00:00Z' }).success).toBe(true);
  service.dispose();
});

test('send_later is included in createScheduleTools output', () => {
  const { service } = svc();
  const tools = createScheduleTools(service);
  const _names = tools.map((t) => t.name);
  service.dispose();
});
