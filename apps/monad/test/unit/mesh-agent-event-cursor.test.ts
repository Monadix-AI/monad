import type { MeshAgentEventPageRequest } from '@monad/sdk-atom';
import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentOutputEvent, MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { expect, test } from 'bun:test';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { createLogger } from '@monad/logger';

import { EventBus } from '#/services/event-bus.ts';
import { MeshAgentError } from '#/services/mesh-agent/errors.ts';
import { MeshAgentEventLog } from '#/services/mesh-agent/host/event-log.ts';
import { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';
import { MeshAgentObservationHub } from '#/services/mesh-agent/host/observation-hub.ts';
import { MeshAgentOutputPipeline } from '#/services/mesh-agent/host/output-pipeline.ts';
import { registerAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { LiveRawCursorExpiredError } from '#/services/mesh-agent/live-raw-store.ts';
import { createStore } from '#/store/db/index.ts';

for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

const SESSION_ID = 'mesh_cursorTest00';
const TARGET_ID = 'ses_cursorTest00';

class MemoryLiveRawStore {
  readonly epoch = 'oep_test';
  readonly rows: Array<{
    seq: number;
    stream: 'app-server' | 'pty' | 'stderr' | 'stdout';
    payload: string;
    observedAt: string;
  }> = [];

  append(frame: Omit<(typeof this.rows)[number], 'seq'>) {
    const row = { seq: this.rows.length + 1, ...frame };
    this.rows.push(row);
    return row;
  }

  page(request: { after?: number; before?: number; limit: number; sortDirection: 'asc' | 'desc' }) {
    const selected = this.rows.filter(
      (row) =>
        (request.after === undefined || row.seq > request.after) &&
        (request.before === undefined || row.seq < request.before)
    );
    if (request.sortDirection === 'asc') return { rows: selected.slice(0, request.limit) };
    const rows = selected.slice(-request.limit);
    return { rows, ...(selected.length > rows.length && rows[0] ? { nextBefore: rows[0].seq } : {}) };
  }

  cursorBefore(seq: number) {
    return `live:${this.epoch}:${seq}`;
  }

  parseCursor(cursor: string) {
    return Number(cursor.split(':').at(-1));
  }

  async closeAndDelete() {}
}

function rawOutput(live: LiveMeshSession): string {
  return (
    live.liveRawStore
      ?.page({ limit: 10_000, sortDirection: 'asc' })
      .rows.map((row) => row.payload)
      .join('') ?? ''
  );
}

function jsonRpcParseOutput(chunk: string): MeshAgentOutputEvent[] {
  const record = JSON.parse(chunk) as {
    id: string | number;
    error?: { code: number; message: string };
    result?: { data: unknown[]; nextCursor: string | null };
  };
  if (record.error) {
    return [
      {
        type: 'provider_error',
        payload: { responseId: record.id, code: record.error.code, message: record.error.message }
      }
    ];
  }
  return [
    {
      type: 'event_page',
      payload: {
        responseId: record.id,
        items: record.result?.data ?? [],
        nextCursor: record.result?.nextCursor ?? null,
        backwardsCursor: null
      }
    }
  ];
}

function fakeLive(overrides: Partial<LiveMeshSession> = {}): LiveMeshSession {
  let requestSeq = 7;
  const adapter = {
    provider: 'codex',
    events: {
      projectLive: ({ id, output }: { id: string; output: string }) => ({
        events: [
          {
            id: `${id}:0`,
            dedupeKey: `plain:${output}`,
            projection: 'normalized' as const,
            role: 'agent' as const,
            text: output,
            source: 'plain-text' as const,
            provenance: { rawEvents: [output] }
          }
        ]
      })
    },
    parseOutput: jsonRpcParseOutput,
    resolveApproval: () => {},
    sendInput: () => {},
    resize: () => {},
    stop: () => {}
  } as unknown as MeshAgentProviderAdapter;
  return {
    id: SESSION_ID,
    transcriptTargetId: TARGET_ID,
    agentName: 'codex',
    provider: 'codex',
    runtimeRole: 'interactive',
    proxyApprovals: false,
    adapter,
    launchMode: 'app-server',
    pendingApprovals: new Map(),
    pendingEventPages: new Map(),
    pendingRequests: new Map(),
    nextRequestId: () => requestSeq++,
    liveRawStore: new MemoryLiveRawStore(),
    observationEpoch: 'oep_test',
    outputSeq: 0,
    kill: () => {},
    ...overrides
  } as LiveMeshSession;
}

function jsonIdentityEvents() {
  return {
    projectLive: ({ id, output }: { id: string; output: string }) => ({
      events: output
        .split('\n')
        .filter(Boolean)
        .map((line, index) => {
          const record = JSON.parse(line) as { uuid: string; text?: string };
          return {
            id: `${id}:${index}`,
            dedupeKey: record.uuid,
            projection: 'normalized' as const,
            role: 'agent' as const,
            text: record.text ?? record.uuid,
            source: 'plain-text' as const,
            provenance: { rawEvents: [record] }
          };
        })
    })
  };
}

test('input captures event-source history before starting a new live observation epoch', async () => {
  const store = createStore();
  const live = fakeLive({
    observationEpoch: 'oep_previous',
    observationEpochReady: false,
    initializeContext: { workingPath: '/tmp/project', providerSessionRef: 'thread-1' },
    providerSessionRef: 'thread-1'
  });
  const sent: Array<{ buffer: string; checkpoint?: string; epoch: string }> = [];
  live.adapter = {
    ...live.adapter,
    events: {
      ...jsonIdentityEvents(),
      readPage: async () => ({
        state: 'available' as const,
        view: 'convenience' as const,
        events: [
          {
            id: 'history:1',
            dedupeKey: 'history-message-1',
            projection: 'normalized' as const,
            role: 'agent' as const,
            text: 'canonical history',
            source: 'plain-text' as const,
            provenance: { rawEvents: [{ uuid: 'history-message-1', text: 'canonical history' }] }
          }
        ]
      })
    },
    sendInput: () =>
      sent.push({
        buffer: rawOutput(live),
        checkpoint: live.providerEventCheckpoint,
        epoch: live.observationEpoch
      })
  };
  store.upsertMeshSession({
    id: SESSION_ID,
    transcriptTargetId: TARGET_ID,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'interactive',
    agentRuntimeId: null,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'running',
    pid: null,
    providerSessionRef: 'thread-1',
    outputSnapshot: 'previous runtime output',
    exitCode: null,
    startedAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    exitedAt: null
  });
  const host = hostWithLive(live, store);

  await host.input(SESSION_ID, { input: 'new turn' });

  expect(sent).toEqual([{ buffer: '', checkpoint: 'history-message-1', epoch: expect.stringMatching(/^oep_/) }]);
  expect(sent[0]?.epoch).not.toBe('oep_previous');
  expect(store.getMeshSession(SESSION_ID)?.outputSnapshot).toBe('');
});

test('live overlay trims replay by event-source dedupe key while retaining identical new text', () => {
  const live = fakeLive({ providerEventIdentities: new Set(['message-old']) });
  live.adapter = { ...live.adapter, events: jsonIdentityEvents(), parseOutput: () => [] };
  const { pipeline } = buildPipeline(live);
  const replay = JSON.stringify({ uuid: 'message-old', text: 'Same answer' });
  const current = JSON.stringify({ uuid: 'message-new', text: 'Same answer' });

  pipeline.output(TARGET_ID, SESSION_ID, replay, 'app-server', live.adapter);
  pipeline.output(TARGET_ID, SESSION_ID, current, 'app-server', live.adapter);

  expect({ output: rawOutput(live), checkpoint: live.providerEventCheckpoint }).toEqual({
    output: `${replay}${current}`,
    checkpoint: 'message-new'
  });
});

test('json-stream replay trimming waits for complete records and removes only dedupe-key matches', () => {
  const live = fakeLive({ providerEventIdentities: new Set(['message-old']) });
  live.adapter = { ...live.adapter, events: jsonIdentityEvents(), parseOutput: () => [] };
  const { pipeline } = buildPipeline(live);
  const replay = JSON.stringify({ uuid: 'message-old', text: 'Same answer' });
  const current = JSON.stringify({ uuid: 'message-new', text: 'Same answer' });

  pipeline.output(TARGET_ID, SESSION_ID, replay.slice(0, 12), 'stdout', live.adapter);
  pipeline.output(TARGET_ID, SESSION_ID, `${replay.slice(12)}\n${current}\n`, 'stdout', live.adapter);

  expect({ output: rawOutput(live), seq: live.outputSeq }).toEqual({
    output: `${replay}\n${current}\n`,
    seq: 2
  });
});

function buildPipeline(live: LiveMeshSession) {
  const store = createStore();
  store.upsertMeshSession({
    id: SESSION_ID,
    transcriptTargetId: TARGET_ID,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'interactive',
    agentRuntimeId: null,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'running',
    pid: null,
    providerSessionRef: 'thread-1',
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    exitedAt: null
  });
  const bus = new EventBus();
  const liveMap = new Map([[SESSION_ID, live]]);
  const pipeline = new MeshAgentOutputPipeline({
    live: liveMap,
    store,
    events: new MeshAgentEventLog({ store, bus }),
    observation: new MeshAgentObservationHub({
      getLive: (id) => liveMap.get(id)
    }),
    stop: () => {},
    getManagedProjectOutputHandler: () => null,
    log: createLogger('test'),
    armIdleSuspend: () => {}
  });
  return { pipeline, bus };
}

function eventRequest(overrides: Partial<MeshAgentEventPageRequest> = {}): MeshAgentEventPageRequest {
  return { view: 'convenience', limit: 2, ...overrides };
}

test('a provider error response rejects the pending event page immediately instead of timing out', () => {
  const live = fakeLive();
  const { pipeline } = buildPipeline(live);
  let rejected: Error | undefined;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
  }, 50);
  live.pendingEventPages.set('7', {
    timeout,
    resolve: () => {
      throw new Error('event page must not resolve on a provider error');
    },
    reject: (error) => {
      rejected = error;
    }
  });

  pipeline.output(
    TARGET_ID,
    SESSION_ID,
    JSON.stringify({ id: 7, error: { code: -32600, message: 'invalid cursor: 0' } }),
    'app-server',
    live.adapter
  );

  expect(rejected).toBeInstanceOf(MeshAgentError);
  expect((rejected as MeshAgentError).code).toBe('provider_protocol_error');
  expect(rejected?.message).toBe('invalid cursor: 0');
  expect(live.pendingEventPages.size).toBe(0);
  clearTimeout(timeout);
  expect(timedOut).toBe(false);
});

