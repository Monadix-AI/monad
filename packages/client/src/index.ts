import type {
  DeveloperLogRecord,
  Event,
  EventId,
  ExternalAgentAuthSessionView,
  ExternalAgentUiObservationFrame,
  InteractionEvent,
  ProjectId,
  SendMessageResponse,
  SessionId,
  SessionUiEvent
} from '@monad/protocol';
import type { MonadTreaty, MonadTreatyConfig } from './treaty.ts';

import {
  CONTROL_API_VERSION,
  developerLogRecordSchema,
  eventSchema,
  externalAgentAuthSessionViewSchema,
  externalAgentUiObservationFrameSchema,
  interactionEventSchema,
  readTypedSseStream,
  SSE_IDLE_TIMEOUT_MS,
  sessionUiEventSchema
} from '@monad/protocol';

import { EventSocket } from './event-socket.ts';
import { createMonadTreaty, makeLoopbackHttpsFetcher, makeUnixFetcher } from './treaty.ts';

export interface MonadClientOptions {
  /** Daemon base URL, e.g. "https://127.0.0.1:52749". */
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
export type ExternalAgentAuthSessionHandler = (session: ExternalAgentAuthSessionView) => void;
export type ExternalAgentUiObservationHandler = (frame: ExternalAgentUiObservationFrame) => void;
export type InteractionEventHandler = (event: InteractionEvent) => void;

interface SsePayloadSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** HTTP statuses that mean "stop reconnecting" (session gone / auth failure), not "retry". */
const FATAL_SSE_STATUS: ReadonlySet<number> = new Set([401, 403, 404]);

/** Build the SSE path for a session's or Workplace Project's generation/UI stream. Sessions and
 *  projects share the same leaf routes under different scopes; the id prefix picks which. */
function transcriptStreamPath(id: SessionId | ProjectId, leaf: 'events' | 'ui-stream'): string {
  const scope = id.startsWith('prj_') ? 'projects' : 'sessions';
  return `/${CONTROL_API_VERSION}/${scope}/${encodeURIComponent(id)}/${leaf}`;
}

/** Append a query param, choosing `?` or `&` based on whether the path already has a query string. */
function appendQuery(path: string, key: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
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
      makeUnixFetcher(opts.unixSocket, opts.baseUrl) ??
      makeLoopbackHttpsFetcher(opts.baseUrl) ??
      globalThis.fetch.bind(globalThis);
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
      if (reader) return readTypedSseStream(reader, schema, onEvent, { signal });
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
    sessionId: SessionId | ProjectId,
    onEvent: EventHandler,
    opts?: { afterEventId?: EventId; onOpen?: () => void; onError?: (err: StreamError) => void }
  ): () => void {
    return this.stream(transcriptStreamPath(sessionId, 'events'), eventSchema, onEvent, { ...opts, resume: true });
  }

  streamUiEvents(
    sessionId: SessionId | ProjectId,
    onEvent: UiEventHandler,
    opts?: { afterEventId?: EventId; onOpen?: () => void; onError?: (err: StreamError) => void }
  ): () => void {
    return this.stream(transcriptStreamPath(sessionId, 'ui-stream'), sessionUiEventSchema, onEvent, {
      ...opts,
      resume: true
    });
  }

  streamInteractionEvents(
    onEvent: InteractionEventHandler,
    opts?: { onOpen?: () => void; onError?: (err: StreamError) => void }
  ): () => void {
    return this.stream(`/${CONTROL_API_VERSION}/interactions/events`, interactionEventSchema, onEvent, opts);
  }

  streamSessionLogs(
    sessionId: ProjectId | SessionId,
    onRecord: LogRecordHandler,
    opts?: { onError?: (err: StreamError) => void }
  ): () => void {
    return this.stream(`/${CONTROL_API_VERSION}/sessions/${sessionId}/logs`, developerLogRecordSchema, onRecord, opts);
  }

  streamExternalAgentAuth(
    id: string,
    controlToken: string,
    onSession: ExternalAgentAuthSessionHandler,
    opts?: { onError?: (err: StreamError) => void }
  ): () => void {
    return this.stream(
      `/${CONTROL_API_VERSION}/external-agent-auth-sessions/${id}/events?controlToken=${encodeURIComponent(controlToken)}`,
      externalAgentAuthSessionViewSchema,
      onSession,
      opts
    );
  }

  /** The neutral UI plane. Each frame already carries the full projected event list, so there is no
   *  delta to fold — the handler receives frames verbatim. A non-'live' frame is terminal (the session
   *  exited); any other close reconnects. */
  streamExternalAgentUiObservation(
    id: string,
    transcriptTargetId: SessionId | ProjectId,
    onFrame: ExternalAgentUiObservationHandler,
    opts?: { onError?: (err: StreamError) => void }
  ): () => void {
    return this.stream(
      `/${CONTROL_API_VERSION}/external-agent-sessions/${id}/ui-observation-stream?transcriptTargetId=${encodeURIComponent(transcriptTargetId)}`,
      externalAgentUiObservationFrameSchema,
      (frame) => onFrame(frame),
      { ...opts, resume: true, isTerminal: (frame) => frame.state !== 'live' }
    );
  }

