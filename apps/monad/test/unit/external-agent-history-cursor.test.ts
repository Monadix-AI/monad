import type { ExternalAgentHistoryPageRequest } from '@monad/protocol';
import type { LiveExternalAgentSession } from '#/services/external-agent/host/host-types.ts';
import type { ExternalAgentOutputEvent, ExternalAgentProviderAdapter } from '#/services/external-agent/types.ts';

import { expect, test } from 'bun:test';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { createLogger } from '@monad/logger';

import { EventBus } from '#/services/event-bus.ts';
import { BoundedOutputBuffer } from '#/services/external-agent/bounded-output-buffer.ts';
import { ExternalAgentError } from '#/services/external-agent/errors.ts';
import { ExternalAgentEventLog } from '#/services/external-agent/host/event-log.ts';
import { ExternalAgentHost } from '#/services/external-agent/host/index.ts';
import { ExternalAgentObservationHub } from '#/services/external-agent/host/observation-hub.ts';
import { ExternalAgentOutputPipeline } from '#/services/external-agent/host/output-pipeline.ts';
import { registerAgentAdapterImpl } from '#/services/external-agent/index.ts';
import { createStore } from '#/store/db/index.ts';

for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

const SESSION_ID = 'exa_cursorTest00';
const TARGET_ID = 'ses_cursorTest00';

function jsonRpcParseOutput(chunk: string): ExternalAgentOutputEvent[] {
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
      type: 'history_page',
      payload: {
        responseId: record.id,
        items: record.result?.data ?? [],
        nextCursor: record.result?.nextCursor ?? null,
        backwardsCursor: null
      }
    }
  ];
}

function fakeLive(overrides: Partial<LiveExternalAgentSession> = {}): LiveExternalAgentSession {
  let requestSeq = 7;
  const adapter = {
    provider: 'codex',
    parseOutput: jsonRpcParseOutput,
    resolveApproval: () => {},
    sendInput: () => {},
    resize: () => {},
    stop: () => {}
  } as unknown as ExternalAgentProviderAdapter;
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
    pendingHistoryPages: new Map(),
    pendingRequests: new Map(),
    nextRequestId: () => requestSeq++,
    outputBuffer: new BoundedOutputBuffer(64 * 1024),
    observationEpoch: 'oep_previous',
    outputSeq: 0,
    snapshotFlushTimer: null,
    kill: () => {},
    ...overrides
  } as LiveExternalAgentSession;
}