test('the output pipeline returns the adapter cursor without interpreting it', () => {
  const live = fakeLive();
  const { pipeline } = buildPipeline(live);
  let resolved: { nextCursor?: string } | undefined;
  const timeout = setTimeout(() => {}, 50);
  live.pendingEventPages.set('7', {
    timeout,
    resolve: (page) => {
      resolved = page;
    },
    reject: (error) => {
      throw error;
    }
  });

  pipeline.output(
    TARGET_ID,
    SESSION_ID,
    JSON.stringify({ id: 7, result: { data: [], nextCursor: '{"turnId":"turn_9"}' } }),
    'app-server',
    live.adapter
  );

  clearTimeout(timeout);
  expect({ nextCursor: resolved?.nextCursor, output: rawOutput(live), seq: live.outputSeq }).toEqual({
    nextCursor: '{"turnId":"turn_9"}',
    output: JSON.stringify({ id: 7, result: { data: [], nextCursor: '{"turnId":"turn_9"}' } }),
    seq: 1
  });
});

function hostWithLive(live: LiveMeshSession, store = createStore()) {
  const host = new MeshAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  (host as unknown as { live: Map<string, LiveMeshSession> }).live.set(SESSION_ID, live);
  return host;
}

test('a provider-namespaced cursor is stripped before it reaches the adapter request', async () => {
  const seen: (string | undefined)[] = [];
  const live = fakeLive({
    providerSessionRef: 'thread-1',
    initializeContext: { workingPath: '/tmp/project', providerSessionRef: 'thread-1' }
  });
  live.adapter.events.readPage = async (_context, request) => {
    seen.push(request.before);
    return { state: 'available', view: 'convenience', events: [] };
  };
  const host = hostWithLive(live);

  await host.projectedEventsPage(SESSION_ID, eventRequest({ before: 'provider:{"turnId":"turn_3"}' }));
  await host.projectedEventsPage(SESSION_ID, eventRequest({ before: 'stale-unprefixed-cursor' }));

  expect(seen).toEqual(['{"turnId":"turn_3"}', undefined]);
});

