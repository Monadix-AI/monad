import type { Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import {
  createBoundedSseEncoderSink,
  createBoundedSseSink,
  SSE_MAX_QUEUED_BYTES,
  sseByteQueuingStrategy
} from '#/transports/http/sessions/sse.ts';

function evt(): Event {
  const sessionId = newId('ses') as SessionId;
  return {
    id: newId('evt'),
    sessionId,
    type: 'session.message.delta.appended',
    actorAgentId: newId('agt'),
    payload: {
      transcriptTargetId: sessionId,
      producer: { kind: 'agent', agentId: 'agt_100000000000' },
      messageId: newId('msg'),
      channel: 'answer',
      index: 0,
      delta: 'x'.repeat(64)
    },
    at: new Date().toISOString()
  };
}

test('bounded SSE sink delivers normally while a consumer keeps up', async () => {
  const encoder = new TextEncoder();
  let dropped = false;
  const reads: Uint8Array[] = [];

  const stream = new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        const sink = createBoundedSseSink(ctrl, encoder, () => {
          dropped = true;
        });
        // Push a handful and let the reader drain between pushes (desiredSize stays healthy).
        sink(evt());
        sink(evt());
        ctrl.close();
      }
    },
    sseByteQueuingStrategy
  );

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

  const stream = new ReadableStream<Uint8Array>(
    {
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
        // Never read → the queue only grows beyond the encoded-byte budget.
        for (let i = 0; i < 20_000; i++) sink(evt());
      }
    },
    sseByteQueuingStrategy
  );
  void stream; // we never read; the point is the producer side bailed out

  expect(closed).toBe(true);
  expect(dropCount).toBe(1); // dropped exactly once, then a no-op
});

test('bounded SSE sink rejects a frame before it exceeds the byte budget', async () => {
  let dropCount = 0;
  let closed = false;
  const oversized = new Uint8Array(SSE_MAX_QUEUED_BYTES + 1);

  const stream = new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        const realClose = ctrl.close.bind(ctrl);
        (ctrl as { close: () => void }).close = () => {
          closed = true;
          realClose();
        };
        const sink = createBoundedSseEncoderSink(
          ctrl,
          () => oversized,
          () => {
            dropCount += 1;
          }
        );
        sink(undefined);
      }
    },
    sseByteQueuingStrategy
  );
  const first = await stream.getReader().read();

  expect({ closed, dropCount, first }).toEqual({
    closed: true,
    dropCount: 1,
    first: { done: true, value: undefined }
  });
});
