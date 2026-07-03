import { expect, test } from 'bun:test';

import { experienceFanoutRequestSchema, experienceProjectionEventSchema } from '../src/workplace-project.ts';

test('experience fanout request keeps project membership separate from transport details', () => {
  const parsed = experienceFanoutRequestSchema.parse({
    projectId: 'prj_PROJECT',
    experienceId: 'chat-room',
    triggerMessageId: 'msg_TRIGGER',
    triggerMessageSeq: 12,
    recipients: [
      { participantId: 'monad', displayName: 'Monad', transport: 'monad' },
      { participantId: 'native-cli:codex', displayName: 'Codex', transport: 'native-cli', runtimeId: 'ncli_1' },
      { participantId: 'acp:reviewer', displayName: 'Reviewer', transport: 'acp' }
    ],
    createdAt: '2026-06-28T00:00:00.000Z'
  });

  expect(parsed.recipients.map((recipient) => recipient.transport)).toEqual(['monad', 'native-cli', 'acp']);
  expect(experienceFanoutRequestSchema.safeParse({ ...parsed, recipients: [] }).success).toBe(false);
});

test('experience projection event is ordered projection state, not provider raw output', () => {
  const parsed = experienceProjectionEventSchema.parse({
    id: 'projection_1',
    projectId: 'prj_PROJECT',
    experienceId: 'chat-room',
    kind: 'thinking',
    orderKey: 12,
    participantId: 'native-cli:codex',
    sourceDeliveryId: 'deliv_ABC123',
    payload: {
      fanoutAgents: ['native-cli:codex', 'native-cli:claude-code'],
      text: 'Agents are working'
    },
    output: '{"raw":"provider frame"}',
    createdAt: '2026-06-28T00:00:01.000Z'
  });

  expect(parsed.kind).toBe('thinking');
  expect(parsed.payload).toEqual({
    fanoutAgents: ['native-cli:codex', 'native-cli:claude-code'],
    text: 'Agents are working'
  });
  expect('output' in parsed).toBe(false);
  expect(experienceProjectionEventSchema.safeParse({ ...parsed, sourceDeliveryId: 'msg_NOT_DELIVERY' }).success).toBe(
    false
  );
});
