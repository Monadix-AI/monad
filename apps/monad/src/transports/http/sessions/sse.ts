import type { Event } from '@monad/protocol';

export const SSE_RESPONSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  // `no-transform` stops any intermediary (proxy, CDN) from gzip-buffering the stream; combined
  // with `X-Accel-Buffering: no` (nginx) it keeps event frames flushing live to the consumer.
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no'
} as const;

function encodeSseEvent(event: Event, encoder: TextEncoder): Uint8Array {
  return encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function encodeSseFrame(frame: { id?: string; event: string; data: unknown }, encoder: TextEncoder): Uint8Array {
  return encoder.encode(
    `${frame.id ? `id: ${frame.id}\n` : ''}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`
  );
}

/**
 * A slow SSE consumer (e.g. a stalled browser tab) must not grow the daemon's memory: the push
 * sink enqueues faster than the socket drains and the stream's internal queue is unbounded. So
 * past a backlog cap we drop the consumer instead of buffering forever — events are persisted,
 * so it reconnects and resumes from its last event id with no loss.
 *
 * `desiredSize` is the default (count) queue's headroom: it starts at the highWaterMark and goes
 * negative as we over-enqueue, so `< -MAX_SSE_BACKLOG` means the consumer is ~that many events
 * behind. `onDrop` releases the upstream subscription when we cut a consumer loose.
 */
const MAX_SSE_BACKLOG = 1024;

export function createBoundedSseSink(
  ctrl: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  onDrop: () => void
): (event: Event) => void {
  return createBoundedSseEncoderSink(ctrl, (event) => encodeSseEvent(event, encoder), onDrop);
}

export function createBoundedSseEncoderSink<T>(
  ctrl: ReadableStreamDefaultController<Uint8Array>,
  encode: (value: T) => Uint8Array,
  onDrop: () => void
): (value: T) => void {
  let dropped = false;
  return (value: T) => {
    if (dropped) return; // the sink keeps firing after we cut the consumer loose; ignore
    ctrl.enqueue(encode(value));
    if (ctrl.desiredSize !== null && ctrl.desiredSize < -MAX_SSE_BACKLOG) {
      dropped = true;
      onDrop();
      try {
        ctrl.close();
      } catch {
        // already closed/errored — nothing to do
      }
    }
  };
}

export function createSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { headers: SSE_RESPONSE_HEADERS });
}
