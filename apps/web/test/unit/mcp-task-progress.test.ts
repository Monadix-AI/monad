import { expect, test } from 'bun:test';

import { parseMcpTaskProgress } from '#/features/session/mcp-task-progress';

test('parseMcpTaskProgress returns the exact renderable task state', () => {
  expect(
    parseMcpTaskProgress(
      JSON.stringify({
        type: 'mcp_task',
        server: 'monadix',
        tool: 'run_conversation',
        taskId: 'mtask_123',
        status: 'input_required',
        statusMessage: 'Choose an environment',
        createdAt: '2026-07-31T00:00:00.000Z',
        lastUpdatedAt: '2026-07-31T00:00:01.000Z',
        ignored: true
      })
    )
  ).toEqual({
    type: 'mcp_task',
    server: 'monadix',
    tool: 'run_conversation',
    taskId: 'mtask_123',
    status: 'input_required',
    statusMessage: 'Choose an environment',
    lastUpdatedAt: '2026-07-31T00:00:01.000Z'
  });
});

test('parseMcpTaskProgress rejects terminal and malformed progress payloads', () => {
  expect([
    parseMcpTaskProgress(undefined),
    parseMcpTaskProgress('{'),
    parseMcpTaskProgress(
      JSON.stringify({
        type: 'mcp_task',
        server: 'monadix',
        tool: 'run_conversation',
        taskId: 'mtask_123',
        status: 'completed',
        lastUpdatedAt: '2026-07-31T00:00:01.000Z'
      })
    )
  ]).toEqual([null, null, null]);
});
