import type { MonadClient, StreamError } from '@monad/client';
import type { ChatMessage, MessageGenerationFrame, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createMonadStore, monadApi } from '../../src/index.ts';

type LooseEndpoint = {
  initiate: (arg?: unknown) => unknown;
  select: (arg?: unknown) => (state: unknown) => { data?: unknown };
};

function endpoint(name: string): LooseEndpoint {
  const value = (monadApi.endpoints as Record<string, LooseEndpoint | undefined>)[name];
  if (!value) throw new Error(`missing endpoint: ${name}`);
  return value;
}

const sessionId = 'ses_100000000000' as SessionId;
const message: ChatMessage = {
  id: 'msg_100000000000',
  sessionId,
  role: 'assistant',
  text: '',
  type: 'markdown',
  stream: { status: 'streaming', source: { transcriptTargetId: sessionId, messageId: 'msg_100000000000' } },
  active: true,
  createdAt: '2026-07-19T00:00:00.000Z'
};

const snapshot: MessageGenerationFrame = { kind: 'snapshot', message, messageRevision: 1, deltas: [] };
const terminal: MessageGenerationFrame = {
  kind: 'event',
  event: {
    id: 'evt_100000000002',
    sessionId,
    type: 'session.message.completed',
    actorAgentId: null,
    payload: {
      transcriptTargetId: sessionId,
      producer: { kind: 'system', subsystem: 'client-rtk-test' },
      message: { ...message, text: 'done', stream: { status: 'complete' } },
      messageRevision: 2
    },
    at: '2026-07-19T00:00:01.000Z'
  }
};

function baseClient(streamMessageGeneration: MonadClient['streamMessageGeneration']): MonadClient {
  return {
    treaty: { v1: {}, health: { get: async () => ({ data: { status: 'ok', version: '1.0.0' }, error: null }) } },
    fetch: async () => new Response(null, { status: 404 }),
    subscribeControl: () => () => {},
    streamEvents: () => () => {},
    streamMessageGeneration
  } as unknown as MonadClient;
}

test('streamMessageGeneration caches validated frames and disposes when the cache is reset', async () => {
  let onFrame: ((frame: MessageGenerationFrame) => void) | undefined;
  let observed: unknown;
  let disposals = 0;
  const client = baseClient((observedSessionId, observedMessageId, handler, opts) => {
    observed = {
      sessionId: observedSessionId,
      messageId: observedMessageId,
      afterEventId: opts?.afterEventId
    };
    onFrame = handler;
    return () => {
      disposals++;
    };
  });
  const store = createMonadStore({ client });
  const arg = { sessionId, messageId: message.id, afterEventId: 'evt_100000000001' as const };
  const subscription = store.dispatch(endpoint('streamMessageGeneration').initiate(arg) as never) as Promise<unknown>;
  await subscription;

  onFrame?.(snapshot);
  onFrame?.(terminal);
  await Promise.resolve();

  expect(observed).toEqual({
    sessionId,
    messageId: message.id,
    afterEventId: 'evt_100000000001'
  });
  expect(endpoint('streamMessageGeneration').select(arg)(store.getState()).data).toEqual({
    frames: [snapshot, terminal],
    streamError: null
  });

  store.dispatch(monadApi.util.resetApiState());
  await Promise.resolve();
  expect(disposals).toBe(1);
});

test('streamMessageGeneration records the latest stream error in its cache entry', async () => {
  let onError: ((error: StreamError) => void) | undefined;
  const client = baseClient((_sessionId, _messageId, _handler, opts) => {
    onError = opts?.onError;
    return () => {};
  });
  const store = createMonadStore({ client });
  const arg = { sessionId, messageId: message.id };
  const subscription = store.dispatch(endpoint('streamMessageGeneration').initiate(arg) as never) as Promise<unknown>;
  await subscription;

  onError?.({ kind: 'fatal', status: 404 });
  await Promise.resolve();

  expect(endpoint('streamMessageGeneration').select(arg)(store.getState()).data).toEqual({
    frames: [],
    streamError: { kind: 'fatal', status: 404 }
  });
});

test('streamMessageGeneration disposes immediately when its final subscriber leaves', async () => {
  let disposals = 0;
  const client = baseClient(() => () => {
    disposals++;
  });
  const store = createMonadStore({ client });
  const arg = { sessionId, messageId: message.id };
  const subscription = store.dispatch(
    endpoint('streamMessageGeneration').initiate(arg) as never
  ) as Promise<unknown> & {
    unsubscribe(): void;
  };
  await subscription;

  subscription.unsubscribe();
  await Bun.sleep(10);

  expect(disposals).toBe(1);
});
