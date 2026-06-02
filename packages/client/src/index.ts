import type {
  DeveloperLogRecord,
  Event,
  EventId,
  SendMessageResponse,
  SessionId,
  SessionUiEvent
} from '@monad/protocol';
import type { MonadTreaty, MonadTreatyConfig } from './treaty.ts';

import { CONTROL_API_VERSION, developerLogRecordSchema, eventSchema, sessionUiEventSchema } from '@monad/protocol';

import { EventSocket } from './event-socket.ts';
import { createMonadTreaty, makeLoopbackHttpsFetcher, makeUnixFetcher } from './treaty.ts';

export interface MonadClientOptions {
  /** Daemon base URL, e.g. "http://127.0.0.1:52749". */
  baseUrl: string;
  /** Bearer token for the control API (header only — never in the URL). */
  token?: string;
  /**
   * Absolute path to the daemon's Unix-domain HTTP socket. When set, REST/SSE go over
   * it instead of TCP loopback; the live-event WebSocket still uses `baseUrl` (TCP).
   * Local connections only — leave unset for remote daemons.
   */
  unixSocket?: string;
  /**
   * Override base URL for the live-event WebSocket. Use when `baseUrl` is a proxied
   * path (e.g. a Next.js `/api` rewrite) that cannot proxy WebSocket upgrade requests.
   * When set, the EventSocket connects to `<wsBaseUrl>/v1/stream` directly.
   */
  wsBaseUrl?: string;
  /** Optional Eden Treaty config passthrough for advanced customization. */
  treatyConfig?: MonadTreatyConfig;
}

export type EventHandler = (event: Event) => void;
export type UiEventHandler = (event: SessionUiEvent) => void;
export type LogRecordHandler = (record: DeveloperLogRecord) => void;

interface SsePayloadSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * A failure observed while consuming a session's SSE generation stream. `fatal` means the stream
 * won't reconnect (auth failure / session gone); `transient` means a reconnect is scheduled after
 * backoff — surfaced so a UI can show a "reconnecting…" state instead of a silently frozen stream.
 */
export interface StreamError {
  kind: 'fatal' | 'transient';
  status?: number;
  cause?: unknown;
}

