// Offline wiring tests for the observation dual-stream RTK endpoints: raw/convenience history
// queries, the connection snapshot query, and the two streaming queries. All five wrap the plain
// MonadClient methods added for the Observation Dual Stream plan (raw/convenience are http-only,
// no Treaty typing — same shape as stream-mesh-agent-ui-observation.ts).

import type { MonadClient, StreamError } from '@monad/client';
import type {
  MeshConnectionSnapshot,
  MeshConvenienceFrame,
  MeshRawEvent,
  MeshRawEventPage,
  SessionId
} from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createMonadStore, monadApi } from '../../src/index.ts';

type LooseEndpoint = {
  initiate: (arg?: unknown) => unknown;
  select: (arg?: unknown) => (state: unknown) => { data?: unknown };
};

function endpoint(name: string): LooseEndpoint {
  const endpointMap = monadApi.endpoints as Record<string, LooseEndpoint | undefined>;
  const value = endpointMap[name];
  if (!value) throw new Error(`missing endpoint: ${name}`);
  return value;
}

function selectEndpointData(store: ReturnType<typeof createMonadStore>, name: string, arg?: unknown): unknown {
  return endpoint(name).select(arg)(store.getState()).data;
}

interface EndpointDispatchResult {
  data?: unknown;
  error?: unknown;
  unsubscribe?: () => void;
}

function dispatchEndpoint(
  store: ReturnType<typeof createMonadStore>,
  name: string,
  arg?: unknown
): EndpointDispatchResult & Promise<EndpointDispatchResult> {
  return store.dispatch(endpoint(name).initiate(arg) as never) as EndpointDispatchResult &
    Promise<EndpointDispatchResult>;
}

const SESSION_ID = 'ses_100000000000' as SessionId;

function baseClient(overrides: Partial<MonadClient>): MonadClient {
  return {
    treaty: { v1: {}, health: { get: async () => ({ data: { status: 'ok', version: '1.0.0' }, error: null }) } },
    fetch: async () => new Response(null, { status: 404 }),
    subscribeControl: () => () => {},
    streamEvents: () => () => {},
    ...overrides
  } as unknown as MonadClient;
}

