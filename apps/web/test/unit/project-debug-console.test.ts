import type { ProjectDebugTraceEntry } from '../../src/lib/project-debug-trace';

import { expect, test } from 'bun:test';

import {
  debugTraceText,
  filterDebugTraceEntries,
  formatDebugTimestamp,
  logRecordToDebugTrace
} from '../../src/features/workplace/debug/ProjectDebugConsole';

const entry = (overrides: Partial<ProjectDebugTraceEntry>): ProjectDebugTraceEntry => ({
  id: overrides.id ?? `dbg_${overrides.label ?? 'x'}`,
  at: overrides.at ?? '2026-06-29T00:00:00.000Z',
  direction: overrides.direction ?? 'event',
  layer: overrides.layer ?? 'sse',
  label: overrides.label ?? 'agent.message',
  ...(overrides.data !== undefined ? { data: overrides.data } : {}),
  ...(overrides.sessionId ? { sessionId: overrides.sessionId } : {})
});

test('project debug console filters trace entries by layer and label', () => {
  const entries = [
    entry({ layer: 'http', label: 'POST /v1/projects/undefined/messages' }),
    entry({ layer: 'sse', label: 'mesh.output' }),
    entry({ layer: 'log', label: 'mesh.input', direction: 'input' }),
    entry({ layer: 'sse', label: 'mesh.approval_requested' }),
    entry({ layer: 'http', label: 'POST /x', direction: 'error' })
  ];

  expect(filterDebugTraceEntries(entries, 'http').map((item) => item.label)).toEqual([
    'POST /v1/projects/undefined/messages',
    'POST /x'
  ]);
  expect(filterDebugTraceEntries(entries, 'mesh-agent').map((item) => item.label)).toEqual([
    'mesh.output',
    'mesh.input',
    'mesh.approval_requested'
  ]);
  expect(filterDebugTraceEntries(entries, 'approval').map((item) => item.label)).toEqual(['mesh.approval_requested']);
  expect(filterDebugTraceEntries(entries, 'log').map((item) => item.label)).toEqual(['mesh.input']);
  expect(filterDebugTraceEntries(entries, 'error').map((item) => item.label)).toEqual(['POST /x']);
});

test('project debug console renders entry data as formatted JSON', () => {
  expect(debugTraceText(entry({ data: { chunk: '\u001b[?25l' } }))).toContain('"chunk":');
});

test('project debug console formats timestamps in the requested time zone', () => {
  const formatted = formatDebugTimestamp('2026-06-29T10:00:00.123Z', 'Asia/Shanghai');

  expect(formatted).toContain('18:00:00');
  expect(formatted).not.toContain('.123');
  expect(formatted).not.toContain('GMT+8');
});

test('project debug console maps logger records to log trace entries', () => {
  expect(
    logRecordToDebugTrace({
      level: 20,
      event: 'mesh.started',
      sessionId: 'ses_100000000000',
      meshSessionId: 'mesh_100000000000',
      msg: 'native cli started'
    })
  ).toEqual({
    direction: 'internal',
    layer: 'log',
    label: 'mesh.started',
    data: {
      level: 20,
      event: 'mesh.started',
      sessionId: 'ses_100000000000',
      meshSessionId: 'mesh_100000000000',
      msg: 'native cli started'
    }
  });
});

test('project debug console maps HTTP logger records to HTTP trace entries', () => {
  expect(
    logRecordToDebugTrace({
      level: 20,
      event: 'http.request',
      method: 'POST',
      name: 'transport:http',
      path: '/v1/projects/ses_100000000000/messages',
      sessionId: 'ses_100000000000',
      status: 200
    })
  ).toMatchObject({
    direction: 'internal',
    layer: 'http',
    label: 'http.request'
  });
});
