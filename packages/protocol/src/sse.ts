// SSE wire decoder — the read counterpart of the daemon's event-stream encoder. The daemon emits
// `text/event-stream` frames; every consumer (the DOM web client over a raw Response, the Bun-side
// ACP bridge over its socket) needs the same byte-stream → validated-value decode. This is the
// single source: callers pass the schema for whatever payload their stream carries (session events,
// UI events, log records, …), so there is one decoder, not one per payload type.
//
// Framework-free on purpose: only web-standard `ReadableStreamDefaultReader`/`TextDecoder` (present
// in both Bun and the DOM). It does NOT cover Eden Treaty's pre-parsed async-iterable frames — that
// decode stays in @monad/client where Eden lives.

/**
 * SSE keepalive/idle timing — a cross-tier contract between the daemon and its clients. The daemon
 * writes a `:` heartbeat comment every `SSE_HEARTBEAT_MS`; a client force-reconnects if a *connected*
 * stream delivers no bytes (not even a heartbeat) for `SSE_IDLE_TIMEOUT_MS`, catching a silently
 * half-open socket. The idle timeout MUST stay well above the heartbeat interval (≥ 2×) or a
 * quiet-but-healthy stream is falsely reaped every cycle — the invariant is asserted in the tests.
 */
export const SSE_HEARTBEAT_MS = 20_000;
export const SSE_IDLE_TIMEOUT_MS = 50_000;

/** Minimal schema surface for decoding — `safeParse` only, so any zod schema (or a hand-rolled
 *  validator) works and a bad frame is a value, never a throw. */
export interface SseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error?: { message: string } };
}

export type TypedSseFrame<T> =
  | { kind: 'event'; eventId: string | null; event: T }
  | { kind: 'empty'; eventId: string | null } // heartbeat/comment, no data, or the [DONE] sentinel
  | { kind: 'invalid'; eventId: string | null; error: string };

/** Parse one complete SSE frame (the text between blank-line delimiters) against `schema`. Never
 *  throws — malformed JSON or a schema-invalid payload comes back as `kind: 'invalid'`, with the id
 *  preserved so a reconnecting caller can still advance its cursor past a poison frame. */
export function parseTypedSseFrame<T>(frame: string, schema: SseSchema<T>): TypedSseFrame<T> {
  const dataParts: string[] = [];
  let eventId: string | null = null;
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('id:')) {
      const raw = line.slice(3);
      eventId = raw.startsWith(' ') ? raw.slice(1) : raw;
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5);
    dataParts.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  if (dataParts.length === 0) return { kind: 'empty', eventId };
  const data = dataParts.join('\n');
  if (!data || data === '[DONE]') return { kind: 'empty', eventId };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch (err) {
    return { kind: 'invalid', eventId, error: err instanceof Error ? err.message : 'invalid JSON' };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { kind: 'event', eventId, event: parsed.data }
    : { kind: 'invalid', eventId, error: parsed.error?.message ?? 'schema validation failed' };
}

/** Minimal byte-reader surface — the common subset of Bun's and the DOM's stream readers (which
 *  differ on extras like `readMany`), so this stays portable across both runtimes. */
export interface SseByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/**
 * Drive a byte reader to completion, decoding `\n\n`-delimited SSE frames and invoking `onEvent` for
 * each valid one against `schema`. This is the single SSE decoder shared by every consumer (the DOM
 * web client, the Bun ACP bridge). Resilience guarantees:
 *  - Invalid frames are dropped (surfaced via `onInvalid`), never thrown.
 *  - A throw from `onEvent` is isolated: a buggy consumer callback must not abort the read — for a
 *    reconnecting caller that would otherwise re-fetch and re-throw the same frame forever.
 *  - `onActivity` fires on every read (including `:` heartbeat frames), so a caller can drive an
 *    idle watchdog off raw liveness, not just decoded events.
 * Returns the last seen event id, for reconnect with `last-event-id`.
 */
export async function readTypedSseStream<T>(
  reader: SseByteReader,
  schema: SseSchema<T>,
  onEvent: (value: T) => void,
  opts: { onInvalid?: (error: string) => void; onActivity?: () => void; signal?: AbortSignal } = {}
): Promise<string | null> {
  const decoder = new TextDecoder();
  let buf = '';
  let lastEventId: string | null = null;

  const handle = (frame: string): void => {
    const result = parseTypedSseFrame(frame, schema);
    if (result.eventId !== null) lastEventId = result.eventId;
    if (result.kind === 'event') {
      try {
        onEvent(result.event);
      } catch {
        // Swallow a consumer-callback exception: dropping this one delivery keeps the stream (and any
        // reconnect loop) alive, where re-throwing would tear it down and re-poison every retry.
      }
    } else if (result.kind === 'invalid') {
      opts.onInvalid?.(result.error);
    }
  };

  for (;;) {
    if (opts.signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    opts.onActivity?.();
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n'); // normalize to \n\n delimiter
    let sep = buf.indexOf('\n\n');
    while (sep !== -1) {
      handle(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
      sep = buf.indexOf('\n\n');
    }
  }
  return lastEventId;
}