  /**
   * The single, business-agnostic SSE consumer behind every `stream*` method. Everything
   * stream-specific arrives as arguments — the `path`, the frame `schema`, whether to `resume` via
   * `last-event-id`, and what counts as a terminal frame (`isTerminal`) — so this method encodes no
   * product concept and any new SSE endpoint can reuse it directly.
   *
   * It opens `path` as an event stream and drains it, reconnecting on a dropped connection with
   * equal-jitter exponential backoff (base 1s→30s, reset after a clean read) so many client instances
   * that dropped together don't stampede the daemon. A connected stream that goes silent for
   * `idleTimeoutMs` (no bytes, not even a `:` heartbeat) is treated as half-open and reconnected. With
   * `resume`, the last seen event id is threaded back (as both the `last-event-id` header and an
   * `?after=` query) so a mid-turn reconnect backfills instead of losing events — required for
   * generation streams (docs/internals/realtime-channels.md). A frame for which `isTerminal` returns true ends
   * the stream for good (no reconnect). Fatal statuses (401/403/404) stop; a genuine network/read
   * error is transient and retried. The returned disposer aborts the in-flight read and stops
   * reconnecting.
   */
  stream<T>(
    path: string,
    schema: SsePayloadSchema<T>,
    onEvent: (value: T) => void,
    opts?: {
      afterEventId?: EventId;
      resume?: boolean;
      isTerminal?: (value: T) => boolean;
      onOpen?: () => void;
      onError?: (err: StreamError) => void;
      /** Override the no-bytes idle timeout (default SSE_IDLE_TIMEOUT_MS); mainly a test seam. */
      idleTimeoutMs?: number;
    }
  ): () => void {
    const controller = new AbortController();
    const resume = opts?.resume ?? false;
    const idleMs = opts?.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;

    void (async () => {
      let afterEventId = opts?.afterEventId;
      let delay = 1_000;
      while (!controller.signal.aborted) {
        // Per-attempt controller so the idle watchdog can abort THIS connection (→ reconnect) without
        // tearing down the stream. A real dispose aborts the parent, which we forward to the attempt.
        const attempt = new AbortController();
        const onParentAbort = (): void => attempt.abort();
        controller.signal.addEventListener('abort', onParentAbort, { once: true });
        let idle: ReturnType<typeof setTimeout> | undefined;
        let idleAborted = false;
        const armIdle = (): void => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            idleAborted = true;
            attempt.abort();
          }, idleMs);
        };
        try {
          const headers: Record<string, string> = { accept: 'text/event-stream' };
          if (resume && afterEventId) headers['last-event-id'] = afterEventId;
          const url = resume && afterEventId ? appendQuery(path, 'after', afterEventId) : path;
          const response = await this.fetch(url, { headers, signal: attempt.signal });

          // Non-retriable (session gone / auth failure) — stop reconnecting.
          if (FATAL_SSE_STATUS.has(response.status)) {
            opts?.onError?.({ kind: 'fatal', status: response.status });
            return;
          }
          if (!response.ok) {
            opts?.onError?.({ kind: 'transient', status: response.status });
          } else {
            opts?.onOpen?.(); // connected — lets a UI clear a "reconnecting…" state deterministically
            const reader = response.body?.getReader();
            if (reader) {
              armIdle();
              let terminal = false;
              const lastId = await readTypedSseStream(
                reader,
                schema,
                (value: T) => {
                  onEvent(value);
                  if (opts?.isTerminal?.(value)) terminal = true;
                },
                { signal: attempt.signal, onActivity: armIdle } // any bytes (incl. `:` heartbeats) re-arm it
              );
              if (terminal) return; // the source signalled completion
              if (resume && lastId) afterEventId = lastId as EventId;
            }
            delay = 1_000; // reset backoff after a clean read
          }
        } catch (err) {
          // A real dispose exits the loop. An idle-driven abort is proactive maintenance, not a
          // failure, so it reconnects silently; only a genuine network/read error surfaces onError.
          if (controller.signal.aborted) return;
          if (!idleAborted) opts?.onError?.({ kind: 'transient', cause: err });
        } finally {
          if (idle) clearTimeout(idle);
          controller.signal.removeEventListener('abort', onParentAbort);
        }
        // Equal jitter: half fixed + half random, so instances that dropped at once desynchronize.
        await this.sleep(delay / 2 + Math.random() * (delay / 2), controller.signal);
        delay = Math.min(delay * 2, 30_000); // cap at 30s
      }
    })();

    return () => controller.abort();
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    // setTimeout (not Bun.sleep) — this client also runs in the browser via @monad/client-rtk.
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export type { MonadTreaty, MonadTreatyConfig, MonadTreatyOptions } from './treaty.ts';
export type { VersionCheckResult } from './version.ts';
export type { SendMessageResponse };

export { createMonadTreaty, makeLoopbackHttpsFetcher } from './treaty.ts';
export { CLIENT_VERSION, checkDaemonVersion, isVersionCompatible } from './version.ts';
