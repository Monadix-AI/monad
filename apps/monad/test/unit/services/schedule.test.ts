import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createScheduleTools } from '@/capabilities/tools/registry/schedule.ts';
import { ScheduleService } from '@/services/scheduling/schedule.ts';

function tmpStore(): string {
  return join(tmpdir(), `monad-sched-${process.pid}-${process.hrtime.bigint()}.json`);
}

function svc(fire: ScheduleService['fire'] = async () => {}, now?: () => Date) {
  const storePath = tmpStore();
  return { storePath, service: new ScheduleService({ storePath, fire, now }) };
}

test('create validates the spec and computes the next cron fire', () => {
  const fixed = new Date(2026, 5, 14, 8, 0);
  const { service } = svc(
    async () => {},
    () => fixed
  );
  const info = service.create({ prompt: 'standup', cron: '0 9 * * *' });
  expect(info.kind).toBe('cron');
  expect(info.nextFireAt).toBe(new Date(2026, 5, 14, 9, 0).toISOString());
  expect(service.list()).toHaveLength(1);
  service.dispose();
});

test('create rejects an invalid cron expression', () => {
  const { service } = svc();
  expect(() => service.create({ prompt: 'x', cron: 'not a cron' })).toThrow();
  service.dispose();
});

test('cancel removes a schedule; unknown id returns false', () => {
  const { service } = svc();
  const info = service.create({ prompt: 'x', at: new Date(Date.now() + 60_000).toISOString() });
  expect(service.cancel(info.id)).toBe(true);
  expect(service.cancel(info.id)).toBe(false);
  expect(service.list()).toHaveLength(0);
  service.dispose();
});

test('a one-shot fires with the prompt then retires itself', async () => {
  const fired: Array<{ prompt: string; sessionId?: string }> = [];
  const { service } = svc(async (prompt, sessionId) => {
    fired.push({ prompt, sessionId });
  });
  service.create({ prompt: 'ping', delayMs: 5, sessionId: 'ses_X' });
  await Bun.sleep(40);
  expect(fired).toEqual([{ prompt: 'ping', sessionId: 'ses_X' }]);
  expect(service.list()).toHaveLength(0); // retired after firing
  service.dispose();
});

test('persists across a reload and re-arms cron schedules', async () => {
  const fixed = new Date(2026, 5, 14, 8, 0);
  const { storePath, service } = svc(
    async () => {},
    () => fixed
  );
  const created = service.create({ prompt: 'nightly', cron: '0 0 * * *' });
  service.dispose();

  const reloaded = new ScheduleService({ storePath, fire: async () => {}, now: () => fixed });
  await reloaded.load();
  const list = reloaded.list();
  expect(list).toHaveLength(1);
  expect(list[0]?.id).toBe(created.id);
  expect(list[0]?.prompt).toBe('nightly');
  reloaded.dispose();
  await rm(storePath, { force: true });
});

test('a missed one-shot runs once on load (catch-up) then drops', async () => {
  const fired: string[] = [];
  const storePath = tmpStore();
  // Seed a store with a one-shot whose time is already in the past.
  const past = new Date(Date.now() - 60_000).toISOString();
  await Bun.write(
    storePath,
    JSON.stringify([
      { id: 'sched_old', prompt: 'catchup', kind: 'once', spec: past, nextFireAt: past, createdAt: past }
    ])
  );
  const service = new ScheduleService({ storePath, fire: async (p) => void fired.push(p) });
  await service.load();
  await Bun.sleep(40);
  expect(fired).toEqual(['catchup']);
  expect(service.list()).toHaveLength(0);
  service.dispose();
  await rm(storePath, { force: true });
});

// ── the schedule.* tools over a real service ────────────────────────────────────────

function toolByName(service: ScheduleService, name: string) {
  const tool = createScheduleTools(service).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

test('schedule tools create, list, and cancel through the service', async () => {
  const { service } = svc();
  const ctx = { sessionId: 'ses_T', log: () => {} };

  const created = (await toolByName(service, 'schedule_create').run({ prompt: 'job', cron: '*/5 * * * *' }, ctx))
    .metadata as {
    id: string;
  };
  expect(created.id).toMatch(/^sched_/);
  const listed = (await toolByName(service, 'schedule_list').run({}, ctx)).metadata as { schedules: unknown[] };
  expect(listed.schedules).toHaveLength(1);
  expect((await toolByName(service, 'schedule_cancel').run({ id: created.id }, ctx)).metadata).toEqual({
    cancelled: true
  });
  service.dispose();
});

test('schedule_create rejects input with no timing spec', () => {
  const { service } = svc();
  const create = toolByName(service, 'schedule_create');
  expect(create.inputSchema?.safeParse({ prompt: 'x' }).success).toBe(false);
  expect(create.inputSchema?.safeParse({ prompt: 'x', cron: '* * * * *', delayMs: 1 }).success).toBe(false);
  service.dispose();
});

test('schedule_create rejects bad field types and empty prompt', () => {
  const { service } = svc();
  const parse = (input: unknown) => toolByName(service, 'schedule_create').inputSchema?.safeParse(input);
  // Empty or missing prompt
  expect(parse({ prompt: '', cron: '* * * * *' })?.success).toBe(false);
  expect(parse({ cron: '* * * * *' })?.success).toBe(false);
  // Wrong types for timing fields
  expect(parse({ prompt: 'x', cron: 42 })?.success).toBe(false);
  expect(parse({ prompt: 'x', at: 99 })?.success).toBe(false);
  expect(parse({ prompt: 'x', delayMs: -1 })?.success).toBe(false);
  expect(parse({ prompt: 'x', delayMs: 'soon' })?.success).toBe(false);
  // sessionId wrong type
  expect(parse({ prompt: 'x', cron: '* * * * *', sessionId: 123 })?.success).toBe(false);
  // Valid with delayMs and at
  expect(parse({ prompt: 'x', delayMs: 0 })?.success).toBe(true);
  expect(parse({ prompt: 'x', at: '2026-06-15T09:00:00Z' })?.success).toBe(true);
  service.dispose();
});