test('a live cursor pages committed raw frames without a provider round-trip', async () => {
  const live = fakeLive();
  for (const payload of ['line-one\n', 'line-two\n', 'line-three\n', 'line-four\n']) {
    live.liveRawStore?.append({ stream: 'stdout', payload, observedAt: '2026-07-18T01:00:00.000Z' });
  }
  live.adapter.events.readPage = async () => {
    throw new Error('a snapshot cursor must not reach the provider');
  };
  const host = hostWithLive(live);

  const page = await host.projectedEventsPage(SESSION_ID, eventRequest({ before: 'live:oep_test:3' }));

  expect(page).toEqual({
    events: [
      {
        id: `${SESSION_ID}:0`,
        dedupeKey: 'plain:line-one\nline-two\n',
        projection: 'normalized',
        role: 'agent',
        text: 'line-one\nline-two\n',
        source: 'plain-text',
        provenance: { rawEvents: ['line-one\nline-two\n'] }
      }
    ]
  });
});

test('an expired live cursor restarts from provider history instead of failing the request', async () => {
  const seen: (string | undefined)[] = [];
  const providerEvent = {
    id: 'provider:newest',
    dedupeKey: 'provider:newest',
    projection: 'normalized' as const,
    role: 'agent' as const,
    text: 'provider history',
    source: 'codex-app-server' as const,
    provenance: { rawEvents: [{ method: 'item/agentMessage', params: { text: 'provider history' } }] }
  };
  const live = fakeLive({
    providerSessionRef: 'thread-1',
    initializeContext: { workingPath: '/tmp/project', providerSessionRef: 'thread-1' }
  });
  if (!live.liveRawStore) throw new Error('live raw store missing');
  live.liveRawStore.parseCursor = () => {
    throw new LiveRawCursorExpiredError();
  };
  live.adapter.events.readPage = async (_context, request) => {
    seen.push(request.before);
    return { state: 'available', view: 'convenience', events: [providerEvent], nextCursor: 'offset-2' };
  };
  const host = hostWithLive(live);

  const page = await host.projectedEventsPage(SESSION_ID, eventRequest({ before: 'live:oep_retired:12' }));

  expect({ seen, page }).toEqual({
    seen: [undefined],
    page: { events: [providerEvent], nextCursor: 'provider:offset-2' }
  });
});