test('getMeshAgentRawEvents: forwards id/transcriptTargetId/request and returns the page', async () => {
  const page: MeshRawEventPage = { records: [], coverage: 'exact' };
  let observed: unknown;
  const client = baseClient({
    meshAgentRawEvents: async (id, transcriptTargetId, request) => {
      observed = { id, transcriptTargetId, request };
      return page;
    }
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getMeshAgentRawEvents', {
    id: 'mesh_100000000000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });

  expect(observed).toEqual({
    id: 'mesh_100000000000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });
  expect(res.data).toEqual(page);
});

test('getMeshAgentRawEvents: maps a thrown client error to the query error', async () => {
  const client = baseClient({
    meshAgentRawEvents: async () => {
      throw new Error('MeshAgent observation request failed: 404');
    }
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getMeshAgentRawEvents', {
    id: 'mesh_missing0000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });

  expect((res.error as { message?: string } | undefined)?.message).toBe('MeshAgent observation request failed: 404');
});

test('getMeshAgentConvenienceEvents: forwards args and preserves the next history cursor', async () => {
  const frames: MeshConvenienceFrame[] = [{ kind: 'ready', observationEpoch: 'ep_1' }];
  const page = { frames, nextCursor: 'provider:older' as const };
  let observed: unknown;
  const client = baseClient({
    meshAgentConvenienceEvents: async (id, transcriptTargetId, request) => {
      observed = { id, transcriptTargetId, request };
      return page;
    }
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getMeshAgentConvenienceEvents', {
    id: 'mesh_100000000000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });

  expect(observed).toEqual({
    id: 'mesh_100000000000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });
  expect(res.data).toEqual(page);
});

test('getMeshAgentConnection: returns the connected snapshot', async () => {
  const snapshot: MeshConnectionSnapshot = {
    state: 'connected',
    meshSessionId: 'mesh_100000000000' as never,
    provider: 'codex' as never,
    observationEpoch: 'ep_1',
    revision: 3
  };
  const client = baseClient({
    meshAgentConnection: async () => snapshot
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getMeshAgentConnection', {
    id: 'mesh_100000000000',
    transcriptTargetId: SESSION_ID
  });

  expect(res.data).toEqual(snapshot);
});

test('getMeshAgentConnection: maps a thrown client error to the query error', async () => {
  const client = baseClient({
    meshAgentConnection: async () => {
      throw new Error('MeshAgent observation request failed: 410');
    }
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getMeshAgentConnection', {
    id: 'mesh_gone00000000',
    transcriptTargetId: SESSION_ID
  });

  expect((res.error as { message?: string } | undefined)?.message).toBe('MeshAgent observation request failed: 410');
});

test('streamMeshAgentRaw: subscribes with afterCursor and preserves every frame from a synchronous bootstrap', async () => {
  let onFrame: ((frame: MeshRawEvent) => void) | undefined;
  let observedArgs: unknown;
  const client = baseClient({
    streamMeshAgentRaw: (id, transcriptTargetId, frameHandler, opts) => {
      observedArgs = { id, transcriptTargetId, afterCursor: opts?.afterCursor };
      onFrame = frameHandler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const sub = dispatchEndpoint(store, 'streamMeshAgentRaw', {
    id: 'mesh_100000000000',
    transcriptTargetId: SESSION_ID,
    afterCursor: 'cur_5'
  });
  await sub;

  expect(observedArgs).toEqual({ id: 'mesh_100000000000', transcriptTargetId: SESSION_ID, afterCursor: 'cur_5' });

  const frame: MeshRawEvent = {
    meshSessionId: 'mesh_100000000000' as never,
    provider: 'codex' as never,
    origin: 'live',
    cursor: 'live:e1:6',
    data: 'hello'
  };
  const nextFrame: MeshRawEvent = { ...frame, cursor: 'live:e1:7', data: 'world' };
  onFrame?.(frame);
  onFrame?.(nextFrame);
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamMeshAgentRaw', {
    id: 'mesh_100000000000',
    transcriptTargetId: SESSION_ID,
    afterCursor: 'cur_5'
  });
  expect(data).toEqual({ fatalError: false, frames: [frame, nextFrame], frameOffset: 0 });

  sub.unsubscribe?.();
});

test('streamMeshAgentRaw: a fatal stream error marks the cache entry fatal and clears the frame', async () => {
  let onError: ((error: StreamError) => void) | undefined;
  const client = baseClient({
    streamMeshAgentRaw: (_id, _transcriptTargetId, _frameHandler, opts) => {
      onError = opts?.onError;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'mesh_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamMeshAgentRaw', arg);
  await sub;

  onError?.({ kind: 'fatal', status: 401 });
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamMeshAgentRaw', arg);
  expect(data).toEqual({ fatalError: true, frames: [], frameOffset: 0 });

  sub.unsubscribe?.();
});

test('streamMeshAgentConvenience: preserves ready and every projected frame from a synchronous bootstrap', async () => {
  let onFrame: ((frame: MeshConvenienceFrame) => void) | undefined;
  const client = baseClient({
    streamMeshAgentConvenience: (_id, _transcriptTargetId, frameHandler) => {
      onFrame = frameHandler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'mesh_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamMeshAgentConvenience', arg);
  await sub;

  const ready: MeshConvenienceFrame = {
    kind: 'ready',
    observationEpoch: 'ep_1',
    cursor: 'live:e1:1',
    eventsBefore: 'provider:cur_1'
  };
  const upsert: MeshConvenienceFrame = {
    kind: 'patch',
    cursor: 'live:e1:2',
    operations: [
      {
        op: 'upsert',
        event: {
          id: 'obs_1',
          kind: 'assistant-message',
          streaming: false,
          text: 'Projected activity',
          provenance: { contractEvents: [{ raw: 'frame_1' }] }
        }
      }
    ]
  };
  const terminal: MeshConvenienceFrame = { kind: 'unavailable', reason: 'session exited' };
  onFrame?.(ready);
  onFrame?.(upsert);
  onFrame?.(terminal);
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamMeshAgentConvenience', arg);
  expect(data).toEqual({ fatalError: false, frames: [ready, upsert, terminal], frameOffset: 0 });

  sub.unsubscribe?.();
});

test('streamMeshAgentRaw: rollover past the cap evicts the oldest frames but keeps the latest window', async () => {
  const RAW_FRAME_CAP = 1000;
  let onFrame: ((frame: MeshRawEvent) => void) | undefined;
  const client = baseClient({
    streamMeshAgentRaw: (_id, _transcriptTargetId, frameHandler) => {
      onFrame = frameHandler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'mesh_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamMeshAgentRaw', arg);
  await sub;

  const frame = (seq: number): MeshRawEvent => ({
    meshSessionId: 'mesh_100000000000' as never,
    provider: 'codex' as never,
    origin: 'live',
    cursor: `live:e1:${seq}`,
    data: String(seq)
  });
  const total = RAW_FRAME_CAP + 5;
  for (let i = 0; i < total; i++) onFrame?.(frame(i));
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamMeshAgentRaw', arg) as {
    fatalError: boolean;
    frames: MeshRawEvent[];
    frameOffset: number;
  };
  expect(data.fatalError).toBe(false);
  expect(data.frameOffset).toBe(5);
  expect(data.frames).toHaveLength(RAW_FRAME_CAP);
  expect(data.frames[0]).toEqual(frame(5));
  expect(data.frames.at(-1)).toEqual(frame(total - 1));

  // A consumer reading with the count-ref pattern from `use-observation-panel.ts` must still see every
  // frame still in the window, even though it starts consuming only after rollover already happened.
  const consumedRef = { current: 0 };
  const availableEnd = data.frameOffset + data.frames.length;
  const sliceStart = Math.max(consumedRef.current, data.frameOffset) - data.frameOffset;
  const consumedFrames = data.frames.slice(sliceStart);
  consumedRef.current = availableEnd;
  expect(consumedFrames).toHaveLength(RAW_FRAME_CAP);
  expect(consumedFrames[0]).toEqual(frame(5));

  onFrame?.(frame(total));
  await Promise.resolve();
  const nextData = selectEndpointData(store, 'streamMeshAgentRaw', arg) as {
    frames: MeshRawEvent[];
    frameOffset: number;
  };
  const nextAvailableEnd = nextData.frameOffset + nextData.frames.length;
  const nextSliceStart = Math.max(consumedRef.current, nextData.frameOffset) - nextData.frameOffset;
  const nextConsumedFrames = nextData.frames.slice(nextSliceStart);
  expect(nextConsumedFrames).toEqual([frame(total)]);
  consumedRef.current = nextAvailableEnd;

  sub.unsubscribe?.();
});

test('streamMeshAgentConvenience: rollover past the cap evicts the oldest frames but keeps the latest window', async () => {
  const CONVENIENCE_FRAME_CAP = 1000;
  let onFrame: ((frame: MeshConvenienceFrame) => void) | undefined;
  const client = baseClient({
    streamMeshAgentConvenience: (_id, _transcriptTargetId, frameHandler) => {
      onFrame = frameHandler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'mesh_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamMeshAgentConvenience', arg);
  await sub;

  const frame = (seq: number): MeshConvenienceFrame => ({
    kind: 'patch',
    cursor: `live:e1:${seq}`,
    operations: [
      {
        op: 'upsert',
        event: {
          id: `obs_${seq}`,
          kind: 'assistant-message',
          streaming: false,
          text: String(seq),
          provenance: { contractEvents: [{ raw: String(seq) }] }
        }
      }
    ]
  });
  const total = CONVENIENCE_FRAME_CAP + 3;
  for (let i = 0; i < total; i++) onFrame?.(frame(i));
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamMeshAgentConvenience', arg) as {
    fatalError: boolean;
    frames: MeshConvenienceFrame[];
    frameOffset: number;
  };
  expect(data.frameOffset).toBe(3);
  expect(data.frames).toHaveLength(CONVENIENCE_FRAME_CAP);
  expect(data.frames[0]).toEqual(frame(3));
  expect(data.frames.at(-1)).toEqual(frame(total - 1));

  sub.unsubscribe?.();
});

test('streamMeshAgentRaw: a fatal error after frames advances frameOffset so absolute counting stays monotonic', async () => {
  let onFrame: ((frame: MeshRawEvent) => void) | undefined;
  let onError: ((error: StreamError) => void) | undefined;
  const client = baseClient({
    streamMeshAgentRaw: (_id, _transcriptTargetId, frameHandler, opts) => {
      onFrame = frameHandler;
      onError = opts?.onError;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'mesh_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamMeshAgentRaw', arg);
  await sub;

  const frame: MeshRawEvent = {
    meshSessionId: 'mesh_100000000000' as never,
    provider: 'codex' as never,
    origin: 'live',
    cursor: 'live:e1:1',
    data: 'hello'
  };
  onFrame?.(frame);
  onFrame?.({ ...frame, cursor: 'live:e1:2', data: 'world' });
  onError?.({ kind: 'fatal', status: 401 });
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamMeshAgentRaw', arg);
  expect(data).toEqual({ fatalError: true, frames: [], frameOffset: 2 });

  sub.unsubscribe?.();
});
