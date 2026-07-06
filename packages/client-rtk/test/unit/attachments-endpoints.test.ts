// Offline wiring tests for the attachments/draft-attachments endpoints. All three routes
// live on http-only daemon controllers (no Treaty typing), so they go through
// `clientOf(api).fetch` — same pattern as transcribeAudio (settings-endpoints.test.ts).

import type { MonadClient } from '@monad/client';

import { expect, test } from 'bun:test';

import { createMonadStore, monadApi } from '../../src/index.ts';

function endpoint(name: string): { initiate: (arg?: unknown) => unknown } {
  const endpointMap = monadApi.endpoints as Record<string, { initiate: (arg?: unknown) => unknown } | undefined>;
  const value = endpointMap[name];
  if (!value) throw new Error(`missing endpoint: ${name}`);
  return value;
}

interface EndpointDispatchResult {
  data?: unknown;
  error?: unknown;
}

function dispatchEndpoint(
  store: ReturnType<typeof createMonadStore>,
  name: string,
  arg?: unknown
): Promise<EndpointDispatchResult> {
  return store.dispatch(endpoint(name).initiate(arg) as never) as Promise<EndpointDispatchResult>;
}

function fakeClientWithFetch(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>): MonadClient {
  return {
    treaty: { v1: {}, health: { get: async () => ({ data: { status: 'ok', version: '1.0.0' }, error: null }) } },
    fetch: fetchImpl,
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  } as unknown as MonadClient;
}

test('getAttachment: fetches the JSON preview for an attachment', async () => {
  let observedPath: string | undefined;
  const client = fakeClientWithFetch(async (path) => {
    observedPath = path;
    return new Response(
      JSON.stringify({
        attachment: {
          id: 'att_1',
          path: '/tmp/notes.txt',
          name: 'notes.txt',
          mime: 'text/plain',
          bytes: 5,
          createdAt: '2026-07-06T00:00:00.000Z'
        },
        text: 'hello',
        truncated: false
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getAttachment', { id: 'att_1' });

  expect(observedPath).toBe('/v1/attachments/att_1');
  expect((res.data as { text?: string } | undefined)?.text).toBe('hello');
});

test('getAttachment: maps a non-ok response to an error', async () => {
  const client = fakeClientWithFetch(
    async () => new Response(JSON.stringify({ error: 'gone' }), { status: 410, headers: {} })
  );
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getAttachment', { id: 'att_missing' });

  expect((res.error as { status?: number } | undefined)?.status).toBe(410);
});

test('downloadAttachment: requests the binary variant and returns a Blob', async () => {
  let observedPath: string | undefined;
  const client = fakeClientWithFetch(async (path) => {
    observedPath = path;
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    });
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'downloadAttachment', { id: 'att_1' });

  expect(observedPath).toBe('/v1/attachments/att_1?download=1');
  expect((res.data as { blob?: Blob } | undefined)?.blob).toBeInstanceOf(Blob);
});

test('openDraftAttachment: posts the draft attachment payload', async () => {
  let observed: { path: string; body: unknown } | undefined;
  const client = fakeClientWithFetch(async (path, init) => {
    observed = { path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'openDraftAttachment', {
    dataBase64: 'YWJj',
    name: 'notes.txt'
  });

  expect(res.data).toEqual({ ok: true });
  expect(observed).toEqual({
    path: '/v1/draft-attachments/open',
    body: { dataBase64: 'YWJj', name: 'notes.txt' }
  });
});