test('a stored-session provider cursor is decoded once and passed to the adapter event reader', async () => {
  const codexBuiltin = builtinAgentAdapters.find((adapter) => adapter.provider === 'codex');
  if (!codexBuiltin) throw new Error('codex builtin adapter missing');
  const seen: (string | undefined)[] = [];
  registerAgentAdapterImpl({
    ...codexBuiltin,
    events: {
      ...codexBuiltin.events,
      readPage: async (_context, request) => {
        seen.push(request.before);
        return { state: 'available', view: 'convenience', events: [], nextCursor: 'offset-4' };
      }
    }
  });
  try {
    const store = createStore();
    const host = new MeshAgentHost({ store, bus: new EventBus(), agents: async () => [] });
    store.upsertMeshSession({
      id: SESSION_ID,
      transcriptTargetId: TARGET_ID,
      agentName: 'codex',
      provider: 'codex',
      workingPath: '/tmp/project',
      launchMode: 'pty',
      runtimeRole: 'interactive',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'stopped',
      pid: null,
      providerSessionRef: 'thread-1',
      outputSnapshot: 'stored-line\n',
      exitCode: 0,
      startedAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      exitedAt: '2026-07-06T00:01:00.000Z'
    });

    const page = await host.projectedEventsPage(SESSION_ID, eventRequest({ before: 'provider:offset-2' }));

    expect({ page, seen }).toEqual({
      page: { events: [], nextCursor: 'provider:offset-4' },
      seen: ['offset-2']
    });
  } finally {
    registerAgentAdapterImpl(codexBuiltin);
  }
});

