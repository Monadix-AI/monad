import type { DeveloperLogRecord, SessionId, SessionUiEvent } from '@monad/protocol';

import { subscribeDeveloperLogRecords } from '@monad/logger';
import { developerLogRecordSchema } from '@monad/protocol';

import { createDaemonHandlers } from '@/handlers/handlers.ts';
import {
  createBoundedSseEncoderSink,
  createBoundedSseSink,
  createSseResponse,
  encodeSseFrame
} from '@/transports/http/sessions/sse.ts';

export function wantsInlineSessionStream(acceptHeader: string | undefined): boolean {
  return (acceptHeader ?? '').includes('text/event-stream');
}

export function createSessionMessageSseResponse(params: {
  handlers: ReturnType<typeof createDaemonHandlers>;
  sessionId: SessionId;
  text: string;
  ambientContext?: string;
  encoder: TextEncoder;
}): Response {
  const { handlers, sessionId, text, ambientContext, encoder } = params;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const sink = createBoundedSseSink(ctrl, encoder, () => void handlers.session.abort({ id: sessionId }));
      try {
        await handlers.session.sendInline({ sessionId, text }, sink, { transport: 'http', ambientContext });
      } finally {
        try {
          ctrl.close();
        } catch {
          // the bounded sink may have already closed the stream after dropping a slow consumer
        }
      }
    },
    cancel() {
      void handlers.session.abort({ id: sessionId });
    }
  });

  return createSseResponse(stream);
}

export async function createSessionEventsSseResponse(params: {
  handlers: ReturnType<typeof createDaemonHandlers>;
  sessionId: SessionId;
  afterEventId?: string;
  encoder: TextEncoder;
}): Promise<Response> {
  const { handlers, sessionId, afterEventId, encoder } = params;
  let disposeRef: (() => void) | undefined;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      // onDrop fires only after a backlog builds, by which point subscribe() has returned and
      // disposeRef is set; releasing the subscription stops the push so the queue can't regrow.
      const sink = createBoundedSseSink(ctrl, encoder, () => disposeRef?.());
      const { dispose } = await handlers.session.subscribe({ sessionId, afterEventId }, sink);
      // Guard against cancel() firing before subscribe() resolved (client disconnected during
      // event replay) — the subscription was created but cancel() missed it, so dispose now.
      if (cancelled) {
        dispose();
        return;
      }
      disposeRef = dispose;
    },
    cancel() {
      cancelled = true;
      disposeRef?.();
    }
  });

  return createSseResponse(stream);
}

export async function createSessionUiEventsSseResponse(params: {
  handlers: ReturnType<typeof createDaemonHandlers>;
  sessionId: SessionId;
  afterEventId?: string;
  encoder: TextEncoder;
}): Promise<Response> {
  const { handlers, sessionId, afterEventId, encoder } = params;
  let disposeRef: (() => void) | undefined;
  let cancelled = false;
  let sinkRef: ((event: SessionUiEvent) => void) | undefined;
  const pending: SessionUiEvent[] = [];

  const forward = (event: SessionUiEvent): void => {
    if (cancelled) return;
    if (sinkRef) {
      sinkRef(event);
      return;
    }
    pending.push(event);
  };

  const { dispose } = await handlers.session.subscribeUi({ sessionId, afterEventId }, forward);
  if (cancelled) dispose();
  else disposeRef = dispose;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      if (cancelled) {
        try {
          ctrl.close();
        } catch {}
        return;
      }
      sinkRef = createBoundedSseEncoderSink<SessionUiEvent>(
        ctrl,
        (event) => encodeSseFrame({ id: event.cursor, event: event.kind, data: event }, encoder),
        () => disposeRef?.()
      );
      for (const event of pending.splice(0)) sinkRef(event);
    },
    cancel() {
      cancelled = true;
      sinkRef = undefined;
      disposeRef?.();
      disposeRef = undefined;
    }
  });

  return createSseResponse(stream);
}

export function createSessionLogsSseResponse(params: { sessionId: SessionId; encoder: TextEncoder }): Response {
  const { sessionId, encoder } = params;
  let disposeRef: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(': connected\n\n'));
      const sink = createBoundedSseEncoderSink<DeveloperLogRecord>(
        ctrl,
        (record) => encodeSseFrame({ event: 'log', data: record }, encoder),
        () => disposeRef?.()
      );
      disposeRef = subscribeDeveloperLogRecords((record) => {
        if (record.sessionId !== sessionId || typeof record.level !== 'number') return;
        // Validate at the wire boundary instead of casting (records are already redacted upstream).
        const parsed = developerLogRecordSchema.safeParse(record);
        if (parsed.success) sink(parsed.data);
      });
    },
    cancel() {
      disposeRef?.();
      disposeRef = undefined;
    }
  });

  return createSseResponse(stream);
}
