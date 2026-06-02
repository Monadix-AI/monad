import type { Event } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { collectInlineTurn } from '#/handlers/session/inline-turn.ts';

const producer = { kind: 'agent', agentId: 'agt_100000000000' } as const;

const message = (text: string, status: 'complete' | 'error') => ({
  id: 'msg_100000000000',
  sessionId: 'ses_100000000000',
  role: 'assistant' as const,
  text,
  type: 'text' as const,
  stream: { status },
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z'
});

const event = (type: Event['type'], payload: Record<string, unknown>): Event => ({
  id: 'evt_100000000000',
  sessionId: 'ses_100000000000',
  type,
  actorAgentId: null,
  payload,
  at: '2026-01-01T00:00:00.000Z'
});

test('collectInlineTurn consumes canonical delta and completed message events', async () => {
  const progress: string[] = [];
  const result = await collectInlineTurn(
    async (sink) => {
      sink(
        event('session.message.delta.appended', {
          transcriptTargetId: 'ses_100000000000',
          messageId: 'msg_100000000000',
          producer,
          channel: 'answer',
          index: 0,
          delta: 'hel'
        })
      );
      sink(
        event('session.message.delta.appended', {
          transcriptTargetId: 'ses_100000000000',
          messageId: 'msg_100000000000',
          producer,
          channel: 'answer',
          index: 1,
          delta: 'lo'
        })
      );
      sink(
        event('session.message.completed', {
          transcriptTargetId: 'ses_100000000000',
          producer,
          message: message('hello', 'complete'),
          messageRevision: 3
        })
      );
    },
    (text) => progress.push(text)
  );

  expect(progress).toEqual(['hel', 'hello']);
  expect(result).toEqual({ finalText: 'hello', streamed: 'hello', errorMessage: undefined });
});

test('collectInlineTurn derives the failure text from a canonical failed message', async () => {
  const result = await collectInlineTurn(async (sink) => {
    sink(
      event('session.message.failed', {
        transcriptTargetId: 'ses_100000000000',
        producer,
        message: message('provider unavailable', 'error'),
        messageRevision: 2
      })
    );
  });

  expect(result).toEqual({ finalText: '', streamed: '', errorMessage: 'provider unavailable' });
});
