import type { MeshAgentStateFrame, SessionId } from '@monad/protocol';

import { afterEach, expect, test } from 'bun:test';

import { waitFor } from '../../../scripts/test-wait.ts';
import { MonadClient, type StreamError } from '../src/index.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const sessionId = 'ses_1234567890ab' as SessionId;
const snapshot: MeshAgentStateFrame = {
  kind: 'snapshot',
  cursor: 'evt_000000000001',
  sessions: [],
  loginRequirements: [],
  approvals: []
};

test('streamMeshAgentState validates frames and resumes with the canonical event id', async () => {
  let captured: { signal?: AbortSignal; url: URL; headers: Headers } | undefined;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    captured = { signal: init?.signal ?? undefined, url: new URL(String(input)), headers: new Headers(init?.headers) };
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`id: evt_000000000001\ndata: ${JSON.stringify(snapshot)}\n\n`));
        }
      }),
      {
        headers: { 'content-type': 'text/event-stream' }
      }
    );
  }) as typeof fetch;
  const received: MeshAgentStateFrame[] = [];
  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  const dispose = client.streamMeshAgentState(sessionId, (frame) => received.push(frame), {
    afterEventId: 'evt_000000000000'
  });
  await waitFor(() => received.length === 1, { message: 'snapshot frame was never delivered' });
  dispose();

  expect({
    received,
    path: captured?.url.pathname,
    after: captured?.url.searchParams.get('after'),
    lastEventId: captured?.headers.get('last-event-id'),
    aborted: captured?.signal?.aborted
  }).toEqual({
    received: [snapshot],
    path: '/v1/sessions/ses_1234567890ab/mesh-state/stream',
    after: 'evt_000000000000',
    lastEventId: 'evt_000000000000',
    aborted: true
  });
});

test('streamMeshAgentState stops an invalid frame as fatal', async () => {
  globalThis.fetch = (async () =>
    new Response('data: {"kind":"snapshot","sessions":[],"loginRequirements":[],"approvals":[],"label":"UI"}\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    })) as unknown as typeof fetch;
  const errors: StreamError[] = [];
  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  client.streamMeshAgentState(sessionId, () => {}, {
    onError: (error) => errors.push(error)
  });
  await waitFor(() => errors.length === 1, { message: 'invalid frame never reported an error' });

  expect(
    errors.map((error) => ({
      kind: error.kind,
      message: error.cause instanceof Error ? error.cause.message : undefined
    }))
  ).toEqual([{ kind: 'fatal', message: 'invalid mesh agent state frame' }]);
});

test('streamMeshAgentState treats a wrong-scope anchor as fatal', async () => {
  globalThis.fetch = (async () => new Response(null, { status: 409 })) as unknown as typeof fetch;
  const errors: StreamError[] = [];
  const client = new MonadClient({ baseUrl: 'http://127.0.0.1:52749' });
  client.streamMeshAgentState(sessionId, () => {}, {
    afterEventId: 'evt_000000000009',
    onError: (error) => errors.push(error)
  });
  await waitFor(() => errors.length === 1, { message: 'wrong-scope anchor never reported an error' });

  expect(errors.map(({ kind, status }) => ({ kind, status }))).toEqual([{ kind: 'fatal', status: 409 }]);
});
