// SSE wire decoder — the read counterpart of the daemon's event-stream encoder. The daemon emits
// session events as `text/event-stream` frames; every consumer (the DOM web client over a raw
// Response, and the Bun-side ACP bridge over its socket) needs the same byte-stream → validated
// `Event` decode. That logic lived in two near-identical copies; this is the single source.
//
// Framework-free on purpose: only web-standard `ReadableStreamDefaultReader`/`TextDecoder` (present
// in both Bun and the DOM) plus `eventSchema`. It does NOT cover Eden Treaty's pre-parsed
// async-iterable frames — that decode stays in @monad/client where Eden lives.

import { type Event, eventSchema } from './domain.ts';

export type SseFrameResult =
  | { kind: 'event'; eventId: string | null; event: Event }
  | { kind: 'empty'; eventId: string | null } // heartbeat/comment, no data, or the [DONE] sentinel
  | { kind: 'invalid'; eventId: string | null; error: string };

/** Parse one complete SSE frame (the text between blank-line delimiters). */
export function parseSseFrame(frame: string): SseFrameResult {
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
  const parsed = eventSchema.safeParse(json);
  return parsed.success
    ? { kind: 'event', eventId, event: parsed.data }
    : { kind: 'invalid', eventId, error: parsed.error.message };
}

/** Minimal byte-reader surface — the common subset of Bun's and the DOM's stream readers (which
 *  differ on extras like `readMany`), so this stays portable across both runtimes. */
export interface SseByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/**
 * Drive a byte reader to completion, decoding `\n\n`-delimited SSE frames and invoking `onEvent`
 * for each valid one. Invalid frames are dropped (with an optional `onInvalid` for observability),
 * matching the resilient behaviour clients already rely on. Returns the last seen event id, for
 * reconnect with `last-event-id`.
 */
export async function readSseStream(
  reader: SseByteReader,
  onEvent: (event: Event) => void,
  opts: { onInvalid?: (error: string) => void; signal?: AbortSignal } = {}
): Promise<string | null> {
  const decoder = new TextDecoder();
  let buf = '';
  let lastEventId: string | null = null;

  const handle = (frame: string): void => {
    const result = parseSseFrame(frame);
    if (result.eventId !== null) lastEventId = result.eventId;
    if (result.kind === 'event') onEvent(result.event);
    else if (result.kind === 'invalid') opts.onInvalid?.(result.error);
  };

  for (;;) {
    if (opts.signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
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