export class MonadClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly wsBase: string;
  readonly treaty: MonadTreaty;
  private socket?: EventSocket;

  constructor(opts: MonadClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl =
      makeUnixFetcher(opts.unixSocket) ?? makeLoopbackHttpsFetcher(opts.baseUrl) ?? globalThis.fetch.bind(globalThis);
    this.wsBase = (opts.wsBaseUrl ?? opts.baseUrl).replace(/\/$/, '');
    this.treaty = createMonadTreaty(opts, opts.treatyConfig);
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token && !headers.has('authorization')) headers.set('authorization', `Bearer ${this.token}`);
    const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${this.baseUrl}${path}`;
    return this.fetchImpl(url, { ...init, headers });
  }

  private eventSocket(): EventSocket {
    if (!this.socket) {
      const wsUrl = `${this.wsBase.replace(/^http/, 'ws')}/${CONTROL_API_VERSION}/stream`;
      this.socket = new EventSocket(wsUrl);
    }
    return this.socket;
  }

  private parseSseFrame<T>(frame: string, onEvent: (event: T) => void, schema: SsePayloadSchema<T>): string | null {
    const dataParts: string[] = [];
    let eventId: string | null = null;
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // SSE comment/heartbeat
      if (line.startsWith('id:')) {
        const raw = line.slice(3);
        eventId = raw.startsWith(' ') ? raw.slice(1) : raw;
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5);
      dataParts.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    if (dataParts.length === 0) return eventId;
    const data = dataParts.join('\n');
    if (!data || data === '[DONE]') return eventId;
    onEvent(schema.parse(JSON.parse(data)));
    return eventId;
  }

  private async readSseEvents<T>(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onEvent: (event: T) => void,
    schema: SsePayloadSchema<T>,
    signal?: AbortSignal
  ): Promise<string | null> {
    const decoder = new TextDecoder();
    let buf = '';
    let lastEventId: string | null = null;
    for (;;) {
      if (signal?.aborted) return lastEventId;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n'); // normalize to \n\n frame delimiter
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const id = this.parseSseFrame(frame, onEvent, schema);
        if (id !== null) lastEventId = id;
        sep = buf.indexOf('\n\n');
      }
    }
    return lastEventId;
  }

  /**
   * Consume an SSE response from Eden Treaty. Eden v1 parses an `text/event-stream` body into an
   * async-iterable of frames (`{ id, event, data }`, where `data` is our serialized Event) rather
   * than handing back a raw `Response` — so iterate that and unwrap `.data`. A real `Response`
   * (older Eden, or a non-treaty fetch) is still handled via the byte reader. Anything else means
   * the body was buffered/parsed unexpectedly, so there is nothing to stream.
   *
   * Returns the last SSE event id seen (for reconnect with `last-event-id`), or null if none.
   */
  private async consumeSseStream<T>(
    data: unknown,
    onEvent: (event: T) => void,
    schema: SsePayloadSchema<T>,
    signal?: AbortSignal
  ): Promise<string | null> {
    if (data == null) return null;
    if (data instanceof Response) {
      const reader = data.body?.getReader();
      if (reader) return this.readSseEvents(reader, onEvent, schema);
      return null;
    }
    const iterable = data as AsyncIterable<unknown>;
    if (typeof iterable[Symbol.asyncIterator] !== 'function') return null;
    let lastId: string | null = null;
    for await (const frame of iterable) {
      if (signal?.aborted) return lastId; // Ctrl-C: stop rendering this turn (it continues server-side)
      // Eden wraps each frame as `{ id, event, data }`. Eden's reviver auto-converts ISO date
      // strings to Date objects, but our schemas expect strings — round-trip through JSON to
      // normalise Dates back to ISO strings before validation.
      const f = frame as { id?: string; data?: unknown };
      if (f.id) lastId = f.id;
      let payload: unknown = f.data ?? frame;
      if (typeof payload === 'string') {
        if (!payload || payload === '[DONE]') continue;
        try {
          payload = JSON.parse(payload);
        } catch {
          continue;
        }
      }
      if (payload == null) continue;
      const normalized = JSON.parse(JSON.stringify(payload));
      const parsed = schema.safeParse(normalized);
      if (parsed.success) onEvent(parsed.data);
    }
    return lastId;
  }

  subscribeControl(onEvent: EventHandler): () => void {
    return this.eventSocket().subscribeControl(onEvent);
  }

  /**
   * Watch a session for its whole life, honoring the control/SSE split. The session outlives any
   * single turn, so this holds the WS **control** stream to learn *when* the session is generating
   * (`session.stream_started` / `session.stream_ended`) and opens a per-session **SSE** generation
   * subscription only while a turn is in flight, closing it between turns. Generation tokens never
   * travel the control plane — only SSE carries them. Events from both planes are merged and
   * de-duplicated by id, so `onEvent` sees each event exactly once.
   *
   * Returns a disposer that tears down both subscriptions. Use this instead of `subscribe` (the
   * deprecated per-session WS path) for "observe a session" UIs and the CLI `session watch`.
   */
  watchSession(
    sessionId: SessionId,
    onEvent: EventHandler,
    opts?: { afterEventId?: EventId; onError?: (err: StreamError) => void }
  ): () => void {
    let closed = false;
    let sseDispose: (() => void) | undefined;
    let lastEventId = opts?.afterEventId;

    // Bounded de-dup: the control (lifecycle) and SSE (session) topics overlap on a few
    // session-scoped events (`session.updated`, the stream markers), which would otherwise
    // reach onEvent twice. Idempotent by id — drop anything already forwarded.
    const seen = new Set<EventId>();
    const order: EventId[] = [];
    const forward = (event: Event): void => {
      const id = event.id;
      if (seen.has(id)) return;
      seen.add(id);
      order.push(id);
      if (order.length > 2048) {
        const evicted = order.shift();
        if (evicted) seen.delete(evicted);
      }
      onEvent(event);
    };

    const openSse = (): void => {
      if (closed || sseDispose) return;
      sseDispose = this.streamEvents(
        sessionId,
        (event) => {
          lastEventId = event.id;
          forward(event);
        },
        { afterEventId: lastEventId, onError: opts?.onError }
      );
    };
    const closeSse = (): void => {
      sseDispose?.();
      sseDispose = undefined;
    };

    const unsubControl = this.subscribeControl((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.type === 'session.stream_started') {
        openSse();
        return;
      }
      if (event.type === 'session.stream_ended') {
        forward(event);
        closeSse();
        return;
      }
      forward(event);
    });

    // A turn may already be in flight when watching begins (the start marker has already fired and
    // won't replay), so open the SSE once up front to catch it. The next `stream_ended` closes it,
    // and `stream_started` reopens it for subsequent turns.
    openSse();

    return () => {
      closed = true;
      unsubControl();
      closeSse();
    };
  }

  dispose(): void {
    this.socket?.dispose();
    this.socket = undefined;
  }

  /** POST a turn and consume this round's events inline from the SSE response. Pass `signal` to
   *  stop consuming early (e.g. Ctrl-C in the CLI); the aborted read is swallowed, not thrown. */
  async sendStreamable(sessionId: SessionId, text: string, onEvent: EventHandler, signal?: AbortSignal): Promise<void> {
    const result = await this.treaty.v1
      .sessions({ id: sessionId })
      .messages.post({ text }, { headers: { accept: 'text/event-stream' }, fetch: signal ? { signal } : undefined });

    // A 404 or similar error would otherwise read as a successful empty turn.
    if (result.error) throw new Error(`sendStreamable failed: ${result.status}`);

    try {
      await this.consumeSseStream(result.data, onEvent, eventSchema, signal);
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
  }

  streamEvents(
    sessionId: SessionId,
    onEvent: EventHandler,
    opts?: { afterEventId?: EventId; onError?: (err: StreamError) => void }
  ): () => void {
    const controller = new AbortController();

    void (async () => {
      let afterEventId: EventId | undefined = opts?.afterEventId;
      let delay = 1_000;
      while (!controller.signal.aborted) {
        try {
          const result = await this.treaty.v1.sessions({ id: sessionId }).events.get({
            headers: afterEventId ? { 'last-event-id': afterEventId } : undefined,
            fetch: { signal: controller.signal }
          });

          // Non-retriable errors (session gone, auth failure) — stop reconnecting.
          if (result.error) {
            const status = (result.error as { status?: number }).status;
            if (status === 401 || status === 403 || status === 404) {
              opts?.onError?.({ kind: 'fatal', status });
              return;
            }
            // Other errors fall through to the backoff-and-retry path below.
            opts?.onError?.({ kind: 'transient', status });
          } else {
            const lastId = await this.consumeSseStream(result.data, onEvent, eventSchema, controller.signal);
            if (lastId) afterEventId = lastId as EventId;
            delay = 1_000; // reset backoff after a successful connection
          }
        } catch (err) {
          // AbortError from the disposer — exit immediately.
          if (controller.signal.aborted) return;
          // A genuine network/read failure: surface it, then fall through to backoff-and-retry.
          opts?.onError?.({ kind: 'transient', cause: err });
        }
        // Wait before reconnecting; cap at 30s.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        delay = Math.min(delay * 2, 30_000);
      }
    })();

    return () => controller.abort();
  }

  streamSessionLogs(
    sessionId: SessionId,
    onRecord: LogRecordHandler,
    opts?: { onError?: (err: StreamError) => void }
  ): () => void {
    const controller = new AbortController();

    void (async () => {
      let delay = 1_000;
      while (!controller.signal.aborted) {
        try {
          const response = await this.fetch(`/${CONTROL_API_VERSION}/sessions/${sessionId}/logs`, {
            headers: { accept: 'text/event-stream' },
            signal: controller.signal
          });
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            opts?.onError?.({ kind: 'fatal', status: response.status });
            return;
          }
          if (!response.ok) {
            opts?.onError?.({ kind: 'transient', status: response.status });
          } else {
            const reader = response.body?.getReader();
            if (reader) await this.readSseEvents(reader, onRecord, developerLogRecordSchema, controller.signal);
            delay = 1_000;
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          opts?.onError?.({ kind: 'transient', cause: err });
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        delay = Math.min(delay * 2, 30_000);
      }
    })();

    return () => controller.abort();
  }

  streamUiEvents(
    sessionId: SessionId,
    onEvent: UiEventHandler,
    opts?: { afterEventId?: EventId; onError?: (err: StreamError) => void }
  ): () => void {
    const controller = new AbortController();

    void (async () => {
      let afterEventId: EventId | undefined = opts?.afterEventId;
      let delay = 1_000;
      while (!controller.signal.aborted) {
        try {
          const result = await this.treaty.v1.sessions({ id: sessionId })['ui-stream'].get({
            headers: afterEventId ? { 'last-event-id': afterEventId } : undefined,
            fetch: { signal: controller.signal }
          });

          if (result.error) {
            const status = (result.error as { status?: number }).status;
            if (status === 401 || status === 403 || status === 404) {
              opts?.onError?.({ kind: 'fatal', status });
              return;
            }
            opts?.onError?.({ kind: 'transient', status });
          } else {
            const lastId = await this.consumeSseStream(result.data, onEvent, sessionUiEventSchema, controller.signal);
            if (lastId) afterEventId = lastId as EventId;
            delay = 1_000;
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          opts?.onError?.({ kind: 'transient', cause: err });
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        delay = Math.min(delay * 2, 30_000);
      }
    })();

    return () => controller.abort();
  }
}

export type { MonadTreaty, MonadTreatyConfig, MonadTreatyOptions } from './treaty.ts';
export type { VersionCheckResult } from './version.ts';
export type { SendMessageResponse };

export { createMonadTreaty } from './treaty.ts';
export { CLIENT_VERSION, checkDaemonVersion, isVersionCompatible } from './version.ts';
