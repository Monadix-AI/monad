import { expect, test } from 'bun:test';
import { z } from 'zod';

import { EVENT_TABLE, parseEventPayload } from '../src/event-table.ts';

test('every EVENT_TABLE entry is a ZodType', () => {
  for (const [type, schema] of Object.entries(EVENT_TABLE)) {
    expect(schema instanceof z.ZodType, `${type} is not a ZodType`).toBe(true);
  }
});

test('external agent connection required events carry provider reconnect guidance', () => {
  const payload = parseEventPayload('external_agent.connection_required', {
    externalAgentSessionId: 'exa_1',
    agentName: 'gemini',
    provider: 'gemini',
    reason: 'Gemini CLI is waiting for provider authentication to complete.',
    reconnectIn: 'studio'
  });

  expect(payload).toEqual({
    externalAgentSessionId: 'exa_1',
    agentName: 'gemini',
    provider: 'gemini',
    reason: 'Gemini CLI is waiting for provider authentication to complete.',
    reconnectIn: 'studio'
  });
});
