import type { SessionId, SessionUiEvent } from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createSessionUiEventsSseResponse } from '@/transports/http/sessions/stream.ts';

function uiSnapshot(): SessionUiEvent {
  return {
    kind: 'snapshot',
    cursor: newId('evt'),
    items: []
  };
}

test('createSessionUiEventsSseResponse fails before committing a 200 when subscribeUi setup throws', async () => {
  const handlers = {
    session: {
      subscribeUi: async () => {
        throw new Error('boom');
      }
    }
  } as unknown as ReturnType<typeof createDaemonHandlers>;

  await expect(
    createSessionUiEventsSseResponse({
      handlers,
      sessionId: newId('ses') as SessionId,
      encoder: new TextEncoder()
    })
  ).rejects.toThrow('boom');
});

test('createSessionUiEventsSseResponse buffers early UI events until the stream starts reading', async () => {
  const first = uiSnapshot();
  let emitLive: ((event: SessionUiEvent) => void) | undefined;

  const handlers = {
    session: {
      subscribeUi: async (
        _args: { sessionId: SessionId; afterEventId?: string },
        sink: (event: SessionUiEvent) => void
      ) => {
        sink(first);
        emitLive = sink;
        return { subscribed: true as const, dispose: () => {} };
      }
    }
  } as unknown as ReturnType<typeof createDaemonHandlers>;

  const response = await createSessionUiEventsSseResponse({
    handlers,
    sessionId: newId('ses') as SessionId,
    encoder: new TextEncoder()
  });

  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  if (!reader) throw new Error('response body reader missing');
  const firstChunk = await reader.read();
  expect(firstChunk.done).toBe(false);
  expect(new TextDecoder().decode(firstChunk.value)).toContain(`data: ${JSON.stringify(first)}`);

  const second = uiSnapshot();
  emitLive?.(second);
  const secondChunk = await reader.read();
  expect(secondChunk.done).toBe(false);
  expect(new TextDecoder().decode(secondChunk.value)).toContain(`data: ${JSON.stringify(second)}`);
});
