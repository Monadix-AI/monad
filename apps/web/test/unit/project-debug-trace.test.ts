import { expect, test } from 'bun:test';

import {
  appendProjectDebugTrace,
  clearProjectDebugTrace,
  projectDebugTraceSnapshot,
  subscribeProjectDebugTrace,
  traceProjectDebugOperation
} from '../../lib/project-debug-trace';

test('project debug trace stores bounded entries and notifies subscribers', () => {
  clearProjectDebugTrace();
  let notified = 0;
  const unsubscribe = subscribeProjectDebugTrace(() => {
    notified++;
  });

  appendProjectDebugTrace({
    direction: 'input',
    layer: 'web',
    label: 'send',
    sessionId: 'ses_100000000000',
    data: { text: 'hi' }
  });

  expect(projectDebugTraceSnapshot()).toMatchObject([
    { direction: 'input', layer: 'web', label: 'send', sessionId: 'ses_100000000000', data: { text: 'hi' } }
  ]);
  expect(notified).toBe(1);
  unsubscribe();
});

test('project debug trace keeps only the latest 1000 entries', () => {
  clearProjectDebugTrace();
  for (let i = 0; i < 1005; i++) {
    appendProjectDebugTrace({ direction: 'event', layer: 'sse', label: `event-${i}` });
  }

  const entries = projectDebugTraceSnapshot();
  expect(entries).toHaveLength(1000);
  expect(entries[0]?.label).toBe('event-5');
  expect(entries.at(-1)?.label).toBe('event-1004');
});

test('traceProjectDebugOperation records input and output around an async call', async () => {
  clearProjectDebugTrace();

  const result = await traceProjectDebugOperation(
    { layer: 'web', label: 'external-agent.input', sessionId: 'ses_100000000000', data: { id: 'exa_100000000000' } },
    async () => ({ ok: true })
  );

  expect(result).toEqual({ ok: true });
  expect(projectDebugTraceSnapshot().map((entry) => entry.direction)).toEqual(['input', 'output']);
  expect(projectDebugTraceSnapshot()[1]?.data).toMatchObject({ result: { ok: true } });
});

test('traceProjectDebugOperation records errors and rethrows', async () => {
  clearProjectDebugTrace();

  await expect(
    traceProjectDebugOperation({ layer: 'web', label: 'send' }, async () => {
      throw new Error('failed');
    })
  ).rejects.toThrow('failed');

  expect(projectDebugTraceSnapshot().map((entry) => entry.direction)).toEqual(['input', 'error']);
  expect(projectDebugTraceSnapshot()[1]?.data).toMatchObject({ message: 'failed' });
});
