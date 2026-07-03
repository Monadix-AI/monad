import type { Event, SessionId, SessionUiEvent } from '@monad/protocol';

import { afterEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MonadClient, type StreamError } from '../../src/index.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('client.treaty posts to the control API and returns the id', async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ sessionId: 'ses_TEST' }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749', token: 'secret' });
  const result = await client.treaty.v1.sessions.post({ title: 'hi' });
  const id = result.data?.sessionId;

  expect(id).toBe('ses_TEST');
  // cast resets tsgo's closure-narrowing (the assignment happens inside an async mock)
  const cap = captured as { url: string; init?: RequestInit } | null;
  if (!cap) throw new Error('fetch was not called');
  expect(cap.url).toBe('http://127.0.0.1:52749/v1/sessions');
  // token goes in the header, never the URL
  expect((cap.init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
});

test('client.fetch sends raw requests with bearer auth in the header', async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured = { url: String(url), init };
    return Response.json({ ok: true });
  }) as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749', token: 'secret' });
  const res = await client.fetch('/v1/atoms/skills/upload?filename=SKILL.md', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: 'body'
  });

  expect(res.ok).toBe(true);
  const cap = captured as { url: string; init?: RequestInit } | null;
  if (!cap) throw new Error('fetch was not called');
  expect(cap.url).toBe('http://127.0.0.1:52749/v1/atoms/skills/upload?filename=SKILL.md');
  expect(new Headers(cap.init?.headers).get('authorization')).toBe('Bearer secret');
  expect(cap.url).not.toContain('secret');
});

test('unixSocket: requests are dialed over the unix socket', async () => {
  const attempts: Array<string | undefined> = [];
  globalThis.fetch = (async (_url: string, init?: { unix?: string }) => {
    attempts.push(init?.unix);
    return new Response(JSON.stringify({ sessionId: 'ses_U' }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const sock = join(tmpdir(), 'monad-x.sock');
  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749', unixSocket: sock });
  const res = await client.treaty.v1.sessions.post({ title: 'hi' });

  expect(res.data?.sessionId).toBe('ses_U');
  expect(attempts.at(-1)).toBe(sock); // carried the unix option
});

test('unixSocket: a dead socket falls back to TCP and sticks for later requests', async () => {
  const attempts: Array<string | undefined> = [];
  globalThis.fetch = (async (_url: string, init?: { unix?: string }) => {
    attempts.push(init?.unix);
    if (init?.unix) throw new Error('connect ENOENT (no such socket)'); // simulate dead UDS
    return new Response(JSON.stringify({ sessionId: 'ses_T' }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749', unixSocket: join(tmpdir(), 'monad-dead.sock') });

  // 1st request: UDS connect throws → retried over TCP → still succeeds.
  const r1 = await client.treaty.v1.sessions.post({ title: 'a' });
  expect(r1.data?.sessionId).toBe('ses_T');

  // 2nd request: should skip UDS entirely (sticky) and go straight to TCP.
  const r2 = await client.treaty.v1.sessions.post({ title: 'b' });
  expect(r2.data?.sessionId).toBe('ses_T');

  expect(attempts.filter((u) => u).length).toBe(1); // UDS probed only once
  expect(attempts.filter((u) => !u).length).toBe(2); // both requests ultimately over TCP
});

test('streamEvents delivers live SSE events (Eden parses the body into an async-iterable, not a Response)', async () => {
  // Regression: Eden Treaty v1 hands an `text/event-stream` body back as an async-iterable of
  // parsed frames, NOT a `Response`. The old `instanceof Response` guard bailed instantly, so the
  // web/CLI received zero live tokens and streaming silently degraded to block-style.
  const sessionId = 'ses_STREAMTEST' as const;
  const mkEvent = (i: number, delta: string) => ({
    id: `evt_TOK${i}`,
    transcriptTargetId: sessionId,
    type: 'agent.token',
    actorAgentId: null,
    payload: { messageId: 'msg_STREAMTEST', delta, index: i },
    at: '2026-01-01T00:00:00.000Z'
  });
  const frame = (e: ReturnType<typeof mkEvent>) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          const enc = new TextEncoder();
          ctrl.enqueue(enc.encode(frame(mkEvent(0, 'he'))));
          ctrl.enqueue(enc.encode(frame(mkEvent(1, 'llo'))));
          ctrl.close();
        }
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )) as unknown as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const received: string[] = [];
  await new Promise<void>((resolve) => {
    client.streamEvents(sessionId, (e) => {
      received.push((e.payload as { delta: string }).delta);
      if (received.length === 2) resolve();
    });
    setTimeout(resolve, 2000); // safety net so a regression fails fast instead of hanging
  });

  expect(received).toEqual(['he', 'llo']);
});

test('streamEvents surfaces a fatal error (and stops) instead of swallowing it', async () => {
  // Regression for B2: a 404/auth failure used to be swallowed by a bare catch, freezing the
  // stream with no signal to the UI. It must now reach onError as `fatal`.
  globalThis.fetch = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const errors: StreamError[] = [];
  await new Promise<void>((resolve) => {
    client.streamEvents('ses_GONE' as SessionId, () => {}, {
      onError: (e) => {
        errors.push(e);
        resolve();
      }
    });
    setTimeout(resolve, 2000); // safety net
  });

  expect(errors[0]?.kind).toBe('fatal');
  expect(errors[0]?.status).toBe(404);
});

test('streamUiEvents delivers projected UI SSE events', async () => {
  const sessionId = 'ses_UISTREAM' as const;
  const mkEvent = (i: number): SessionUiEvent => {
    if (i === 0) return { kind: 'snapshot', cursor: 'evt_UI0', items: [] };
    return {
      kind: 'upsert',
      cursor: 'evt_UI1',
      item: {
        kind: 'message',
        id: 'msg_UI',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hello' }],
        status: 'streaming',
        seq: 'evt_UI1'
      }
    };
  };
  const frame = (e: SessionUiEvent) => `id: ${e.cursor}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;

  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          const enc = new TextEncoder();
          ctrl.enqueue(enc.encode(frame(mkEvent(0))));
          ctrl.enqueue(enc.encode(frame(mkEvent(1))));
          ctrl.close();
        }
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )) as unknown as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const received: SessionUiEvent['kind'][] = [];
  await new Promise<void>((resolve) => {
    client.streamUiEvents(sessionId, (e) => {
      received.push(e.kind);
      if (received.length === 2) resolve();
    });
    setTimeout(resolve, 2000);
  });

  expect(received).toEqual(['snapshot', 'upsert']);
});

test('streamUiEvents dispose stops consuming without surfacing a transient error', async () => {
  const sessionId = 'ses_UIABORT' as const;
  const event: SessionUiEvent = { kind: 'snapshot', cursor: 'evt_UIABORT0', items: [] };
  const frame = `id: ${event.cursor}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
  let capturedSignal: AbortSignal | undefined;

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedSignal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(frame));
        }
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    );
  }) as unknown as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const errors: StreamError[] = [];
  let dispose: (() => void) | undefined;

  await new Promise<void>((resolve) => {
    dispose = client.streamUiEvents(
      sessionId,
      () => {
        dispose?.();
        setTimeout(resolve, 0);
      },
      { onError: (err) => errors.push(err) }
    );
    setTimeout(resolve, 2000);
  });

  expect(capturedSignal?.aborted).toBe(true);
  expect(errors).toEqual([]);
});

