import type { SessionId, SessionUiEvent } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createSessionUiEventsSseResponse } from '#/transports/http/sessions/stream.ts';

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

function uiUpsert(): SessionUiEvent {
  return {
    kind: 'upsert',
    cursor: newId('evt'),
    item: {
      kind: 'message',
      id: newId('msg'),
      role: 'assistant',
      parts: [{ type: 'text', text: 'x'.repeat(64) }],
      replyable: false,
      seq: newId('evt')
    }
  };
}

test('createSessionUiEventsSseResponse drops a stalled consumer and disposes its subscription instead of buffering unboundedly', async () => {
  let disposed = false;
  let emitLive: ((event: SessionUiEvent) => void) | undefined;
  const handlers = {
    session: {
      subscribeUi: async (
        _args: { sessionId: SessionId; afterEventId?: string },
        sink: (event: SessionUiEvent) => void
      ) => {
        emitLive = sink;
        return {
          subscribed: true as const,
          dispose: () => {
            disposed = true;
          }
        };
      }
    }
  } as unknown as ReturnType<typeof createDaemonHandlers>;

  await createSessionUiEventsSseResponse({
    handlers,
    sessionId: newId('ses') as SessionId,
    encoder: new TextEncoder()
  });
  // Never read the body — the same "stalled consumer" shape sse-backpressure.test.ts uses against the
  // generic sink primitive, but exercised here through the actual ui-stream response wrapper (byte-
  // bounded stream + bounded encoder sink + dispose wiring), which had no dedicated test before this.
  for (let i = 0; i < 20_000; i++) emitLive?.(uiUpsert());

  expect(disposed).toBe(true);
});

// A single shared subscription registry standing in for the daemon's real bus.subscribe fan-out:
// every subscribeUi call registers into the SAME sink list, and `publish` invokes every currently
// registered sink with the SAME event object, in registration order — the actual "one publish, many
// independent consumers" shape a real session's bus produces, not two unrelated fake sources.
function makeFanOutSubscribeUi() {
  const sinks: Array<{ sink: (event: SessionUiEvent) => void; disposed: boolean }> = [];
  const handlers = {
    session: {
      subscribeUi: async (
        _args: { sessionId: SessionId; afterEventId?: string },
        sink: (event: SessionUiEvent) => void
      ) => {
        const entry = { sink, disposed: false };
        sinks.push(entry);
        return { subscribed: true as const, dispose: () => (entry.disposed = true) };
      }
    }
  } as unknown as ReturnType<typeof createDaemonHandlers>;
  return {
    handlers,
    publish: (event: SessionUiEvent) => {
      for (const entry of sinks) entry.sink(event);
    },
    isDisposed: (index: number) => sinks[index]?.disposed ?? false
  };
}

function decodeSseChunk(value: Uint8Array | undefined): SessionUiEvent {
  const text = new TextDecoder().decode(value);
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`no data line in chunk: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length)) as SessionUiEvent;
}

test('createSessionUiEventsSseResponse: a stalled consumer sharing the SAME fan-out source as a healthy consumer is dropped without affecting the healthy one', async () => {
  const { handlers, publish, isDisposed } = makeFanOutSubscribeUi();
  const sessionId = newId('ses') as SessionId;

  // Subscription 0 = A (will stall), subscription 1 = B (will actively drain) — both registered
  // against the one shared `publish` source above, so every event below reaches both simultaneously.
  const responseA = await createSessionUiEventsSseResponse({ handlers, sessionId, encoder: new TextEncoder() });
  const responseB = await createSessionUiEventsSseResponse({ handlers, sessionId, encoder: new TextEncoder() });
  const readerA = responseA.body?.getReader();
  const readerB = responseB.body?.getReader();
  if (!readerA || !readerB) throw new Error('response body reader missing');

  // Publish the SAME sequence of events to both subscribers from the one shared source. B reads after
  // every publish (a genuinely healthy, keeping-up consumer); A's reader is never touched here, so its
  // own queue accumulates unboundedly from the identical fan-out while B's stays drained.
  const published: SessionUiEvent[] = [];
  const receivedByB: SessionUiEvent[] = [];
  for (let i = 0; i < 20_000; i++) {
    const evt = uiUpsert();
    published.push(evt);
    publish(evt);
    const chunk = await readerB.read();
    if (!chunk.done) receivedByB.push(decodeSseChunk(chunk.value));
  }

  // B received the exact published sequence, in order, with nothing missing or duplicated — real
  // fan-out isolation, not two independently-fed fakes that never interacted.
  expect(receivedByB.map((e) => e.cursor)).toEqual(published.map((e) => e.cursor));
  expect(isDisposed(1)).toBe(false);

  // A, sharing the identical source and never drained, was overflowed and dropped: draining its
  // already-queued backlog eventually reaches `done`.
  let doneA = false;
  for (let i = 0; i < published.length && !doneA; i++) {
    const chunk = await readerA.read();
    doneA = chunk.done;
  }
  expect(doneA).toBe(true);
  expect(isDisposed(0)).toBe(true);

  // B is still live and independently functional after A's drop: a fresh publish still reaches it.
  const trailing = uiUpsert();
  publish(trailing);
  const trailingChunk = await readerB.read();
  expect(trailingChunk.done).toBe(false);
  expect(decodeSseChunk(trailingChunk.value).cursor).toBe(trailing.cursor);
  expect(isDisposed(1)).toBe(false);
});
