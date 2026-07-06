import type { EventId } from '@monad/protocol';

import { afterEach, expect, test } from 'bun:test';

import { MonadClient, type StreamError } from '../../src/index.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Minimal SsePayloadSchema<{ n: number }>: accepts an object with a numeric `n`, rejects anything else.
const numSchema = {
  parse: (v: unknown) => v as { n: number },
  safeParse: (v: unknown) =>
    v !== null && typeof v === 'object' && typeof (v as { n?: unknown }).n === 'number'
      ? { success: true as const, data: v as { n: number } }
      : { success: false as const }
};

const frame = (id: string, data: unknown): string => `id: ${id}\nevent: t\ndata: ${JSON.stringify(data)}\n\n`;
const sseBody = (frames: string[]): Response =>
  new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** fetchImpl is bound at construction, so the stub must be installed BEFORE `new MonadClient`. */
function clientWith(fetchStub: (url: string, init?: RequestInit) => Promise<Response>): MonadClient {
  globalThis.fetch = fetchStub as unknown as typeof fetch;
  return new MonadClient({ baseUrl: 'http://127.0.0.1:1' });
}

test('stream threads last-event-id header and ?after= query when resuming', async () => {
  let captured: { url: string; headers: Headers } | undefined;
  const c = clientWith(async (url, init) => {
    captured = { url: String(url), headers: new Headers(init?.headers) };
    return sseBody([frame('evt_2', { n: -1 })]); // terminal so the loop stops after one connection
  });

  await new Promise<void>((resolve) => {
    c.stream('/v1/things', numSchema, (v: { n: number }) => v.n < 0 && resolve(), {
      resume: true,
      afterEventId: 'evt_1' as EventId,
      isTerminal: (v) => v.n < 0
    });
  });

  expect(captured?.headers.get('last-event-id')).toBe('evt_1');
  expect(captured?.url).toContain('after=evt_1');
});

test('resume advances the cursor across a reconnect (backfill from the last delivered id)', async () => {
  const sentCursors: (string | null)[] = [];
  let calls = 0;
  const c = clientWith(async (_url, init) => {
    calls++;
    sentCursors.push(new Headers(init?.headers).get('last-event-id'));
    // Connection 1 delivers evt_5 then closes (not terminal → reconnect); connection 2 is terminal.
    return calls === 1 ? sseBody([frame('evt_5', { n: 1 })]) : sseBody([frame('evt_9', { n: -1 })]);
  });

  await new Promise<void>((resolve) => {
    c.stream('/x', numSchema, (v: { n: number }) => v.n < 0 && resolve(), {
      resume: true,
      isTerminal: (v) => v.n < 0
    });
  });

  expect(sentCursors[1]).toBe('evt_5'); // reconnect resumes from the last id the first connect delivered
  expect(calls).toBe(2);
});

test('stream isolates a throwing consumer callback instead of reconnecting forever', async () => {
  let calls = 0;
  const seen: number[] = [];
  const c = clientWith(async () => {
    calls++;
    return sseBody([frame('e1', { n: 1 }), frame('e2', { n: 2 }), frame('e3', { n: -1 })]);
  });

  await new Promise<void>((resolve) => {
    c.stream(
      '/x',
      numSchema,
      (v: { n: number }) => {
        seen.push(v.n);
        if (v.n === 1) throw new Error('consumer bug'); // must not tear down / reconnect the stream
        if (v.n < 0) setTimeout(resolve, 20);
      },
      { isTerminal: (v) => v.n < 0 }
    );
  });

  expect(seen).toEqual([1, 2, -1]); // kept delivering after the throw
  expect(calls).toBe(1); // single connection — the throw did not trigger a reconnect
});

test('stream stops on a terminal frame and does not reconnect', async () => {
  let calls = 0;
  const c = clientWith(async () => {
    calls++;
    return sseBody([frame('e1', { n: 1 }), frame('e2', { n: -1 })]);
  });

  const got: number[] = [];
  await new Promise<void>((resolve) => {
    c.stream(
      '/x',
      numSchema,
      (v: { n: number }) => {
        got.push(v.n);
        if (v.n < 0) setTimeout(resolve, 20); // beat to prove no reconnect follows
      },
      { isTerminal: (v) => v.n < 0 }
    );
  });

  expect(got).toEqual([1, -1]);
  expect(calls).toBe(1);
});