test('watchSession: opens SSE on stream_started, closes on stream_ended, de-dupes both planes', () => {
  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });

  let controlHandler: EventHandlerFn | undefined;
  let sseHandler: EventHandlerFn | undefined;
  let sseOpens = 0;
  let sseDisposed = 0;

  // Drive the state machine through controllable fakes for the two transport primitives it
  // composes (both are covered by their own tests above).
  type EventHandlerFn = (e: Event) => void;
  const c = client as unknown as {
    subscribeControl: (fn: EventHandlerFn) => () => void;
    streamEvents: (sid: SessionId, fn: EventHandlerFn) => () => void;
  };
  c.subscribeControl = (fn) => {
    controlHandler = fn;
    return () => {
      controlHandler = undefined;
    };
  };
  c.streamEvents = (_sid, fn) => {
    sseOpens += 1;
    sseHandler = fn;
    return () => {
      sseDisposed += 1;
      sseHandler = undefined;
    };
  };

  const ev = (id: string, type: string, sessionId = 'ses_W'): Event =>
    ({ id, transcriptTargetId: sessionId, type, actorAgentId: null, payload: {}, at: '' }) as unknown as Event;

  const seen: string[] = [];
  const dispose = client.watchSession('ses_W' as SessionId, (e) => seen.push(e.id));

  expect(sseOpens).toBe(1); // opened up-front to catch an in-flight turn

  controlHandler?.(ev('e1', 'session.stream_ended'));
  expect(sseDisposed).toBe(1); // turn settled → SSE closed
  controlHandler?.(ev('e2', 'session.stream_started'));
  expect(sseOpens).toBe(2); // next turn → SSE reopened

  sseHandler?.(ev('tok1', 'agent.token')); // generation over SSE
  controlHandler?.(ev('tok1', 'agent.token')); // overlap on the other plane → de-duped
  controlHandler?.(ev('upd', 'session.updated')); // lifecycle forwarded
  controlHandler?.(ev('x', 'agent.token', 'ses_OTHER')); // other session → ignored

  // stream_ended is forwarded; stream_started is consumed internally (drives open, not surfaced).
  expect(seen).toEqual(['e1', 'tok1', 'upd']);

  dispose();
  expect(sseDisposed).toBe(2); // disposer tears down the open SSE
});
