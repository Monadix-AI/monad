import type { EventHandler, MonadClient } from '@monad/client';
import type { Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { streamReply } from '../../src/lib/chat.ts';

const sessionId = 'ses_100000000000' as SessionId;

function event(type: Event['type'], payload: Record<string, unknown>): Event {
  return {
    id: 'evt_100000000000',
    sessionId,
    type,
    actorAgentId: null,
    payload,
    at: '2026-07-19T00:00:00.000Z'
  };
}

function clientWithEvents(events: Event[]): MonadClient {
  return {
    sendStreamable: async (_sessionId: SessionId, _text: string, onEvent: EventHandler) => {
      for (const item of events) onEvent(item);
    }
  } as unknown as MonadClient;
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('streamReply renders answer deltas and closes on the canonical completed event', async () => {
  const output = await captureStdout(() =>
    streamReply(
      clientWithEvents([
        event('session.message.delta.appended', {
          transcriptTargetId: sessionId,
          messageId: 'msg_100000000000',
          producer: { kind: 'agent', agentId: 'agt_100000000000' },
          channel: 'answer',
          index: 0,
          delta: 'Hello '
        }),
        event('session.message.delta.appended', {
          transcriptTargetId: sessionId,
          messageId: 'msg_100000000000',
          producer: { kind: 'agent', agentId: 'agt_100000000000' },
          channel: 'reasoning',
          index: 0,
          delta: 'hidden'
        }),
        event('session.message.delta.appended', {
          transcriptTargetId: sessionId,
          messageId: 'msg_100000000000',
          producer: { kind: 'agent', agentId: 'agt_100000000000' },
          channel: 'answer',
          index: 1,
          delta: 'world'
        }),
        event('session.message.completed', {
          transcriptTargetId: sessionId,
          producer: { kind: 'agent', agentId: 'agt_100000000000' },
          messageRevision: 3,
          message: {
            id: 'msg_100000000000',
            sessionId,
            role: 'assistant',
            text: 'Hello world',
            type: 'text',
            stream: { status: 'complete' },
            active: true,
            createdAt: '2026-07-19T00:00:00.000Z'
          }
        })
      ]),
      sessionId,
      'hi'
    )
  );

  expect(output).toBe('Monad ▸ Hello world\n');
});

test('streamReply rejects a malformed canonical failed payload', async () => {
  await expect(
    captureStdout(() =>
      streamReply(
        clientWithEvents([
          event('session.message.failed', {
            transcriptTargetId: sessionId,
            messageRevision: 1
          })
        ]),
        sessionId,
        'hi'
      )
    )
  ).rejects.toThrow(/"message"/);
});

test('streamReply closes a partial answer on failure without printing the terminal text twice', async () => {
  const output = await captureStdout(() =>
    streamReply(
      clientWithEvents([
        event('session.message.delta.appended', {
          transcriptTargetId: sessionId,
          messageId: 'msg_100000000000',
          producer: { kind: 'agent', agentId: 'agt_100000000000' },
          channel: 'answer',
          index: 0,
          delta: 'partial'
        }),
        event('session.message.failed', {
          transcriptTargetId: sessionId,
          producer: { kind: 'agent', agentId: 'agt_100000000000' },
          messageRevision: 2,
          message: {
            id: 'msg_100000000000',
            sessionId,
            role: 'assistant',
            text: 'partial [upstream_error] request failed',
            type: 'error',
            stream: { status: 'error' },
            active: true,
            createdAt: '2026-07-19T00:00:00.000Z'
          }
        })
      ]),
      sessionId,
      'hi'
    )
  );

  expect(output).toBe('Monad ▸ partial\n');
});
