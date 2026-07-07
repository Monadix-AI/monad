import type { Event } from '@monad/protocol';

import { SSE_HEARTBEAT_MS } from '@monad/protocol';

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

/**
 * Periodically write a `:` comment (ignored by SSE parsers) to a stream so an idle-but-open
 * connection keeps flowing bytes — this resets idle timers on the client's watchdog and on any
 * intermediary proxy, so a quiet session between turns isn't silently reaped. Returns a stopper;
 * call it on close/cancel. Self-stops if the controller is already closed.
 */
export function startSseHeartbeat(
  ctrl: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  ms: number = SSE_HEARTBEAT_MS
): () => void {
  const frame = encoder.encode(': keepalive\n\n');
  const timer = setInterval(() => {
    try {
      ctrl.enqueue(frame);
    } catch {
      clearInterval(timer); // stream already closed/errored — stop
    }
  }, ms);
  return () => clearInterval(timer);
}

/**
 * Build an SSE `Response` for a live push source of typed values (external agent auth/observation
 * snapshots, etc. — as opposed to the durable session event bus). The source is subscribed *now*, so
 * the current snapshot is captured even before the browser's stream opens; values emitted before
 * `start` run are buffered and flushed in order once it does. A value emitted with `done: true` is the
 * last one — it is flushed and the stream is then closed. The subscription is disposed on drop
 * (bounded-sink backlog), on `done`, and on client cancel.
 */
export function createPushSseResponse<T>(params: {
  encoder: TextEncoder;
  encode: (value: T) => Uint8Array;
  subscribe: (emit: (value: T, done?: boolean) => void) => { dispose: () => void };
}): Response {
  const { encoder, encode, subscribe } = params;
  const pending: Array<{ value: T; done: boolean }> = [];
  let sink: ((value: T) => void) | undefined;
  let close: (() => void) | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    subscription.dispose();
    close?.();
  };

  const subscription = subscribe((value, done = false) => {
    if (finished) return;
    if (sink) {
      sink(value);
      if (done) finish();
    } else {
      pending.push({ value, done });
    }
  });

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      stopHeartbeat = startSseHeartbeat(ctrl, encoder);
      close = () => {
        stopHeartbeat?.();
        try {
          ctrl.close();
        } catch {
          // already closed/errored by the bounded sink — nothing to do
        }
      };
      sink = createBoundedSseEncoderSink<T>(ctrl, encode, () => {
        stopHeartbeat?.();
        subscription.dispose();
      });
      for (const item of pending.splice(0)) {
        sink(item.value);
        if (item.done) {
          finish();
          return;
        }
      }
    },
    cancel() {
      stopHeartbeat?.();
      sink = undefined;
      close = undefined;
      subscription.dispose();
      finished = true;
    }
  });
  return createSseResponse(stream);
}