test('a local Codex event offset stays in the provider cursor domain across pages', async () => {
  const codexBuiltin = builtinAgentAdapters.find((adapter) => adapter.provider === 'codex');
  if (!codexBuiltin) throw new Error('codex builtin adapter missing');
  const localBefore: (string | undefined)[] = [];
  let providerBridgeCalls = 0;
  registerAgentAdapterImpl({
    ...codexBuiltin,
    events: {
      ...codexBuiltin.events,
      readPage: async (context, request) => {
        if (context.requestProviderPage) providerBridgeCalls += 1;
        else localBefore.push(request.before);
        return {
          state: 'available',
          view: 'convenience',
          events: [],
          ...(request.before ? {} : { nextCursor: '100' })
        };
      }
    }
  });
  try {
    const store = createStore();
    const host = new MeshAgentHost({ store, bus: new EventBus(), agents: async () => [] });
    store.upsertMeshSession({
      id: SESSION_ID,
      transcriptTargetId: TARGET_ID,
      agentName: 'codex',
      provider: 'codex',
      workingPath: '/tmp/project',
      launchMode: 'pty',
      runtimeRole: 'interactive',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'stopped',
      pid: null,
      providerSessionRef: 'thread-1',
      outputSnapshot: '',
      exitCode: 0,
      startedAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      exitedAt: '2026-07-06T00:01:00.000Z'
    });

    const first = await host.projectedEventsPage(SESSION_ID, eventRequest({ limit: 100 }));
    expect(first).toEqual({ events: [], nextCursor: 'provider:100' });

    const second = await host.projectedEventsPage(SESSION_ID, eventRequest({ before: first.nextCursor, limit: 100 }));
    expect({ localBefore, providerBridgeCalls, second }).toEqual({
      localBefore: [undefined, '100'],
      providerBridgeCalls: 0,
      second: { events: [] }
    });
  } finally {
    registerAgentAdapterImpl(codexBuiltin);
  }
});

test('a retired journal cursor restarts events in the available adapter cursor domain', async () => {
  const codexBuiltin = builtinAgentAdapters.find((adapter) => adapter.provider === 'codex');
  if (!codexBuiltin) throw new Error('codex builtin adapter missing');
  const seen: (string | undefined)[] = [];
  const providerEvent = {
    id: 'provider:newest',
    dedupeKey: 'provider:newest',
    projection: 'normalized' as const,
    role: 'agent' as const,
    text: 'provider history',
    source: 'codex-app-server' as const,
    provenance: { rawEvents: [{ method: 'item/agentMessage', params: { text: 'provider history' } }] }
  };
  registerAgentAdapterImpl({
    ...codexBuiltin,
    events: {
      ...codexBuiltin.events,
      readPage: async (_context, request) => {
        seen.push(request.before);
        return { state: 'available', view: 'convenience', events: [providerEvent], nextCursor: 'offset-2' };
      }
    }
  });
  try {
    const store = createStore();
    const host = new MeshAgentHost({ store, bus: new EventBus(), agents: async () => [] });
    store.upsertMeshSession({
      id: SESSION_ID,
      transcriptTargetId: TARGET_ID,
      agentName: 'codex',
      provider: 'codex',
      workingPath: '/tmp/project',
      launchMode: 'pty',
      runtimeRole: 'interactive',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'stopped',
      pid: null,
      providerSessionRef: 'thread-1',
      outputSnapshot: 'stored-line\n',
      exitCode: 0,
      startedAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      exitedAt: '2026-07-06T00:01:00.000Z'
    });
    const page = await host.projectedEventsPage(SESSION_ID, eventRequest({ before: 'journal:' }));

    expect({ seen, page }).toEqual({
      seen: [undefined],
      page: { events: [providerEvent], nextCursor: 'provider:offset-2' }
    });
  } finally {
    registerAgentAdapterImpl(codexBuiltin);
  }
});
