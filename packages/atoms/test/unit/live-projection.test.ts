import { expect, test } from 'bun:test';
import { createConvenienceLiveProjector, toConvenienceEvents } from '@monad/sdk-atom';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';

const openclaw = builtinAgentAdapters.find((adapter) => adapter.provider === 'openclaw');
if (!openclaw) throw new Error('openclaw adapter required');

const ESC = String.fromCharCode(27);

const agentEvent = (payload: Record<string, unknown>) =>
  `${JSON.stringify({ type: 'event', event: 'agent', payload: { runId: 'run-1', sessionKey: 'agent:main', ...payload } })}\n`;

// The production convenience pipeline's contract: a projected event may be UPDATED by later rows,
// never dropped. The row shapes below reproduce a captured live log — a lifecycle start, an ANSI
// process-log line interleaved on stdout, then two thinking deltas.
test('the shared live projection only ever grows or updates events across rows', () => {
  const rows = [
    agentEvent({ stream: 'lifecycle', data: { phase: 'start' } }),
    `${ESC}[90m2026-08-19T11:23:29+08:00${ESC}[39m ${ESC}[33m[provider-transport-fetch]${ESC}[39m model-fetch start\n`,
    agentEvent({ stream: 'thinking', data: { text: 'The', delta: 'The' } }),
    agentEvent({ stream: 'thinking', data: { text: 'The user is', delta: ' user is' } })
  ];
  const projector = createConvenienceLiveProjector(openclaw, { id: 'mesh_test' });
  let previous = new Map<string, string>();
  for (const row of rows) {
    const page = projector.advance(row, '2026-08-19T03:23:29.000Z');
    const events = toConvenienceEvents(openclaw, page.events);
    const current = new Map(events.map((event) => [event.id, event.text ?? '']));
    for (const [id] of previous) {
      expect(current.has(id)).toBe(true);
    }
    previous = current;
  }
  expect([...previous.values()].some((text) => text.includes('The user is'))).toBe(true);
});
