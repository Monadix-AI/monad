import type {
  ChatMessage,
  CreateSessionResponse,
  EventId,
  InteractionEvent,
  MessageGenerationEvent,
  MessageGenerationFrame,
  SessionId,
  SessionUiEvent
} from '@monad/protocol';

import { afterEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MonadClient, type StreamError } from '../../src/index.ts';

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
});

function createSessionResponse(data: CreateSessionResponse | Response | null | undefined): CreateSessionResponse {
  if (!data || data instanceof Response || !('sessionId' in data)) throw new Error('expected create session response');
  return data;
}

test('client.treaty posts to the control API and returns the id', async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ sessionId: 'ses_TEST00000000' }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749', token: 'secret' });
  const result = await client.treaty.v1.sessions.post({ title: 'hi' });
  const id = createSessionResponse(result.data).sessionId;

  expect(id).toBe('ses_TEST00000000');
  // cast resets tsc's closure-narrowing (the assignment happens inside an async mock)
  const cap = captured as { url: string; init?: RequestInit } | null;
  if (!cap) throw new Error('fetch was not called');
  expect(cap.url).toBe('http://127.0.0.1:52749/v1/sessions');
  // token goes in the header, never the URL
  expect((cap.init?.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer secret');
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
});

test('unixSocket: requests are dialed over the unix socket', async () => {
  const attempts: Array<string | undefined> = [];
  globalThis.fetch = (async (_url: string, init?: { unix?: string }) => {
    attempts.push(init?.unix);
    return new Response(JSON.stringify({ sessionId: 'ses_U00000000000' }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;

  const sock = join(tmpdir(), 'monad-x.sock');
  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749', unixSocket: sock });
  const res = await client.treaty.v1.sessions.post({ title: 'hi' });

  expect(createSessionResponse(res.data).sessionId).toBe('ses_U00000000000');
  expect(attempts.at(-1)).toBe(sock); // carried the unix option
});

test('unixSocket: HTTPS TCP base URL is rewritten to HTTP only for the plain Unix socket', async () => {
  const attempts: Array<{ unix?: string; url: string }> = [];
  globalThis.fetch = (async (url: string, init?: { unix?: string }) => {
    attempts.push({ unix: init?.unix, url: String(url) });
    return new Response(JSON.stringify({ sessionId: 'ses_U00000000000' }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;

  const sock = join(tmpdir(), 'monad-https-base.sock');
  const client = new MonadClient({ baseUrl: 'https://127.0.0.1:52749', unixSocket: sock });
  const res = await client.treaty.v1.sessions.post({ title: 'hi' });

  expect(createSessionResponse(res.data).sessionId).toBe('ses_U00000000000');
  expect(attempts).toEqual([{ unix: sock, url: 'http://127.0.0.1:52749/v1/sessions' }]);
});

test('unixSocket: IPv6 loopback HTTPS URL is rewritten over the unix socket', async () => {
  const attempts: Array<{ unix?: string; url: string }> = [];
  globalThis.fetch = (async (url: string, init?: { unix?: string }) => {
    attempts.push({ unix: init?.unix, url: String(url) });
    return new Response(JSON.stringify({ sessionId: 'ses_U60000000000' }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;

  const sock = join(tmpdir(), 'monad-https-ipv6-base.sock');
  const client = new MonadClient({ baseUrl: 'https://[::1]:52749', unixSocket: sock });
  const res = await client.treaty.v1.sessions.post({ title: 'hi' });

  expect(createSessionResponse(res.data).sessionId).toBe('ses_U60000000000');
  expect(attempts).toEqual([{ unix: sock, url: 'http://[::1]:52749/v1/sessions' }]);
});

test('unixSocket: a dead socket falls back to TCP and sticks for later requests', async () => {
  const attempts: Array<{ tls?: { rejectUnauthorized?: boolean }; unix?: string }> = [];
  globalThis.fetch = (async (_url: string, init?: { tls?: { rejectUnauthorized?: boolean }; unix?: string }) => {
    attempts.push({ tls: init?.tls, unix: init?.unix });
    if (init?.unix) throw new Error('connect ENOENT (no such socket)'); // simulate dead UDS
    return new Response(JSON.stringify({ sessionId: 'ses_T00000000000' }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;

  const client = new MonadClient({ baseUrl: 'https://127.0.0.1:52749', unixSocket: join(tmpdir(), 'monad-dead.sock') });

  // 1st request: UDS connect throws → retried over TCP → still succeeds.
  const r1 = await client.treaty.v1.sessions.post({ title: 'a' });
  expect(createSessionResponse(r1.data).sessionId).toBe('ses_T00000000000');

  // 2nd request: should skip UDS entirely (sticky) and go straight to TCP.
  const r2 = await client.treaty.v1.sessions.post({ title: 'b' });
  expect(createSessionResponse(r2.data).sessionId).toBe('ses_T00000000000');

  expect(attempts.filter((attempt) => attempt.unix).length).toBe(1); // UDS probed only once
  const tcpAttempts = attempts.filter((attempt) => !attempt.unix);
  expect(tcpAttempts.length).toBe(2); // both requests ultimately over TCP
  expect(tcpAttempts.every((attempt) => attempt.tls?.rejectUnauthorized === false)).toBe(true);
});

test('streamEvents delivers live SSE events by draining the raw fetch Response body', async () => {
  // streamEvents now runs on the generic stream<T> engine over a raw fetch (no Eden Treaty for the
  // SSE routes), so the body is a real `Response` whose reader we drain frame by frame. Guards the
  // live-event path that once silently degraded to block-style.
  const sessionId = 'ses_STREAMTEST00' as const;
  const mkEvent = (i: number, delta: string) => ({
    id: `evt_STREAMTEST0${i}`,
    sessionId,
    type: 'session.message.delta.appended',
    actorAgentId: null,
    payload: {
      transcriptTargetId: sessionId,
      producer: { kind: 'system', subsystem: 'client-test' },
      messageId: 'msg_STREAMTEST00',
      channel: 'answer',
      delta,
      index: i
    },
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
    client.streamEvents('ses_GONE00000000' as SessionId, () => {}, {
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
  const sessionId = 'ses_UISTREAM0000' as const;
  const mkEvent = (i: number): SessionUiEvent => {
    if (i === 0) return { kind: 'snapshot', cursor: 'evt_UI0000000000', items: [] };
    return {
      kind: 'upsert',
      cursor: 'evt_UI1000000000',
      item: {
        kind: 'message',
        id: 'msg_UI0000000000',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hello' }],
        status: 'streaming',
        seq: 'evt_UI1000000000'
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
  const sessionId = 'ses_UIABORT00000' as const;
  const event: SessionUiEvent = { kind: 'snapshot', cursor: 'evt_UIABORT00000', items: [] };
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
});

const generationSessionId = 'ses_100000000000' as SessionId;
const generationMessage: ChatMessage = {
  id: 'msg_100000000000',
  sessionId: generationSessionId,
  role: 'assistant',
  text: '',
  type: 'markdown',
  stream: {
    status: 'streaming',
    source: { transcriptTargetId: generationSessionId, messageId: 'msg_100000000000' }
  },
  active: true,
  createdAt: '2026-07-19T00:00:00.000Z'
};

function generationEvent(
  id: EventId,
  type: 'session.message.delta.appended' | 'session.message.completed'
): MessageGenerationEvent {
  return {
    id,
    sessionId: generationSessionId,
    type,
    actorAgentId: null,
    payload:
      type === 'session.message.delta.appended'
        ? {
            transcriptTargetId: generationSessionId,
            producer: { kind: 'system', subsystem: 'client-test' },
            messageId: generationMessage.id,
            channel: 'answer',
            index: 0,
            delta: 'hello'
          }
        : {
            transcriptTargetId: generationSessionId,
            producer: { kind: 'system', subsystem: 'client-test' },
            message: { ...generationMessage, text: 'hello', stream: { status: 'complete' } },
            messageRevision: 2
          },
    at: '2026-07-19T00:00:01.000Z'
  } as MessageGenerationEvent;
}

function sseGenerationFrame(frame: MessageGenerationFrame): string {
  const id = frame.kind === 'event' ? `id: ${frame.event.id}\n` : '';
  return `${id}data: ${JSON.stringify(frame)}\n\n`;
}

test('streamMessageGeneration validates frames and stops delivery at the terminal event', async () => {
  const snapshot: MessageGenerationFrame = {
    kind: 'snapshot',
    message: generationMessage,
    messageRevision: 1,
    deltas: []
  };
  const delta: MessageGenerationFrame = {
    kind: 'event',
    event: generationEvent('evt_100000000001', 'session.message.delta.appended')
  };
  const terminal: MessageGenerationFrame = {
    kind: 'event',
    event: generationEvent('evt_100000000002', 'session.message.completed')
  };
  const late: MessageGenerationFrame = {
    kind: 'event',
    event: generationEvent('evt_100000000003', 'session.message.delta.appended')
  };
  globalThis.fetch = (async () =>
    new Response(
      sseGenerationFrame(snapshot) +
        sseGenerationFrame(delta) +
        sseGenerationFrame(terminal) +
        sseGenerationFrame(late),
      {
        headers: { 'content-type': 'text/event-stream' }
      }
    )) as unknown as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const received: MessageGenerationFrame[] = [];
  await new Promise<void>((resolve) => {
    client.streamMessageGeneration(generationSessionId, generationMessage.id, (frame) => {
      received.push(frame);
      if (frame.kind === 'event' && frame.event.type === 'session.message.completed') setTimeout(resolve, 0);
    });
    setTimeout(resolve, 2000);
  });

  expect(received).toEqual([snapshot, delta, terminal]);
});

test('streamMessageGeneration treats an authoritative settled snapshot as terminal', async () => {
  const settledSnapshot: MessageGenerationFrame = {
    kind: 'snapshot',
    message: { ...generationMessage, text: 'already done', stream: { status: 'complete' } },
    messageRevision: 2,
    deltas: []
  };
  const late: MessageGenerationFrame = {
    kind: 'event',
    event: generationEvent('evt_100000000004', 'session.message.delta.appended')
  };
  globalThis.fetch = (async () =>
    new Response(sseGenerationFrame(settledSnapshot) + sseGenerationFrame(late), {
      headers: { 'content-type': 'text/event-stream' }
    })) as unknown as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const received: MessageGenerationFrame[] = [];
  await new Promise<void>((resolve) => {
    client.streamMessageGeneration(generationSessionId, generationMessage.id, (frame) => {
      received.push(frame);
      setTimeout(resolve, 0);
    });
    setTimeout(resolve, 2000);
  });

  expect(received).toEqual([settledSnapshot]);
});

test('streamMessageGeneration rejects a malformed frame without delivering later data', async () => {
  const snapshot: MessageGenerationFrame = {
    kind: 'snapshot',
    message: generationMessage,
    messageRevision: 1,
    deltas: []
  };
  const validAfterMalformed: MessageGenerationFrame = {
    kind: 'event',
    event: generationEvent('evt_100000000005', 'session.message.delta.appended')
  };
  const malformed = {
    kind: 'event',
    event: {
      id: 'evt_100000000006',
      sessionId: generationSessionId,
      type: 'session.message.delta.appended',
      actorAgentId: null,
      payload: { messageId: generationMessage.id },
      at: '2026-07-19T00:00:01.000Z'
    }
  };
  globalThis.fetch = (async () =>
    new Response(
      `${sseGenerationFrame(snapshot)}data: ${JSON.stringify(malformed)}\n\n${sseGenerationFrame(validAfterMalformed)}`,
      { headers: { 'content-type': 'text/event-stream' } }
    )) as unknown as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const received: MessageGenerationFrame[] = [];
  const errors: StreamError[] = [];
  await new Promise<void>((resolve) => {
    client.streamMessageGeneration(generationSessionId, generationMessage.id, (frame) => received.push(frame), {
      onError: (error) => {
        errors.push(error);
        resolve();
      }
    });
    setTimeout(resolve, 2000);
  });

  expect(received).toEqual([snapshot]);
  expect(
    errors.map(({ kind, cause }) => ({ kind, message: cause instanceof Error ? cause.message : undefined }))
  ).toEqual([{ kind: 'fatal', message: 'invalid message generation frame' }]);
});

test('streamMessageGeneration resumes with both cursor forms and its disposer aborts the request', async () => {
  let captured: { signal?: AbortSignal; url: URL; headers: Headers } | undefined;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    captured = { signal: init?.signal ?? undefined, url: new URL(String(input)), headers: new Headers(init?.headers) };
    return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      headers: { 'content-type': 'text/event-stream' }
    });
  }) as typeof fetch;
  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const dispose = client.streamMessageGeneration(generationSessionId, generationMessage.id, () => {}, {
    afterEventId: 'evt_100000000007'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  dispose();

  expect({
    path: captured?.url.pathname,
    after: captured?.url.searchParams.get('after'),
    lastEventId: captured?.headers.get('last-event-id'),
    aborted: captured?.signal?.aborted
  }).toEqual({
    path: '/v1/sessions/ses_100000000000/messages/msg_100000000000/stream',
    after: 'evt_100000000007',
    lastEventId: 'evt_100000000007',
    aborted: true
  });
});

test('streamInteractionEvents subscribes over the control websocket', async () => {
  const interaction: InteractionEvent = {
    type: 'upsert',
    interaction: {
      id: 'interaction-stream-1',
      source: { kind: 'builtin', id: 'sandbox', label: 'Sandbox' },
      request: { type: 'confirm', title: 'Allow?' },
      mode: 'foreground',
      state: 'pending',
      createdAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-07-14T00:05:00.000Z'
    }
  };
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(null, { status: 500 });
  }) as unknown as typeof fetch;

  const sent: string[] = [];
  let socket: { emit: (type: 'open' | 'message', event?: unknown) => void } | undefined;
  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(readonly url: string) {
      socket = this;
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
      set.add(listener);
      this.listeners.set(type, set);
    }

    send(data: string): void {
      sent.push(data);
    }

    close(): void {
      this.readyState = 3;
    }

    emit(type: 'open' | 'message', event: unknown = {}): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const received: InteractionEvent[] = [];
  let dispose: (() => void) | undefined;

  await new Promise<void>((resolve) => {
    dispose = client.streamInteractionEvents((event) => {
      received.push(event);
      dispose?.();
      setTimeout(resolve, 0);
    });
    socket?.emit('open');
    socket?.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', method: 'interactions.event', params: { event: interaction } })
    });
    setTimeout(resolve, 2000);
  });

  expect(urls).toEqual([]);
  expect(sent.map((value) => JSON.parse(value))).toEqual([
    { jsonrpc: '2.0', method: 'control.subscribe', params: {} },
    { jsonrpc: '2.0', method: 'control.subscribe', params: {} },
    { jsonrpc: '2.0', method: 'control.unsubscribe', params: {} }
  ]);
  expect(received).toEqual([interaction]);
});

test('mesh-agent observation clients validate history and connection responses', async () => {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith('/events/raw')) {
      return Response.json({ records: [{ cursor: 'raw:1', data: { native: true } }], coverage: 'exact' });
    }
    if (url.pathname.endsWith('/events/convenience')) {
      return Response.json({
        frames: [{ kind: 'ready', observationEpoch: 'epoch_1' }],
        nextCursor: 'provider:older'
      });
    }
    return Response.json({
      state: 'connected',
      meshSessionId: 'mesh_100000000000',
      provider: 'codex',
      observationEpoch: 'epoch_1',
      revision: 3
    });
  }) as typeof fetch;

  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749', token: 'secret' });
  const target = 'ses_100000000000' as SessionId;
  const providerCursor = 'provider:{"turnId":"019f741c-70a5-7df2-a5f4-04132750aace","includeAnchor":false}';

  expect(
    await client.meshAgentRawEvents('mesh_100000000000', target, {
      limit: 5,
      before: providerCursor
    })
  ).toEqual({
    records: [{ cursor: 'raw:1', data: { native: true } }],
    coverage: 'exact'
  });
  expect(
    await client.meshAgentConvenienceEvents('mesh_100000000000', target, {
      limit: 20
    })
  ).toEqual({
    frames: [{ kind: 'ready', observationEpoch: 'epoch_1' }],
    nextCursor: 'provider:older'
  });
  expect(await client.meshAgentConnection('mesh_100000000000', target)).toEqual({
    state: 'connected',
    meshSessionId: 'mesh_100000000000',
    provider: 'codex',
    observationEpoch: 'epoch_1',
    revision: 3
  });
  expect(
    urls.map((url) => ({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries())
    }))
  ).toEqual([
    {
      path: '/v1/mesh/sessions/mesh_100000000000/events/raw',
      query: {
        transcriptTargetId: target,
        limit: '5',
        before: providerCursor
      }
    },
    {
      path: '/v1/mesh/sessions/mesh_100000000000/events/convenience',
      query: { transcriptTargetId: target, limit: '20' }
    },
    {
      path: '/v1/mesh/sessions/mesh_100000000000/connection',
      query: { transcriptTargetId: target }
    }
  ]);
  expect(urls[0]?.href).toContain(
    'before=provider%3A%7B%22turnId%22%3A%22019f741c-70a5-7df2-a5f4-04132750aace%22%2C%22includeAnchor%22%3Afalse%7D'
  );
  expect(urls[0]?.searchParams.getAll('before')).toEqual([providerCursor]);
});

test('mesh-agent observation streams use resumable schemas and convenience terminal frames', () => {
  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const calls: Array<{ path: string; parsed: unknown; terminal?: boolean; afterEventId?: string }> = [];
  const target = 'ses_100000000000' as SessionId;
  const c = client as unknown as {
    stream: (
      path: string,
      schema: { parse(value: unknown): unknown },
      onFrame: (value: never) => void,
      opts: { afterEventId?: string; isTerminal?: (value: never) => boolean }
    ) => () => void;
  };
  c.stream = (path, schema, _onFrame, opts) => {
    const value = path.endsWith('/raw?transcriptTargetId=ses_100000000000')
      ? {
          meshSessionId: 'mesh_100000000000',
          provider: 'codex',
          origin: 'live',
          cursor: 'live:oep_1:1',
          data: { native: true }
        }
      : { kind: 'unavailable', reason: 'closed' };
    const parsed = schema.parse(value) as never;
    calls.push({ path, parsed, afterEventId: opts.afterEventId, terminal: opts.isTerminal?.(parsed) });
    return () => {};
  };

  client.streamMeshAgentRaw('mesh_100000000000', target, () => {}, { afterCursor: 'live:oep_1:0' });
  client.streamMeshAgentConvenience('mesh_100000000000', target, () => {});

  expect(calls).toEqual([
    {
      path: '/v1/mesh/sessions/mesh_100000000000/stream/raw?transcriptTargetId=ses_100000000000',
      parsed: {
        meshSessionId: 'mesh_100000000000',
        provider: 'codex',
        origin: 'live',
        cursor: 'live:oep_1:1',
        data: { native: true }
      },
      afterEventId: 'live:oep_1:0',
      terminal: undefined
    },
    {
      path: '/v1/mesh/sessions/mesh_100000000000/stream/convenience?transcriptTargetId=ses_100000000000',
      parsed: { kind: 'unavailable', reason: 'closed' },
      afterEventId: undefined,
      terminal: true
    }
  ]);
});
