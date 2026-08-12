import type { Event } from '@monad/protocol';

import { createParser, type EventSourceParser } from 'eventsource-parser';

const MAX_SSE_BUFFER_CHARS = 1024 * 1024;
const SSE_CONDITION_MATCHED = Symbol('sse-condition-matched');

/** Parse protocol-compliant SSE framing while keeping Monad's JSON event validation seam explicit. */
export function createJsonSseParser(onEvent: (event: Event) => void): EventSourceParser {
  return createParser({
    maxBufferSize: MAX_SSE_BUFFER_CHARS,
    onError: (error) => {
      throw error;
    },
    onEvent: ({ data }) => onEvent(JSON.parse(data) as Event)
  });
}

/**
 * Read an SSE event stream until `until(event)` returns true or `timeoutMs` elapses.
 * Fetch remains here because Bun's Unix-socket option is transport-specific; standards-compliant
 * framing, CRLF handling, chunk boundaries, comments, and multi-line data are delegated to the parser.
 */
export async function readSSE(
  url: string,
  opts: {
    headers?: Record<string, string>;
    until: (event: Event) => boolean;
    timeoutMs?: number;
    unix?: string;
    onConnected?: () => void;
  }
): Promise<Event[]> {
  const controller = new AbortController();
  const seen: Event[] = [];
  const timeoutMs = opts.timeoutMs ?? 2_000;
  let matched = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const parser = createJsonSseParser((event) => {
    seen.push(event);
    if (opts.until(event)) {
      matched = true;
      controller.abort();
      // eventsource-parser dispatches every complete frame already present in one feed call. Throwing a
      // private sentinel preserves readSSE's established contract that the matching event is the final
      // returned frame, even when the network chunk also contains later frames.
      throw SSE_CONDITION_MATCHED;
    }
  });

  try {
    const response = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal,
      unix: opts.unix
    });
    if (!response.ok) throw new Error(`SSE request failed with status ${response.status}`);
    opts.onConnected?.();
    const reader = response.body?.getReader();
    if (!reader) return seen;
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      if (controller.signal.aborted) return seen;
    }
    const remainder = decoder.decode();
    if (remainder) parser.feed(remainder);
    parser.reset({ consume: true });
  } catch (error) {
    if (error !== SSE_CONDITION_MATCHED && !controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!matched) {
    const reason = timedOut ? `timed out after ${timeoutMs}ms` : 'ended before the condition matched';
    const observed = seen.map((event) => event.type).join(', ') || 'none';
    throw new Error(`SSE condition ${reason}; observed event types: ${observed}`);
  }
  return seen;
}
