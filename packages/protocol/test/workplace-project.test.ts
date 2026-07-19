import { expect, test } from 'bun:test';

import { experienceFanoutRequestSchema, experienceProjectionEventSchema } from '../src/workplace-project.ts';

test('experience fanout request keeps project membership separate from transport details', () => {
  const parsed = experienceFanoutRequestSchema.parse({
    projectId: 'prj_PROJECT00000',
    experienceId: 'chat-room',
    triggerMessageId: 'msg_TRIGGER00000',
    triggerMessageSeq: 12,
    recipients: [
      { participantId: 'monad', displayName: 'Monad', transport: 'monad' },
      {
        participantId: 'mesh-agent:codex',
        displayName: 'Codex',
        transport: 'mesh-agent',
        runtimeId: 'mesh_100000000000'
      },
      { participantId: 'acp:reviewer', displayName: 'Reviewer', transport: 'acp' }
    ],
    createdAt: '2026-06-28T00:00:00.000Z'
  });

  expect(parsed.recipients.map((recipient) => recipient.transport)).toEqual(['monad', 'mesh-agent', 'acp']);
  expect(experienceFanoutRequestSchema.safeParse({ ...parsed, recipients: [] }).success).toBe(false);
});

test('experience projection event is ordered projection state, not provider raw output', () => {
  const parsed = experienceProjectionEventSchema.parse({
    id: 'projection_1',
    projectId: 'prj_PROJECT00000',
    experienceId: 'chat-room',
    kind: 'thinking',
    orderKey: 12,
    participantId: 'mesh-agent:codex',
    sourceDeliveryId: 'deliv_ABC123000000',
    payload: {
      fanoutAgents: ['mesh-agent:codex', 'mesh-agent:claude-code'],
      text: 'Agents are working'
    },
    output: '{"raw":"provider frame"}',
    createdAt: '2026-06-28T00:00:01.000Z'
  });

  expect(parsed.kind).toBe('thinking');
  expect(parsed.payload).toEqual({
    fanoutAgents: ['mesh-agent:codex', 'mesh-agent:claude-code'],
    text: 'Agents are working'
  });
  expect('output' in parsed).toBe(false);
  expect(experienceProjectionEventSchema.safeParse({ ...parsed, sourceDeliveryId: 'msg_NOTDELIVERY0' }).success).toBe(
    false
  );
});
