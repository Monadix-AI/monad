import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpTaskJournal } from '#/capabilities/tools/registry/mcp/task-journal.ts';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test('McpTaskJournal persists task recovery state and cancellation intent', async () => {
  directory = await mkdtemp(join(tmpdir(), 'monad-mcp-task-journal-'));
  const path = join(directory, 'tasks.json');
  const journal = new McpTaskJournal(path);
  await journal.upsert({
    server: 'monadix',
    taskId: 'task_1',
    toolName: 'run_conversation',
    sessionId: 'session_1',
    toolCallId: 'call_1',
    status: 'working',
    statusMessage: 'Delegating',
    createdAt: '2026-07-31T00:00:00.000Z',
    lastUpdatedAt: '2026-07-31T00:01:00.000Z',
    observedAt: '2026-07-31T00:01:01.000Z'
  });
  await journal.markCancelRequested('task_1');

  const reopened = new McpTaskJournal(path);
  const tasks = await reopened.list();

  expect(tasks).toEqual([
    {
      server: 'monadix',
      taskId: 'task_1',
      toolName: 'run_conversation',
      sessionId: 'session_1',
      toolCallId: 'call_1',
      status: 'working',
      statusMessage: 'Delegating',
      createdAt: '2026-07-31T00:00:00.000Z',
      lastUpdatedAt: '2026-07-31T00:01:00.000Z',
      observedAt: expect.any(String),
      cancelRequestedAt: expect.any(String)
    }
  ]);
});

test('McpTaskJournal removes terminal recovery records after retention', async () => {
  directory = await mkdtemp(join(tmpdir(), 'monad-mcp-task-journal-retention-'));
  const journal = new McpTaskJournal(join(directory, 'tasks.json'));
  await journal.upsert({
    server: 'monadix',
    taskId: 'task_old',
    toolName: 'run_conversation',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUpdatedAt: '2026-01-01T00:01:00.000Z',
    observedAt: '2026-01-01T00:01:00.000Z',
    ttlMs: 60_000,
    expiresAt: '2026-01-01T00:01:00.000Z'
  });

  expect(await journal.list()).toEqual([]);
});

test('McpTaskJournal acknowledges only the recovered delivery revision that was displayed', async () => {
  directory = await mkdtemp(join(tmpdir(), 'monad-mcp-task-journal-delivery-'));
  const journal = new McpTaskJournal(join(directory, 'tasks.json'));
  await journal.upsert({
    server: 'monadix',
    taskId: 'task_delivery',
    toolName: 'run_conversation',
    status: 'completed',
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    recoveredAt: '2026-07-31T01:00:00.000Z',
    deliveryPending: true
  });

  const stale = await journal.acknowledgeDelivery('task_delivery', '2026-07-31T00:00:00.000Z');
  const accepted = await journal.acknowledgeDelivery('task_delivery', '2026-07-31T01:00:00.000Z');

  expect({ stale, accepted, pending: await journal.pendingDeliveries() }).toEqual({
    stale: false,
    accepted: true,
    pending: []
  });
});

test('McpTaskJournal quarantines malformed state instead of silently overwriting it', async () => {
  directory = await mkdtemp(join(tmpdir(), 'monad-mcp-task-journal-corrupt-'));
  const path = join(directory, 'tasks.json');
  await Bun.write(path, '{"version":1,"tasks":[');

  const tasks = await new McpTaskJournal(path).list();
  const files = await readdir(directory);

  expect({ tasks, quarantined: files.some((file) => file.startsWith('tasks.json.corrupt-')) }).toEqual({
    tasks: [],
    quarantined: true
  });
});