test('stream skips an unparseable frame instead of tearing down the connection', async () => {
  let calls = 0;
  const c = clientWith(async () => {
    calls++;
    return sseBody([
      frame('e1', { n: 1 }),
      frame('e2', { bogus: true }), // fails schema.safeParse → skipped
      'id: e3\nevent: t\ndata: {not json\n\n', // bad JSON → skipped
      frame('e4', { n: -1 }) // terminal
    ]);
  });

  const got: number[] = [];
  await new Promise<void>((resolve) => {
    c.stream(
      '/x',
      numSchema,
      (v: { n: number }) => {
        got.push(v.n);
        if (v.n < 0) setTimeout(resolve, 20);
      },
      { isTerminal: (v) => v.n < 0 }
    );
  });

  expect(got).toEqual([1, -1]); // bad frames dropped, stream neither threw nor reconnected
  expect(calls).toBe(1);
});

test('stream calls onOpen once the connection is established', async () => {
  let opened = 0;
  const c = clientWith(async () => sseBody([frame('e1', { n: -1 })]));

  await new Promise<void>((resolve) => {
    c.stream('/x', numSchema, (v: { n: number }) => v.n < 0 && resolve(), {
      onOpen: () => {
        opened++;
      },
      isTerminal: (v) => v.n < 0
    });
  });

  expect(opened).toBe(1);
});

/** A `text/event-stream` Response that stays open, optionally emitting `:` heartbeats, and errors
 *  its body when the fetch signal aborts (so the client's idle watchdog can interrupt the read). */
function openStream(init: RequestInit | undefined, heartbeatMs?: number): Response {
  const signal = init?.signal;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const enc = new TextEncoder();
      const iv = heartbeatMs
        ? setInterval(() => {
            try {
              ctrl.enqueue(enc.encode(': keepalive\n\n'));
            } catch {
              clearInterval(iv);
            }
          }, heartbeatMs)
        : undefined;
      signal?.addEventListener('abort', () => {
        if (iv) clearInterval(iv);
        try {
          ctrl.error(new DOMException('aborted', 'AbortError'));
        } catch {}
      });
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('stream reconnects (silently) when a connected stream goes idle past idleTimeoutMs', async () => {
  let calls = 0;
  let errors = 0;
  const c = clientWith(async (_url, init) => {
    calls++;
    return openStream(init); // stays open, sends nothing → idle watchdog must fire
  });

  await new Promise<void>((resolve) => {
    const dispose = c.stream('/x', numSchema, () => {}, {
      idleTimeoutMs: 25,
      onError: () => {
        errors++;
      },
      onOpen: () => {
        if (calls >= 2) {
          dispose();
          resolve();
        }
      }
    });
  });

  expect(calls).toBeGreaterThanOrEqual(2); // idle → reconnect
  expect(errors).toBe(0); // a proactive idle reconnect is not surfaced as an error
});

test('heartbeat comments re-arm the idle watchdog so a busy stream never reconnects', async () => {
  let calls = 0;
  const c = clientWith(async (_url, init) => {
    calls++;
    return openStream(init, 10); // `:` heartbeat every 10ms, well under the 40ms idle window
  });

  const dispose = c.stream('/x', numSchema, () => {}, { idleTimeoutMs: 40 });
  await new Promise((r) => setTimeout(r, 120)); // 3× the idle window
  dispose();
  expect(calls).toBe(1); // never tripped the watchdog
});

test('stream surfaces a fatal status and stops without retrying', async () => {
  let calls = 0;
  const c = clientWith(async () => {
    calls++;
    return new Response(null, { status: 404 });
  });

  const err = await new Promise<StreamError>((resolve) => {
    c.stream('/x', numSchema, () => {}, { onError: (e) => resolve(e) });
  });

  expect(err.kind).toBe('fatal');
  expect(err.status).toBe(404);
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toBe(1); // fatal must not reconnect
});