test('input captures provider history checkpoint before starting the live observation epoch', async () => {
  const live = fakeLive({
    initializeContext: { workingPath: '/tmp/project', providerSessionRef: 'thread-1' },
    providerSessionRef: 'thread-1'
  });
  const originalEpoch = live.observationEpoch;
  const sent: Array<{ buffer: string; checkpoint?: string; epoch: string }> = [];
  live.outputBuffer.append('previous runtime output');
  live.adapter = {
    ...live.adapter,
    observation: {
      checkpoint: (event: { raw?: unknown }) =>
        event.raw && typeof event.raw === 'object' && !Array.isArray(event.raw)
          ? String((event.raw as { uuid?: unknown }).uuid ?? '') || undefined
          : undefined,
      identity: (event: { raw?: unknown }) =>
        event.raw && typeof event.raw === 'object' && !Array.isArray(event.raw)
          ? String((event.raw as { uuid?: unknown }).uuid ?? '') || undefined
          : undefined,
      recordProjectors: [
        {
          parse: ({ id, record }: { id: string; record: Record<string, unknown> }) => [
            {
              id: `${id}:history`,
              role: 'agent' as const,
              text: 'canonical history',
              source: 'claude-code-sdk' as const,
              raw: record
            }
          ]
        }
      ]
    },
    historyOutput: async () => JSON.stringify({ type: 'assistant', uuid: 'history-message-1' }),
    sendInput: () => {
      sent.push({
        buffer: live.outputBuffer.snapshot(),
        checkpoint: Reflect.get(live, 'providerHistoryCheckpoint'),
        epoch: live.observationEpoch
      });
    }
  } as ExternalAgentProviderAdapter;
  const store = createStore();
  store.upsertExternalAgentSession({
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

  expect({ originalEpoch, sent }).toEqual({
    originalEpoch: 'oep_previous',
    sent: [{ buffer: '', checkpoint: 'history-message-1', epoch: expect.stringMatching(/^oep_/) }]
  });
  expect(sent[0]?.epoch).not.toBe(originalEpoch);
  expect(store.getExternalAgentSession(SESSION_ID)?.outputSnapshot).toBe('');
});

test('live overlay trims provider replay by identity while preserving identical new messages', () => {
  const live = fakeLive();
  Reflect.set(live, 'providerHistoryIdentities', new Set(['message-old']));
  live.adapter = {
    ...live.adapter,
    parseOutput: () => [],
    observation: {
      identity: (event: { raw?: unknown }) =>
        event.raw && typeof event.raw === 'object' && !Array.isArray(event.raw)
          ? String((event.raw as { uuid?: unknown }).uuid ?? '') || undefined
          : undefined,
      recordProjectors: [
        {
          parse: ({ id, record }: { id: string; record: Record<string, unknown> }) => [
            {
              id: `${id}:${String(record.uuid)}`,
              role: 'agent' as const,
              text: String(record.text),
              source: 'claude-code-sdk' as const,
              raw: record
            }
          ]
        }
      ]
    }
  } as ExternalAgentProviderAdapter;
  const { pipeline } = buildPipeline(live);
  const replay = JSON.stringify({ method: 'message', uuid: 'message-old', text: 'Same answer' });
  const current = JSON.stringify({ method: 'message', uuid: 'message-new', text: 'Same answer' });

  pipeline.output(TARGET_ID, SESSION_ID, replay, 'app-server', live.adapter);
  pipeline.output(TARGET_ID, SESSION_ID, current, 'app-server', live.adapter);

  expect({ output: live.outputBuffer.snapshot(), seq: live.outputSeq }).toEqual({
    output: `${current}\n`,
    seq: current.length + 1
  });
});

test('json-stream replay trimming waits for complete records and removes only canonical identities', () => {
  const live = fakeLive();
  live.providerHistoryIdentities = new Set(['message-old']);
  live.adapter = {
    ...live.adapter,
    parseOutput: () => [],
    observation: {
      identity: (event: { raw?: unknown }) =>
        event.raw && typeof event.raw === 'object' && !Array.isArray(event.raw)
          ? String((event.raw as { uuid?: unknown }).uuid ?? '') || undefined
          : undefined,
      recordProjectors: [
        {
          parse: ({ id, record }: { id: string; record: Record<string, unknown> }) => [
            {
              id: `${id}:${String(record.uuid)}`,
              role: 'agent' as const,
              text: String(record.text),
              source: 'claude-code-sdk' as const,
              raw: record
            }
          ]
        }
      ]
    }
  } as ExternalAgentProviderAdapter;
  const { pipeline } = buildPipeline(live);
  const replay = JSON.stringify({ type: 'assistant', uuid: 'message-old', text: 'Same answer' });
  const current = JSON.stringify({ type: 'assistant', uuid: 'message-new', text: 'Same answer' });

  pipeline.output(TARGET_ID, SESSION_ID, replay.slice(0, 12), 'stdout', live.adapter);
  pipeline.output(TARGET_ID, SESSION_ID, `${replay.slice(12)}\n${current}\n`, 'stdout', live.adapter);

  expect({ output: live.outputBuffer.snapshot(), seq: live.outputSeq }).toEqual({
    output: `${current}\n`,
    seq: current.length + 1
  });
});

test('a committed provider turn advances the canonical checkpoint before publishing live output', () => {
  const live = fakeLive({ providerHistoryCheckpoint: 'turn-old' });
  live.adapter = {
    ...live.adapter,
    parseOutput: () => [],
    observation: {
      identity: (event: { raw?: unknown }) => {
        const raw = event.raw as { params?: { turnId?: string } } | undefined;
        return raw?.params?.turnId;
      },
      checkpoint: (event: { raw?: unknown }) => {
        const raw = event.raw as { method?: string; params?: { turnId?: string } } | undefined;
        return raw?.method === 'turn/completed' ? raw.params?.turnId : undefined;
      },
      recordProjectors: [
        {
          parse: ({ id, record }: { id: string; record: Record<string, unknown> }) => [
            {
              id: `${id}:turn`,
              role: 'system' as const,
              text: 'Completed',
              source: 'codex-app-server' as const,
              raw: record
            }
          ]
        }
      ]
    }
  } as ExternalAgentProviderAdapter;
  const { pipeline } = buildPipeline(live);
  const completed = JSON.stringify({ method: 'turn/completed', params: { turnId: 'turn-new' } });

  pipeline.output(TARGET_ID, SESSION_ID, completed, 'app-server', live.adapter);

  expect({
    checkpoint: live.providerHistoryCheckpoint,
    identities: [...(live.providerHistoryIdentities ?? [])]
  }).toEqual({
    checkpoint: 'turn-new',
    identities: ['turn-new']
  });
});

function buildPipeline(live: LiveExternalAgentSession) {
  const store = createStore();
  const bus = new EventBus();
  const liveMap = new Map([[SESSION_ID, live]]);
  const pipeline = new ExternalAgentOutputPipeline({
    live: liveMap,
    store,
    events: new ExternalAgentEventLog({ store, bus }),
    observation: new ExternalAgentObservationHub({
      getLive: (id) => liveMap.get(id),
      observe: () => ({
        state: 'unavailable' as const,
        externalAgentSessionId: SESSION_ID as `exa_${string}`,
        reason: 'not observed in this test'
      })
    }),
    stop: () => {},
    getManagedProjectOutputHandler: () => null,
    log: createLogger('test'),
    armIdleSuspend: () => {},
    historyPageOutput: () => undefined
  });
  return { pipeline, bus };
}

function historyRequest(overrides: Partial<ExternalAgentHistoryPageRequest> = {}): ExternalAgentHistoryPageRequest {
  return { limit: 2, sortDirection: 'desc', itemsView: 'full', ...overrides };
}

test('a provider error response rejects the pending history page immediately instead of timing out', () => {
  const live = fakeLive();
  const { pipeline } = buildPipeline(live);
  let rejected: Error | undefined;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
  }, 50);
  live.pendingHistoryPages.set('7', {
    timeout,
    request: historyRequest(),
    resolve: () => {
      throw new Error('history page must not resolve on a provider error');
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

  expect(rejected).toBeInstanceOf(ExternalAgentError);
  expect((rejected as ExternalAgentError).code).toBe('provider_protocol_error');
  expect(rejected?.message).toBe('invalid cursor: 0');
  expect(live.pendingHistoryPages.size).toBe(0);
  clearTimeout(timeout);
  expect(timedOut).toBe(false);
});

test('a live history page control response bypasses the observation buffer', () => {
  const live = fakeLive();
  const { pipeline } = buildPipeline(live);
  let resolved: { nextCursor?: string } | undefined;
  const timeout = setTimeout(() => {}, 50);
  live.pendingHistoryPages.set('7', {
    timeout,
    request: historyRequest(),
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
    JSON.stringify({ id: 7, result: { data: ['x'.repeat(48 * 1024)], nextCursor: '{"turnId":"turn_9"}' } }),
    'app-server',
    live.adapter
  );

  clearTimeout(timeout);
  expect({ buffer: live.outputBuffer.snapshot(), nextCursor: resolved?.nextCursor, outputSeq: live.outputSeq }).toEqual(
    {
      buffer: '',
      nextCursor: 'provider:{"turnId":"turn_9"}',
      outputSeq: 0
    }
  );
});

function hostWithLive(live: LiveExternalAgentSession, store = createStore()) {
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  (host as unknown as { live: Map<string, LiveExternalAgentSession> }).live.set(SESSION_ID, live);
  return host;
}

test('a provider-namespaced cursor is stripped before it reaches the adapter request', async () => {
  const seen: (string | undefined)[] = [];
  const live = fakeLive();
  live.adapter.requestHistoryPage = (handle, request) => {
    seen.push(request.before);
    const responseId = handle.nextRequestId?.() ?? 0;
    queueMicrotask(() => {
      const pending = live.pendingHistoryPages.get(String(responseId));
      pending?.resolve({ events: [] });
    });
    return responseId;
  };
  const host = hostWithLive(live);

  await host.historyPage(SESSION_ID, historyRequest({ before: 'provider:{"turnId":"turn_3"}' }));
  await host.historyPage(SESSION_ID, historyRequest({ before: 'stale-unprefixed-cursor' }));

  expect(seen).toEqual(['{"turnId":"turn_3"}', undefined]);
});

test('a stored snapshot cursor pages the output snapshot of a live session without a provider round-trip', async () => {
  const live = fakeLive();
  live.outputBuffer.append('line-one\n\nline-two\n\nline-three\n\nline-four\n');
  live.adapter.requestHistoryPage = () => {
    throw new Error('a snapshot cursor must not reach the provider');
  };
  const host = hostWithLive(live);

  const page = await host.historyPage(SESSION_ID, historyRequest({ before: 'snapshot:2' }));

  expect(page).toEqual({
    events: [
      {
        id: `${SESSION_ID}:history:0:0`,
        role: 'agent',
        text: 'line-one\nline-two',
        source: 'plain-text'
      }
    ]
  });
});

test('a stored-session provider cursor is stripped before the local adapter history reader', async () => {
  const codexBuiltin = builtinAgentAdapters.find((adapter) => adapter.provider === 'codex');
  if (!codexBuiltin) throw new Error('codex builtin adapter missing');
  const seen: (string | undefined)[] = [];
  registerAgentAdapterImpl({
    ...codexBuiltin,
    historyPage: async (context) => {
      seen.push(context.request.before);
      return { items: ['stored item'], nextCursor: 'offset-4' };
    }
  });
  try {
    const store = createStore();
    const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
    store.upsertExternalAgentSession({
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
      state: 'stopped',
      pid: null,
      providerSessionRef: 'thread-1',
      outputSnapshot: 'stored-line\n',
      exitCode: 0,
      startedAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      exitedAt: '2026-07-06T00:01:00.000Z'
    });

    const page = await host.historyPage(SESSION_ID, historyRequest({ before: 'provider:offset-2' }));

    expect(seen).toEqual(['offset-2']);
    expect(page.nextCursor).toBe('provider:offset-4');
  } finally {
    registerAgentAdapterImpl(codexBuiltin);
  }
});
