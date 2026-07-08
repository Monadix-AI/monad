import type { Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createBoundedSseSink } from '@/transports/http/sessions/sse.ts';

function evt(): Event {
  return {
    id: newId('evt'),
    sessionId: newId('ses') as SessionId,
    type: 'agent.token',
    actorAgentId: newId('agt'),
    payload: { text: 'x'.repeat(64) },
    at: new Date().toISOString()
  } as Event;
}

test('bounded SSE sink delivers normally while a consumer keeps up', async () => {
  const encoder = new TextEncoder();
  let dropped = false;
  const reads: Uint8Array[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const sink = createBoundedSseSink(ctrl, encoder, () => {
        dropped = true;
      });
      // Push a handful and let the reader drain between pushes (desiredSize stays healthy).
      sink(evt());
      sink(evt());
      ctrl.close();
    }
  });

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) reads.push(value);
  }
  expect(reads.length).toBe(2);
  expect(dropped).toBe(false);
});

test('bounded SSE sink drops a stalled consumer instead of buffering unboundedly', () => {
  const encoder = new TextEncoder();
  let dropCount = 0;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const realClose = ctrl.close.bind(ctrl);
      // Observe close without breaking it.
      (ctrl as { close: () => void }).close = () => {
        closed = true;
        realClose();
      };
      const sink = createBoundedSseSink(ctrl, encoder, () => {
        dropCount++;
      });
      // Never read → the queue only grows. Far past the backlog cap (1024).
      for (let i = 0; i < 5000; i++) sink(evt());
    }
  });
  void stream; // we never read; the point is the producer side bailed out

  expect(closed).toBe(true);
  expect(dropCount).toBe(1); // dropped exactly once, then a no-op
});
