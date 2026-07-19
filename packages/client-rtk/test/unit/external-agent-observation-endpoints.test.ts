// Offline wiring tests for the observation dual-stream RTK endpoints: raw/convenience history
// queries, the connection snapshot query, and the two streaming queries. All five wrap the plain
// MonadClient methods added for the Observation Dual Stream plan (raw/convenience are http-only,
// no Treaty typing — same shape as stream-external-agent-ui-observation.ts).

import type { MonadClient, StreamError } from '@monad/client';
import type {
  ExternalAgentConnectionSnapshot,
  ExternalAgentConvenienceFrame,
  ExternalAgentRawFrame,
  ExternalAgentRawHistoryPage,
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

test('getExternalAgentRawHistory: forwards id/transcriptTargetId/request and returns the page', async () => {
  const page: ExternalAgentRawHistoryPage = { records: [], coverage: 'exact' };
  let observed: unknown;
  const client = baseClient({
    externalAgentRawHistory: async (id, transcriptTargetId, request) => {
      observed = { id, transcriptTargetId, request };
      return page;
    }
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getExternalAgentRawHistory', {
    id: 'exa_100000000000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });

  expect(observed).toEqual({
    id: 'exa_100000000000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });
  expect(res.data).toEqual(page);
});

test('getExternalAgentRawHistory: maps a thrown client error to the query error', async () => {
  const client = baseClient({
    externalAgentRawHistory: async () => {
      throw new Error('external agent observation request failed: 404');
    }
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getExternalAgentRawHistory', {
    id: 'exa_missing0000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });

  expect((res.error as { message?: string } | undefined)?.message).toBe(
    'external agent observation request failed: 404'
  );
});

test('getExternalAgentConvenienceHistory: forwards args and returns the frame list', async () => {
  const frames: ExternalAgentConvenienceFrame[] = [{ kind: 'ready', observationEpoch: 'ep_1' }];
  let observed: unknown;
  const client = baseClient({
    externalAgentConvenienceHistory: async (id, transcriptTargetId, request) => {
      observed = { id, transcriptTargetId, request };
      return frames;
    }
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getExternalAgentConvenienceHistory', {
    id: 'exa_100000000000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });

  expect(observed).toEqual({
    id: 'exa_100000000000',
    transcriptTargetId: SESSION_ID,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });
  expect(res.data).toEqual(frames);
});

test('getExternalAgentConnection: returns the connected snapshot', async () => {
  const snapshot: ExternalAgentConnectionSnapshot = {
    state: 'connected',
    externalAgentSessionId: 'exa_100000000000' as never,
    provider: 'codex' as never,
    observationEpoch: 'ep_1',
    revision: 3
  };
  const client = baseClient({
    externalAgentConnection: async () => snapshot
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getExternalAgentConnection', {
    id: 'exa_100000000000',
    transcriptTargetId: SESSION_ID
  });

  expect(res.data).toEqual(snapshot);
});

test('getExternalAgentConnection: maps a thrown client error to the query error', async () => {
  const client = baseClient({
    externalAgentConnection: async () => {
      throw new Error('external agent observation request failed: 410');
    }
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getExternalAgentConnection', {
    id: 'exa_gone00000000',
    transcriptTargetId: SESSION_ID
  });

  expect((res.error as { message?: string } | undefined)?.message).toBe(
    'external agent observation request failed: 410'
  );
});

test('streamExternalAgentRaw: subscribes with afterCursor and preserves every frame from a synchronous bootstrap', async () => {
  let onFrame: ((frame: ExternalAgentRawFrame) => void) | undefined;
  let observedArgs: unknown;
  const client = baseClient({
    streamExternalAgentRaw: (id, transcriptTargetId, frameHandler, opts) => {
      observedArgs = { id, transcriptTargetId, afterCursor: opts?.afterCursor };
      onFrame = frameHandler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const sub = dispatchEndpoint(store, 'streamExternalAgentRaw', {
    id: 'exa_100000000000',
    transcriptTargetId: SESSION_ID,
    afterCursor: 'cur_5'
  });
  await sub;

  expect(observedArgs).toEqual({ id: 'exa_100000000000', transcriptTargetId: SESSION_ID, afterCursor: 'cur_5' });

  const frame: ExternalAgentRawFrame = {
    externalAgentSessionId: 'exa_100000000000' as never,
    provider: 'codex' as never,
    origin: 'live',
    cursor: 'cur_6',
    data: 'hello'
  };
  const nextFrame: ExternalAgentRawFrame = { ...frame, cursor: 'cur_7', data: 'world' };
  onFrame?.(frame);
  onFrame?.(nextFrame);
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamExternalAgentRaw', {
    id: 'exa_100000000000',
    transcriptTargetId: SESSION_ID,
    afterCursor: 'cur_5'
  });
  expect(data).toEqual({ fatalError: false, frames: [frame, nextFrame], frameOffset: 0 });

  sub.unsubscribe?.();
});

test('streamExternalAgentRaw: a fatal stream error marks the cache entry fatal and clears the frame', async () => {
  let onError: ((error: StreamError) => void) | undefined;
  const client = baseClient({
    streamExternalAgentRaw: (_id, _transcriptTargetId, _frameHandler, opts) => {
      onError = opts?.onError;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'exa_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamExternalAgentRaw', arg);
  await sub;

  onError?.({ kind: 'fatal', status: 401 });
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamExternalAgentRaw', arg);
  expect(data).toEqual({ fatalError: true, frames: [], frameOffset: 0 });

  sub.unsubscribe?.();
});

test('streamExternalAgentConvenience: preserves ready and every projected frame from a synchronous bootstrap', async () => {
  let onFrame: ((frame: ExternalAgentConvenienceFrame) => void) | undefined;
  const client = baseClient({
    streamExternalAgentConvenience: (_id, _transcriptTargetId, frameHandler) => {
      onFrame = frameHandler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'exa_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamExternalAgentConvenience', arg);
  await sub;

  const ready: ExternalAgentConvenienceFrame = { kind: 'ready', observationEpoch: 'ep_1', historyBefore: 'cur_1' };
  const upsert: ExternalAgentConvenienceFrame = {
    kind: 'upsert',
    cursor: 'cur_2',
    event: {
      id: 'obs_1',
      kind: 'assistant-message',
      streaming: false,
      text: 'Projected activity',
      provenance: { contractEvents: [{ raw: 'frame_1' }] }
    }
  };
  const terminal: ExternalAgentConvenienceFrame = { kind: 'unavailable', reason: 'session exited' };
  onFrame?.(ready);
  onFrame?.(upsert);
  onFrame?.(terminal);
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamExternalAgentConvenience', arg);
  expect(data).toEqual({ fatalError: false, frames: [ready, upsert, terminal], frameOffset: 0 });

  sub.unsubscribe?.();
});

test('streamExternalAgentRaw: rollover past the cap evicts the oldest frames but keeps the latest window', async () => {
  const RAW_FRAME_CAP = 1000;
  let onFrame: ((frame: ExternalAgentRawFrame) => void) | undefined;
  const client = baseClient({
    streamExternalAgentRaw: (_id, _transcriptTargetId, frameHandler) => {
      onFrame = frameHandler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'exa_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamExternalAgentRaw', arg);
  await sub;

  const frame = (cursor: string): ExternalAgentRawFrame => ({
    externalAgentSessionId: 'exa_100000000000' as never,
    provider: 'codex' as never,
    origin: 'live',
    cursor,
    data: cursor
  });
  const total = RAW_FRAME_CAP + 5;
  for (let i = 0; i < total; i++) onFrame?.(frame(`cur_${i}`));
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamExternalAgentRaw', arg) as {
    fatalError: boolean;
    frames: ExternalAgentRawFrame[];
    frameOffset: number;
  };
  expect(data.fatalError).toBe(false);
  expect(data.frameOffset).toBe(5);
  expect(data.frames).toHaveLength(RAW_FRAME_CAP);
  expect(data.frames[0]).toEqual(frame('cur_5'));
  expect(data.frames.at(-1)).toEqual(frame(`cur_${total - 1}`));

  // A consumer reading with the count-ref pattern from `use-observation-panel.ts` must still see every
  // frame still in the window, even though it starts consuming only after rollover already happened.
  const consumedRef = { current: 0 };
  const availableEnd = data.frameOffset + data.frames.length;
  const sliceStart = Math.max(consumedRef.current, data.frameOffset) - data.frameOffset;
  const consumedFrames = data.frames.slice(sliceStart);
  consumedRef.current = availableEnd;
  expect(consumedFrames).toHaveLength(RAW_FRAME_CAP);
  expect(consumedFrames[0]).toEqual(frame('cur_5'));

  onFrame?.(frame(`cur_${total}`));
  await Promise.resolve();
  const nextData = selectEndpointData(store, 'streamExternalAgentRaw', arg) as {
    frames: ExternalAgentRawFrame[];
    frameOffset: number;
  };
  const nextAvailableEnd = nextData.frameOffset + nextData.frames.length;
  const nextSliceStart = Math.max(consumedRef.current, nextData.frameOffset) - nextData.frameOffset;
  const nextConsumedFrames = nextData.frames.slice(nextSliceStart);
  expect(nextConsumedFrames).toEqual([frame(`cur_${total}`)]);
  consumedRef.current = nextAvailableEnd;

  sub.unsubscribe?.();
});

test('streamExternalAgentConvenience: rollover past the cap evicts the oldest frames but keeps the latest window', async () => {
  const CONVENIENCE_FRAME_CAP = 1000;
  let onFrame: ((frame: ExternalAgentConvenienceFrame) => void) | undefined;
  const client = baseClient({
    streamExternalAgentConvenience: (_id, _transcriptTargetId, frameHandler) => {
      onFrame = frameHandler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'exa_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamExternalAgentConvenience', arg);
  await sub;

  const frame = (cursor: string): ExternalAgentConvenienceFrame => ({
    kind: 'upsert',
    cursor,
    event: {
      id: `obs_${cursor}`,
      kind: 'assistant-message',
      streaming: false,
      text: cursor,
      provenance: { contractEvents: [{ raw: cursor }] }
    }
  });
  const total = CONVENIENCE_FRAME_CAP + 3;
  for (let i = 0; i < total; i++) onFrame?.(frame(`cur_${i}`));
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamExternalAgentConvenience', arg) as {
    fatalError: boolean;
    frames: ExternalAgentConvenienceFrame[];
    frameOffset: number;
  };
  expect(data.frameOffset).toBe(3);
  expect(data.frames).toHaveLength(CONVENIENCE_FRAME_CAP);
  expect(data.frames[0]).toEqual(frame('cur_3'));
  expect(data.frames.at(-1)).toEqual(frame(`cur_${total - 1}`));

  sub.unsubscribe?.();
});

test('streamExternalAgentRaw: a fatal error after frames advances frameOffset so absolute counting stays monotonic', async () => {
  let onFrame: ((frame: ExternalAgentRawFrame) => void) | undefined;
  let onError: ((error: StreamError) => void) | undefined;
  const client = baseClient({
    streamExternalAgentRaw: (_id, _transcriptTargetId, frameHandler, opts) => {
      onFrame = frameHandler;
      onError = opts?.onError;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  const arg = { id: 'exa_100000000000', transcriptTargetId: SESSION_ID };
  const sub = dispatchEndpoint(store, 'streamExternalAgentRaw', arg);
  await sub;

  const frame: ExternalAgentRawFrame = {
    externalAgentSessionId: 'exa_100000000000' as never,
    provider: 'codex' as never,
    origin: 'live',
    cursor: 'cur_1',
    data: 'hello'
  };
  onFrame?.(frame);
  onFrame?.({ ...frame, cursor: 'cur_2', data: 'world' });
  onError?.({ kind: 'fatal', status: 401 });
  await Promise.resolve();

  const data = selectEndpointData(store, 'streamExternalAgentRaw', arg);
  expect(data).toEqual({ fatalError: true, frames: [], frameOffset: 2 });

  sub.unsubscribe?.();
});
