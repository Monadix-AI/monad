import type { ProjectDebugTraceEntry } from '../../lib/project-debug-trace';

import { expect, test } from 'bun:test';

import {
  debugTraceText,
  filterDebugTraceEntries,
  formatDebugTimestamp,
  logRecordToDebugTrace
} from '../../features/workplace/debug/ProjectDebugConsole';

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
    entry({ layer: 'http', label: 'POST /v1/projects/ses_1/messages' }),
    entry({ layer: 'sse', label: 'native_cli.output' }),
    entry({ layer: 'log', label: 'native-cli.input', direction: 'input' }),
    entry({ layer: 'sse', label: 'native_cli.approval_requested' }),
    entry({ layer: 'http', label: 'POST /x', direction: 'error' })
  ];

  expect(filterDebugTraceEntries(entries, 'http').map((item) => item.label)).toEqual([
    'POST /v1/projects/ses_1/messages',
    'POST /x'
  ]);
  expect(filterDebugTraceEntries(entries, 'native-cli').map((item) => item.label)).toEqual([
    'native_cli.output',
    'native-cli.input',
    'native_cli.approval_requested'
  ]);
  expect(filterDebugTraceEntries(entries, 'approval').map((item) => item.label)).toEqual([
    'native_cli.approval_requested'
  ]);
  expect(filterDebugTraceEntries(entries, 'log').map((item) => item.label)).toEqual(['native-cli.input']);
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
      event: 'native_cli.started',
      sessionId: 'ses_1',
      nativeCliSessionId: 'ncli_1',
      msg: 'native cli started'
    })
  ).toEqual({
    direction: 'internal',
    label: 'native_cli.started',
    data: {
      level: 20,
      event: 'native_cli.started',
      sessionId: 'ses_1',
      nativeCliSessionId: 'ncli_1',
      msg: 'native cli started'
    }
  });
});

test('project debug console owns the dev stream message toggle', async () => {
  const [consoleSource, storeSource, projectSource] = await Promise.all([
    Bun.file(new URL('../../features/workplace/debug/ProjectDebugConsole.tsx', import.meta.url)).text(),
    Bun.file(new URL('../../features/workplace/workplace-ui-store.ts', import.meta.url)).text(),
    Bun.file(new URL('../../features/workplace/use-project.ts', import.meta.url)).text()
  ]);

  expect(consoleSource).toContain('show dev system messages in stream');
  expect(consoleSource).toContain('setShowDevSystemMessagesInStream');
  expect(storeSource).toContain('monad.workplace.showDevSystemMessagesInStream');
  expect(storeSource).toContain("process.env.NODE_ENV !== 'production'");
  expect(projectSource).toContain('showDeveloperOnlyMessages: DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED &&');
});
