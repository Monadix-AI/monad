import type { ExternalAgentSessionState, ExternalAgentView } from '@monad/protocol';
import type { ExternalAgentProviderAdapter } from '@/services/external-agent/types.ts';

import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { EventBus } from '@/services/event-bus.ts';
import { BoundedOutputBuffer } from '@/services/external-agent/bounded-output-buffer.ts';
import { AUTH_STATUS_TIMEOUT_MS } from '@/services/external-agent/constants.ts';
import { ExternalAgentHost } from '@/services/external-agent/host/index.ts';
import { resolveExternalAgentManagedServerUrl } from '@/services/external-agent/host/session-launcher.ts';
import { registerAgentAdapterImpl, unregisterAgentAdapterImpl } from '@/services/external-agent/index.ts';
import { createStore } from '@/store/db/index.ts';

// Adapters are agent-adapter atoms registered at daemon boot; tests drive the host directly, so they
// register the built-ins up front (mirrors the daemon's registration path).
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

test('external agent auth status probes use a global 20 second timeout', () => {
  expect(AUTH_STATUS_TIMEOUT_MS).toBe(20_000);
});

test('managed external agent default server URL follows the daemon HTTPS switch', () => {
  expect(resolveExternalAgentManagedServerUrl({ networkHttps: { enabled: true }, port: 53210 })).toBe(
    'https://127.0.0.1:53210'
  );
  expect(resolveExternalAgentManagedServerUrl({ networkHttps: { enabled: false }, port: 53210 })).toBe(
    'http://127.0.0.1:53210'
  );
  expect(
    resolveExternalAgentManagedServerUrl({
      serverUrl: 'http://127.0.0.1:59999',
      networkHttps: { enabled: true },
      port: 53210
    })
  ).toBe('http://127.0.0.1:59999');
});

test('external agent host can stop every live session during daemon shutdown', () => {
  const store = createStore();
  const host = new ExternalAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => []
  });
  const killed: string[] = [];
  const adapter = {
    stop(handle: { id: string; kill(signal?: NodeJS.Signals): void }) {
      handle.kill('SIGTERM');
    }
  };

  for (const id of ['exa_shutdown_one', 'exa_shutdown_two']) {
    store.upsertExternalAgentSession({
      id,
      transcriptTargetId: 'ses_shutdown',
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
      pid: id === 'exa_shutdown_one' ? 111 : 222,
      providerSessionRef: null,
      outputSnapshot: '',
      exitCode: null,
      startedAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      exitedAt: null
    });
    (
      host as unknown as {
        live: Map<string, unknown>;
      }
    ).live.set(id, {
      id,
      transcriptTargetId: 'ses_shutdown',
      agentName: 'codex',
      provider: 'codex',
      runtimeRole: 'interactive',
      proxyApprovals: false,
      adapter,
      launchMode: 'app-server',
      pendingApprovals: new Map(),
      pendingHistoryPages: new Map(),
      pendingRequests: new Map(),
      nextRequestId: () => 0,
      outputBuffer: new BoundedOutputBuffer(1024),
      outputSeq: 0,
      snapshotFlushTimer: null,
      kill: (signal?: NodeJS.Signals) => killed.push(`${id}:${signal ?? 'SIGTERM'}`)
    });
  }

  (host as unknown as { stopAll(): void }).stopAll();

  expect(killed).toEqual(['exa_shutdown_one:SIGTERM', 'exa_shutdown_two:SIGTERM']);
  expect(store.getExternalAgentSession('exa_shutdown_one')?.state).toBe('stopped');
  expect(store.getExternalAgentSession('exa_shutdown_two')?.state).toBe('stopped');
});

test('external agent host stops live sessions for a disconnected provider adapter', () => {
  const store = createStore();
  const bus = new EventBus();
  const projectId = 'prj_01KWHOSTPROVIDER000000000';
  const externalAgentSessionId = 'exa_provider_stop_test';
  const runtimeAgentName = 'pmem_codex_abc123';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Provider stop',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: runtimeAgentName,
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: externalAgentSessionId,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'running',
    pid: 123,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    exitedAt: null
  });
  const host = new ExternalAgentHost({ store, bus, agents: async () => [] });
  const adapter = {
    provider: 'codex',
    productIcon: 'openai',
    parseOutput: () => [],
    stop: () => {}
  } as unknown as ExternalAgentProviderAdapter;
  (
    host as unknown as {
      live: Map<string, unknown>;
    }
  ).live.set(externalAgentSessionId, {
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: runtimeAgentName,
    provider: 'codex',
    runtimeRole: 'managed-project-agent',
    proxyApprovals: false,
    proc: { pid: 123 },
    adapter,
    launchMode: 'app-server',
    providerSessionRef: null,
    pendingApprovals: new Map(),
    pendingHistoryPages: new Map(),
    pendingRequests: new Map(),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    kill: () => {}
  });

  host.stopAgentProvider('codex');

  expect(store.getExternalAgentSession(externalAgentSessionId)?.state).toBe('stopped');
});

test('managed provider final can retire a consumed inbox turn without auto-posting', async () => {
  const store = createStore();
  const host = new ExternalAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => []
  });
  store.insertWorkplaceProject({
    id: 'prj_01KWHOSTTEST0000000000000',
    title: 'Host test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id: 'exa_host_test',
    transcriptTargetId: 'prj_01KWHOSTTEST0000000000000',
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'exa_host_test',
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 1,
    lastVisibleSeq: 1,
    state: 'running',
    pid: 123,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    exitedAt: null
  });
  store.insertMessage('msg_USER', 'prj_01KWHOSTTEST0000000000000', 'hi', '2026-07-02T00:00:01.000Z', 'user');
  store.insertMessage('msg_THINKING', 'prj_01KWHOSTTEST0000000000000', '', '2026-07-02T00:00:02.000Z', 'assistant', {
    data: {
      agentName: 'codex',
      externalAgentSessionId: 'exa_host_test',
      reasoning: 'Thinking',
      source: 'managed-external-agent'
    },
    includeInContext: false,
    streamStatus: 'streaming'
  });
  store.enqueueExternalAgentInboxItem('exa_host_test', 1);
  store.markExternalAgentInboxDelivered('exa_host_test', 1);
  store.markExternalAgentInboxConsumed('exa_host_test', 1);

  const calls: unknown[] = [];
  host.setManagedProjectOutputHandler(async (payload) => {
    calls.push(payload);
  });
  (
    host as unknown as {
      outputPipeline: {
        emitManagedProjectOutput(
          transcriptTargetId: string,
          id: string,
          text: string,
          error?: boolean,
          post?: boolean
        ): void;
      };
    }
  ).outputPipeline.emitManagedProjectOutput(
    'prj_01KWHOSTTEST0000000000000',
    'exa_host_test',
    'No action needed.',
    false,
    false
  );
  await Bun.sleep(0);

  expect(calls).toEqual([
    {
      sessionId: 'prj_01KWHOSTTEST0000000000000',
      externalAgentSessionId: 'exa_host_test',
      agentName: 'codex',
      text: 'No action needed.',
      error: false,
      post: false
    }
  ]);
});

test('managed external agent output persists a bounded snapshot for refresh and observation history', async () => {
  const store = createStore();
  const host = new ExternalAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => []
  });
  const projectId = 'prj_01KWHOSTTEST0000000000001';
  const externalAgentSessionId = 'exa_host_snapshot_test';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host snapshot test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: externalAgentSessionId,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'running',
    pid: 123,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    exitedAt: null
  });
  const adapter = {
    provider: 'codex',
    productIcon: 'openai',
    parseOutput: () => []
  } as unknown as ExternalAgentProviderAdapter;
  const live = {
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    runtimeRole: 'managed-project-agent',
    proc: { pid: 123 },
    adapter,
    launchMode: 'app-server',
    providerSessionRef: null,
    pendingApprovals: new Map(),
    pendingHistoryPages: new Map(),
    pendingRequests: new Map(),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    kill: () => {}
  };

  (
    host as unknown as {
      live: Map<string, unknown>;
      outputPipeline: {
        output(
          transcriptTargetId: string,
          id: string,
          chunk: string,
          stream: 'stdout' | 'stderr' | 'pty',
          adapter: ExternalAgentProviderAdapter
        ): void;
      };
    }
  ).live.set(externalAgentSessionId, live);
  (
    host as unknown as {
      outputPipeline: {
        output(
          transcriptTargetId: string,
          id: string,
          chunk: string,
          stream: 'stdout' | 'stderr' | 'pty',
          adapter: ExternalAgentProviderAdapter
        ): void;
      };
    }
  ).outputPipeline.output(
    projectId,
    externalAgentSessionId,
    '{"type":"result","result":"secret"}\n',
    'stdout',
    adapter
  );
  await Bun.sleep(250);

  expect(host.observe(externalAgentSessionId)).toMatchObject({
    state: 'live',
    externalAgentSessionId,
    provider: 'codex'
  });
  expect(store.getExternalAgentSession(externalAgentSessionId)?.outputSnapshot).toContain('"type":"result"');
  (
    host as unknown as {
      live: Map<string, unknown>;
    }
  ).live.delete(externalAgentSessionId);
  expect(host.observe(externalAgentSessionId)).toMatchObject({
    state: 'history',
    externalAgentSessionId,
    provider: 'codex',
    output: expect.stringContaining('"type":"result"')
  });
});

test('external agent observation stream pushes incremental deltas the client can reconstruct', async () => {
  const store = createStore();
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  const projectId = 'prj_01KWHOSTTEST0000000000009';
  const externalAgentSessionId = 'exa_host_delta_test';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Delta',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
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
    pid: 123,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    exitedAt: null
  });
  const adapter = {
    provider: 'codex',
    productIcon: 'openai',
    parseOutput: () => []
  } as unknown as ExternalAgentProviderAdapter;
  const live = {
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    runtimeRole: 'interactive',
    proc: { pid: 123 },
    adapter,
    launchMode: 'app-server',
    providerSessionRef: null,
    pendingApprovals: new Map(),
    pendingHistoryPages: new Map(),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    kill: () => {}
  };
  const internal = host as unknown as {
    live: Map<string, unknown>;
    outputPipeline: {
      output(t: string, id: string, chunk: string, stream: string, adapter: ExternalAgentProviderAdapter): void;
    };
  };
  internal.live.set(externalAgentSessionId, live);

  const frames: { output?: string; append?: string; seq?: number }[] = [];
  const sub = host.subscribeObservation(externalAgentSessionId, (access) => {
    if (access.state === 'live') frames.push({ output: access.output, append: access.append, seq: access.seq });
  });
  // The initial access is a full snapshot (empty output so far).
  expect(sub.access.state).toBe('live');

  internal.outputPipeline.output(projectId, externalAgentSessionId, 'Hello, ', 'stdout', adapter);
  await Bun.sleep(250);
  internal.outputPipeline.output(projectId, externalAgentSessionId, 'world!', 'stdout', adapter);
  await Bun.sleep(250);

  // Streamed frames are deltas (append, not full output).
  expect(frames.length).toBeGreaterThanOrEqual(2);
  expect(frames.every((f) => f.append !== undefined && f.output === undefined)).toBe(true);

  // A client reconstructs by applying each append past its cursor onto the initial snapshot.
  let text = sub.access.state === 'live' ? (sub.access.output ?? '') : '';
  let cursor = sub.access.state === 'live' ? (sub.access.seq ?? 0) : 0;
  for (const f of frames) {
    const seq = f.seq ?? 0;
    const append = f.append ?? '';
    if (seq <= cursor) continue;
    text += append.slice(Math.max(0, append.length - (seq - cursor)));
    cursor = seq;
  }
  expect(text).toBe('Hello, world!');
  sub.dispose();
});

test('external agent observation resume returns only the delta past the client cursor', async () => {
  const host = new ExternalAgentHost({ store: createStore(), bus: new EventBus(), agents: async () => [] });
  const id = 'exa_resume_seq_test';
  const adapter = {
    provider: 'codex',
    productIcon: 'openai',
    parseOutput: () => []
  } as unknown as ExternalAgentProviderAdapter;
  const live = {
    id,
    transcriptTargetId: 'prj_01KWHOSTTEST000000000000S',
    agentName: 'codex',
    provider: 'codex',
    runtimeRole: 'managed-project-agent',
    proc: { pid: 123 },
    adapter,
    launchMode: 'app-server',
    providerSessionRef: null,
    pendingApprovals: new Map(),
    pendingHistoryPages: new Map(),
    pendingRequests: new Map(),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    kill: () => {}
  };
  const internal = host as unknown as {
    live: Map<string, unknown>;
    outputPipeline: {
      output(t: string, id: string, chunk: string, stream: string, adapter: ExternalAgentProviderAdapter): void;
    };
  };
  internal.live.set(id, live);
  internal.outputPipeline.output(live.transcriptTargetId, id, 'Hello, ', 'stdout', adapter);
  internal.outputPipeline.output(live.transcriptTargetId, id, 'world!', 'stdout', adapter);

  // No cursor → full snapshot.
  expect(host.observe(id)).toMatchObject({ state: 'live', output: 'Hello, world!', seq: 13 });
  // Cursor mid-stream → only the delta beyond it, no full output.
  const resume = host.observe(id, 7);
  expect(resume).toMatchObject({ state: 'live', append: 'world!', seq: 13 });
  // Cursor at head → nothing new, full snapshot.
  expect(host.observe(id, 13)).toMatchObject({ state: 'live', output: 'Hello, world!', seq: 13 });
});

test('external agent app-server reconnect re-dials the socket and resumes the thread', async () => {
  const host = new ExternalAgentHost({ store: createStore(), bus: new EventBus(), agents: async () => [] });
  const externalAgentSessionId = 'exa_reconnect_test';
  const initCalls: { providerSessionRef?: string }[] = [];
  const adapter = {
    provider: 'codex',
    productIcon: 'openai',
    parseOutput: () => [],
    initialize: (_h: unknown, ctx: { providerSessionRef?: string }) =>
      initCalls.push({ providerSessionRef: ctx.providerSessionRef })
  } as unknown as ExternalAgentProviderAdapter;
  const freshConnection = { send: () => {}, close: () => {} };
  let redials = 0;
  const live = {
    id: externalAgentSessionId,
    transcriptTargetId: 'prj_01KWHOSTTEST000000000000R',
    agentName: 'codex',
    provider: 'codex',
    runtimeRole: 'interactive',
    proc: { pid: 123 },
    adapter,
    launchMode: 'app-server',
    providerSessionRef: 'codex-thread-resume',
    appServer: { send: () => {}, close: () => {} },
    appServerRedial: async () => {
      redials++;
      return freshConnection;
    },
    initializeContext: { workingPath: '/tmp/project' },
    pendingApprovals: new Map(),
    pendingHistoryPages: new Map(),
    pendingRequests: new Map([[1, 'turn']]),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    kill: () => {}
  };
  const internal = host as unknown as {
    live: Map<string, unknown>;
    appServerConnections: { reconnect(id: string): Promise<void> };
  };
  internal.live.set(externalAgentSessionId, live);

  await internal.appServerConnections.reconnect(externalAgentSessionId);

  expect(redials).toBe(1);
  expect(live.appServer).toBe(freshConnection); // swapped to the fresh connection
  expect(live.pendingRequests.size).toBe(0); // stale request ids from the dropped socket cleared
  expect(initCalls).toEqual([{ providerSessionRef: 'codex-thread-resume' }]); // re-init resumes the thread
});

test('external agent app-server gives up instead of reconnecting forever when the transport keeps reopening but the handshake keeps failing', async () => {
  // `reconnectAppServer` declares success (and resets its own bounded attempt counter) the moment the
  // socket TRANSPORT reopens, before any app-level handshake completes — so a gateway that keeps
  // reopening the socket and then failing the handshake (e.g. a `retryable:true` connect rejection an
  // adapter swallows, expecting the resulting close to trigger redial) would restart that counter every
  // cycle and never hit a per-invocation exhaustion path. This drives that exact scenario past any
  // reasonable churn budget and asserts the session eventually gives up instead of looping silently.
  const transcriptTargetId = 'prj_01KWHOSTTEST0000000000CH';
  const bus = new EventBus();
  const events: string[] = [];
  bus.subscribe(transcriptTargetId, (e) => events.push(e.type));
  const host = new ExternalAgentHost({ store: createStore(), bus, agents: async () => [] });
  const externalAgentSessionId = 'exa_reconnect_churn_test';
  const adapter = {
    provider: 'openclaw',
    productIcon: 'openclaw',
    parseOutput: () => [],
    initialize: () => {},
    stop: () => {}
  } as unknown as ExternalAgentProviderAdapter;

  let redials = 0;
  // Comfortably past any reasonable churn cap — if the host's own cap doesn't fire, this backstop keeps
  // the test from looping forever, and the assertions below fail loudly instead.
  const MAX_DRIVER_ITERATIONS = 30;
  const internal = host as unknown as {
    live: Map<string, unknown>;
    appServerConnections: { handleDisconnect(id: string): void };
  };
  const live = {
    id: externalAgentSessionId,
    transcriptTargetId,
    agentName: 'openclaw',
    provider: 'openclaw',
    runtimeRole: 'interactive',
    proc: { pid: 123 },
    adapter,
    launchMode: 'app-server',
    // Already past initial startup (no `startup` field) — the scenario this guards is a session that
    // succeeded once and then hit a persistently-flapping-at-the-app-level gateway later.
    providerSessionRef: 'oc-session',
    appServer: { send: () => {}, close: () => {} },
    appServerRedial: async () => {
      redials++;
      if (redials <= MAX_DRIVER_ITERATIONS) {
        setTimeout(() => internal.appServerConnections.handleDisconnect(externalAgentSessionId), 20);
      }
      return { send: () => {}, close: () => {} };
    },
    initializeContext: { workingPath: '/tmp/project' },
    pendingApprovals: new Map(),
    pendingHistoryPages: new Map(),
    pendingRequests: new Map(),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    kill: () => {}
  };
  internal.live.set(externalAgentSessionId, live);

  internal.appServerConnections.handleDisconnect(externalAgentSessionId);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && internal.live.has(externalAgentSessionId)) {
    await Bun.sleep(100);
  }

  expect(internal.live.has(externalAgentSessionId)).toBe(false); // gave up — not stuck reconnecting forever
  expect(redials).toBeGreaterThan(1); // retried more than once (not just fast-failed on the first drop)
  expect(redials).toBeLessThan(MAX_DRIVER_ITERATIONS); // the HOST's own cap fired, not the driver's backstop
  expect(events).toContain('external_agent.connection_required'); // user-visible signal, not a silent hang
}, 20_000);

test('external agent app-server disconnect during initial startup redials before failing, and exhaustion still rejects the pending startup', async () => {
  // Locks in the `handleAppServerDisconnect` reorder's intent: a drop while `live.startup` is still
  // pending gets a few redial attempts (a slow-starting gateway shouldn't fail on its very first
  // handshake attempt), but if the handshake never succeeds, the session still fails — not hangs.
  const host = new ExternalAgentHost({ store: createStore(), bus: new EventBus(), agents: async () => [] });
  const id = 'exa_pending_startup_churn_test';
  const adapter = {
    provider: 'openclaw',
    productIcon: 'openclaw',
    parseOutput: () => [],
    initialize: () => {},
    stop: () => {}
  } as unknown as ExternalAgentProviderAdapter;
  let redials = 0;
  let startupRejected: Error | undefined;
  const internal = host as unknown as {
    live: Map<string, unknown>;
    appServerConnections: { handleDisconnect(id: string): void };
  };
  const live = {
    id,
    transcriptTargetId: 'prj_01KWHOSTTEST0000000000PS',
    agentName: 'openclaw',
    provider: 'openclaw',
    runtimeRole: 'interactive',
    proc: { pid: 123 },
    adapter,
    launchMode: 'app-server',
    providerSessionRef: null,
    appServer: { send: () => {}, close: () => {} },
    appServerRedial: async () => {
      redials++;
      // Every redial's transport reopens fine, but the handshake keeps failing — always re-trigger a drop.
      setTimeout(() => internal.appServerConnections.handleDisconnect(id), 20);
      return { send: () => {}, close: () => {} };
    },
    initializeContext: { workingPath: '/tmp/project' },
    startup: {
      resolve: () => {},
      reject: (err: Error) => {
        startupRejected = err;
      },
      timeout: setTimeout(() => {}, 60_000) // cleared by the exhaustion path; never fires in this test
    },
    pendingApprovals: new Map(),
    pendingHistoryPages: new Map(),
    pendingRequests: new Map(),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    kill: () => {}
  };
  internal.live.set(id, live);

  internal.appServerConnections.handleDisconnect(id);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && internal.live.has(id)) {
    await Bun.sleep(100);
  }

  expect(redials).toBeGreaterThan(1); // redialed rather than failing on the very first drop
  expect(internal.live.has(id)).toBe(false);
  expect(startupRejected).toBeInstanceOf(Error); // exhaustion still rejects a still-pending startup
}, 20_000);

test('external agent input throws instead of silently vanishing into a stale connection while the app-server is reconnecting', async () => {
  // Between a socket drop and a completed redial, `live.appServer` still references the dead connection
  // (`reconnectAppServer` only reassigns it on success) — it stays truthy, so a naive `!appServer` guard
  // wouldn't catch this window. `input()` must fail loudly instead of silently sending into the void.
  const host = new ExternalAgentHost({
    store: createStore(),
    bus: new EventBus(),
    agents: async () => {
      throw new Error('external agent input should not read agent config');
    }
  });
  const id = 'exa_reconnect_input_test';
  let sent = 0;
  const adapter = {
    provider: 'openclaw',
    productIcon: 'openclaw',
    parseOutput: () => [],
    sendInput: () => {
      sent++;
    }
  } as unknown as ExternalAgentProviderAdapter;
  const live = {
    id,
    transcriptTargetId: 'prj_01KWHOSTTEST0000000000IN',
    agentName: 'openclaw',
    provider: 'openclaw',
    runtimeRole: 'interactive',
    proc: { pid: 123 },
    adapter,
    launchMode: 'app-server',
    providerSessionRef: 'oc-session',
    appServer: { send: () => {}, close: () => {} }, // stale reference — still truthy, per the comment above
    appServerReconnecting: true,
    pendingApprovals: new Map(),
    pendingHistoryPages: new Map(),
    pendingRequests: new Map(),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    kill: () => {}
  };
  const internal = host as unknown as { live: Map<string, unknown> };
  internal.live.set(id, live);

  await expect(host.input(id, { input: 'hello' })).rejects.toThrow(/reconnecting/i);
  expect(sent).toBe(0); // never reached the stale connection
});

test('external agent idle suspend releases a resumable json-stream process and reconnects on input', async () => {
  const store = createStore();
  const workdir = mkdtempSync(join(tmpdir(), 'monad-external-agent-idle-'));
  const logPath = join(workdir, 'runtime.log');
  const mockCli = join(workdir, 'mock-json-stream.js');
  writeFileSync(
    mockCli,
    `
const fs = require('node:fs');
const logPath = process.argv[2];
fs.appendFileSync(logPath, 'spawn:' + process.pid + '\\n');
fs.appendFileSync(logPath, 'argv:' + process.argv.slice(3).join('|') + '\\n');
console.log('SESSION_REF:thread-1');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(logPath, 'input:' + chunk.trim() + '\\n');
});
setInterval(() => {}, 1000);
`
  );
  chmodSync(mockCli, 0o755);
  const provider = `idle-json-${Date.now()}`;
  const adapter = {
    provider,
    productIcon: 'codex',
    label: 'Idle JSON',
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Idle JSON',
      command: process.execPath,
      args: [mockCli, logPath],
      installed: true,
      supportedLaunchModes: ['json-stream']
    }),
    listSupportedModels: () => [],
    resolveCommand: (command: string) => command,
    buildLaunch: (agent: ExternalAgentView, opts: { providerSessionRef?: string }) => ({
      argv: [
        agent.command,
        ...(agent.args ?? []),
        ...(opts.providerSessionRef ? ['--resume', opts.providerSessionRef] : [])
      ],
      cwd: workdir,
      launchMode: 'json-stream',
      provider,
      approvalOwnership: 'provider-owned',
      capabilities: ['json-stream', 'session-resume']
    }),
    buildAuthLaunch: () => {
      throw new Error('not used');
    },
    buildAuthStatusLaunch: () => {
      throw new Error('not used');
    },
    authStatus: () => {
      throw new Error('not used');
    },
    parseAuthStatus: () => 'unknown',
    parseOutput: (chunk: string) =>
      chunk.includes('SESSION_REF:thread-1')
        ? [{ type: 'session_ref', payload: { providerSessionRef: 'thread-1' } }]
        : [],
    sendInput: (handle: { stdin?: { write(input: string): void } }, input: string) => {
      handle.stdin?.write(`${input}\n`);
    },
    resolveApproval: () => {},
    resize: () => {},
    stop: () => {}
  } as unknown as ExternalAgentProviderAdapter;
  registerAgentAdapterImpl(adapter);
  const agent: ExternalAgentView = {
    name: provider,
    provider,
    productIcon: 'codex',
    command: process.execPath,
    args: [mockCli, logPath],
    enabled: true,
    defaultLaunchMode: 'json-stream',
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
  const host = new ExternalAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [agent],
    externalAgentIdleTimeoutMs: 300
  });
  const projectId = 'prj_01KWHOSTIDLE000000000000';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'idle test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });

  try {
    const view = await host.start({
      transcriptTargetId: projectId,
      agentName: provider,
      workingPath: workdir,
      launchMode: 'json-stream'
    });
    for (let i = 0; i < 40 && !Bun.file(logPath).exists(); i++) {
      await Bun.sleep(25);
    }
    for (let i = 0; i < 40 && store.getExternalAgentSession(view.id)?.providerSessionRef !== 'thread-1'; i++) {
      await Bun.sleep(25);
    }
    for (let i = 0; i < 40 && store.getExternalAgentSession(view.id)?.pid !== null; i++) {
      await Bun.sleep(25);
    }
    expect(store.getExternalAgentSession(view.id)?.state).toBe('running');
    expect(store.getExternalAgentSession(view.id)?.providerSessionRef).toBe('thread-1');

    await host.input(view.id, { input: 'wake-up' });
    for (let i = 0; i < 40; i++) {
      const log = await Bun.file(logPath).text();
      if ((log.match(/^spawn:/gm) ?? []).length >= 2 && log.includes('input:wake-up')) break;
      await Bun.sleep(25);
    }
    const log = await Bun.file(logPath).text();
    expect((log.match(/^spawn:/gm) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(store.getExternalAgentSession(view.id)?.state).toBe('running');
    expect(store.getExternalAgentSession(view.id)?.pid).toBeNumber();
  } finally {
    host.stop(host.list(projectId).sessions[0]?.id ?? '');
    rmSync(workdir, { recursive: true, force: true });
    unregisterAgentAdapterImpl(provider);
  }
});

test('external agent idle resume passes the latest provider session ref to app-server initialize', async () => {
  const store = createStore();
  const workdir = mkdtempSync(join(tmpdir(), 'monad-external-agent-app-server-idle-'));
  const logPath = join(workdir, 'runtime.log');
  const mockCli = join(workdir, 'mock-app-server.js');
  writeFileSync(
    mockCli,
    `
const fs = require('node:fs');
const logPath = process.argv[2];
fs.appendFileSync(logPath, 'spawn:' + process.pid + '\\n');
console.log('SESSION_REF:thread-stdio');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(logPath, 'input:' + chunk.trim() + '\\n');
});
setInterval(() => {}, 1000);
`
  );
  chmodSync(mockCli, 0o755);
  const provider = `idle-app-server-${Date.now()}`;
  const initRefs: Array<string | undefined> = [];
  const adapter = {
    provider,
    productIcon: 'codex',
    label: 'Idle App Server',
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Idle App Server',
      command: process.execPath,
      args: [mockCli, logPath],
      installed: true,
      supportedLaunchModes: ['app-server']
    }),
    listSupportedModels: () => [],
    resolveCommand: (command: string) => command,
    buildLaunch: (agent: ExternalAgentView) => ({
      argv: [agent.command, ...(agent.args ?? [])],
      cwd: workdir,
      launchMode: 'app-server',
      appServerTransport: 'stdio',
      provider,
      approvalOwnership: 'provider-owned',
      capabilities: ['app-server', 'session-resume']
    }),
    buildAuthLaunch: () => {
      throw new Error('not used');
    },
    buildAuthStatusLaunch: () => {
      throw new Error('not used');
    },
    authStatus: () => {
      throw new Error('not used');
    },
    parseAuthStatus: () => 'unknown',
    initialize: (_handle: unknown, ctx: { providerSessionRef?: string }) => {
      initRefs.push(ctx.providerSessionRef);
    },
    parseOutput: (chunk: string) =>
      chunk.includes('SESSION_REF:thread-stdio')
        ? [{ type: 'session_ref', payload: { providerSessionRef: 'thread-stdio' } }]
        : [],
    sendInput: (handle: { stdin?: { write(input: string): void } }, input: string) => {
      handle.stdin?.write(`${input}\n`);
    },
    resolveApproval: () => {},
    resize: () => {},
    stop: () => {}
  } as unknown as ExternalAgentProviderAdapter;
  registerAgentAdapterImpl(adapter);
  const agent: ExternalAgentView = {
    name: provider,
    provider,
    productIcon: 'codex',
    command: process.execPath,
    args: [mockCli, logPath],
    enabled: true,
    defaultLaunchMode: 'app-server',
    appServerTransport: 'stdio',
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
  const host = new ExternalAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [agent],
    externalAgentIdleTimeoutMs: 300
  });
  const projectId = 'prj_01KWHOSTIDLEAPP000000000';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'idle app-server test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });

  try {
    const view = await host.start({
      transcriptTargetId: projectId,
      agentName: provider,
      workingPath: workdir,
      launchMode: 'app-server',
      appServerTransport: 'stdio'
    });
    for (let i = 0; i < 40 && store.getExternalAgentSession(view.id)?.pid !== null; i++) {
      await Bun.sleep(25);
    }
    await host.input(view.id, { input: 'wake-app-server' });
    for (let i = 0; i < 40 && initRefs.length < 2; i++) {
      await Bun.sleep(25);
    }
    expect(initRefs).toEqual([undefined, 'thread-stdio']);
  } finally {
    host.stop(host.list(projectId).sessions[0]?.id ?? '');
    rmSync(workdir, { recursive: true, force: true });
    unregisterAgentAdapterImpl(provider);
  }
});

test('external agent idle suspend unlinks an app-server unix socket before later resume', async () => {
  const host = new ExternalAgentHost({ store: createStore(), bus: new EventBus(), agents: async () => [] });
  const workdir = mkdtempSync(join(tmpdir(), 'monad-external-agent-socket-idle-'));
  const socketPath = join(workdir, 'provider.sock');
  writeFileSync(socketPath, '');
  const id = 'exa_idle_socket_cleanup';
  const adapter = {
    provider: 'codex',
    productIcon: 'codex',
    parseOutput: () => [],
    stop: () => {}
  } as unknown as ExternalAgentProviderAdapter;
  const live = {
    id,
    transcriptTargetId: 'prj_01KWHOSTIDLESOCKET00000',
    agentName: 'codex',
    provider: 'codex',
    runtimeRole: 'interactive',
    proxyApprovals: false,
    proc: { pid: -1 },
    adapter,
    launchMode: 'app-server',
    providerSessionRef: 'thread-unix',
    appServerSocketPath: socketPath,
    pendingApprovals: new Map(),
    pendingHistoryPages: new Map(),
    pendingRequests: new Map(),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    idleTimeoutMs: 1,
    restartRuntime: async () => {},
    kill: () => {}
  };
  const internal = host as unknown as {
    live: Map<string, unknown>;
    appServerConnections: { handleDisconnect(id: string): void };
    suspendIdleRuntime(id: string): void;
  };
  internal.live.set(id, live);

  try {
    internal.suspendIdleRuntime(id);
    expect(await Bun.file(socketPath).exists()).toBe(false);
    internal.appServerConnections.handleDisconnect(id);
    await Bun.sleep(650);
    expect(internal.live.has(id)).toBe(true);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('external agent idle resume keeps the pty fallback launch mode instead of rebuilding the original pty mode', async () => {
  const store = createStore();
  const workdir = mkdtempSync(join(tmpdir(), 'monad-external-agent-pty-fallback-idle-'));
  const logPath = join(workdir, 'runtime.log');
  const mockCli = join(workdir, 'mock-fallback-json-stream.js');
  writeFileSync(
    mockCli,
    `
const fs = require('node:fs');
const logPath = process.argv[2];
fs.appendFileSync(logPath, 'argv:' + process.argv.slice(3).join('|') + '\\n');
console.log('SESSION_REF:thread-fallback');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(logPath, 'input:' + chunk.trim() + '\\n');
});
setInterval(() => {}, 1000);
`
  );
  chmodSync(mockCli, 0o755);
  const provider = `idle-fallback-${Date.now()}`;
  const adapter = {
    provider,
    productIcon: 'codex',
    label: 'Idle Fallback',
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Idle Fallback',
      command: process.execPath,
      args: [mockCli, logPath],
      installed: true,
      supportedLaunchModes: ['pty', 'json-stream']
    }),
    listSupportedModels: () => [],
    resolveCommand: (command: string) => command,
    buildLaunch: (agent: ExternalAgentView, opts: { launchMode?: string; providerSessionRef?: string }) => ({
      argv: [
        agent.command,
        ...(agent.args ?? []),
        `--mode=${opts.launchMode ?? 'default'}`,
        ...(opts.providerSessionRef ? ['--resume', opts.providerSessionRef] : [])
      ],
      cwd: workdir,
      launchMode: (opts.launchMode ?? 'pty') as 'pty' | 'json-stream',
      provider,
      approvalOwnership: 'provider-owned',
      capabilities: opts.launchMode === 'json-stream' ? ['json-stream', 'session-resume'] : ['pty', 'provider-approval']
    }),
    buildAuthLaunch: () => {
      throw new Error('not used');
    },
    buildAuthStatusLaunch: () => {
      throw new Error('not used');
    },
    authStatus: () => {
      throw new Error('not used');
    },
    parseAuthStatus: () => 'unknown',
    parseOutput: (chunk: string) =>
      chunk.includes('SESSION_REF:thread-fallback')
        ? [{ type: 'session_ref', payload: { providerSessionRef: 'thread-fallback' } }]
        : [],
    sendInput: (handle: { stdin?: { write(input: string): void } }, input: string) => {
      handle.stdin?.write(`${input}\n`);
    },
    resolveApproval: () => {},
    resize: () => {},
    stop: () => {}
  } as unknown as ExternalAgentProviderAdapter;
  registerAgentAdapterImpl(adapter);
  const agent: ExternalAgentView = {
    name: provider,
    provider,
    productIcon: 'codex',
    command: process.execPath,
    args: [mockCli, logPath],
    enabled: true,
    defaultLaunchMode: 'pty',
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
  const host = new ExternalAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [agent],
    externalAgentIdleTimeoutMs: 300
  });
  const projectId = 'prj_01KWHOSTIDLEFALLBACK0000';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'idle fallback test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  const originalSpawn = Bun.spawn;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((argv, options) => {
    if (options && typeof options === 'object' && 'terminal' in options) throw new Error('pty unavailable');
    return originalSpawn(argv, options);
  }) as typeof Bun.spawn;

  try {
    const view = await host.start({
      transcriptTargetId: projectId,
      agentName: provider,
      workingPath: workdir,
      launchMode: 'pty'
    });
    for (let i = 0; i < 40 && store.getExternalAgentSession(view.id)?.providerSessionRef !== 'thread-fallback'; i++) {
      await Bun.sleep(25);
    }
    for (let i = 0; i < 40 && store.getExternalAgentSession(view.id)?.pid !== null; i++) {
      await Bun.sleep(25);
    }
    await host.input(view.id, { input: 'wake-fallback' });
    for (let i = 0; i < 40; i++) {
      const log = await Bun.file(logPath).text();
      if (log.includes('input:wake-fallback')) break;
      await Bun.sleep(25);
    }
    const _log = await Bun.file(logPath).text();
  } finally {
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    host.stop(host.list(projectId).sessions[0]?.id ?? '');
    rmSync(workdir, { recursive: true, force: true });
    unregisterAgentAdapterImpl(provider);
  }
});

test('managed external agent observation restores Codex provider history from persisted pointers', async () => {
  const store = createStore();
  const host = new ExternalAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => []
  });
  const projectId = 'prj_01KWHOSTTEST0000000000002';
  const externalAgentSessionId = 'exa_host_unavailable_test';
  const testRun = `monad-external-agent-host-${Date.now()}`;
  const rolloutDir = join(homedir(), '.codex', 'sessions', '2099', '01', testRun);
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(
    join(rolloutDir, 'rollout-2099-01-01T00-00-00-provider-session-1.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'provider-session-1' } })}\n${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'restored from provider history' }
    })}\n`
  );
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host unavailable test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: externalAgentSessionId,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'exited',
    pid: null,
    providerSessionRef: 'provider-session-1',
    outputSnapshot: '',
    exitCode: 0,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:01.000Z',
    exitedAt: '2026-07-02T00:00:01.000Z'
  });

  try {
    await expect(host.observeWithProviderHistory(externalAgentSessionId)).resolves.toMatchObject({
      state: 'history',
      externalAgentSessionId,
      provider: 'codex'
    });
  } finally {
    rmSync(rolloutDir, { recursive: true, force: true });
  }
});

test('managed external agent observation prefers Codex CLI history over rollout fallback', async () => {
  const root = join(homedir(), '.codex', 'sessions', '2099', '01', `monad-external-agent-host-cli-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const workdir = join(root, 'workdir');
  mkdirSync(workdir, { recursive: true });
  const script = join(root, 'mock-codex-history.js');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bun',
      'process.stdin.on("data", (data) => {',
      '  for (const line of data.toString().trim().split(/\\n+/)) {',
      '    if (!line) continue;',
      '    const msg = JSON.parse(line);',
      '    if (msg.method === "thread/resume") {',
      '      process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: msg.params.threadId } } }) + "\\n");',
      '    }',
      '    if (msg.method === "thread/turns/list") {',
      '      process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ id: "turn_1", status: { type: "completed" }, startedAt: 1782935000, completedAt: 1782935001, durationMs: 1000, items: [{ type: "agentMessage", id: "item_1", text: "restored through codex cli", phase: null, memoryCitation: null }] }], nextCursor: null, backwardsCursor: null } }) + "\\n");',
      '    }',
      '  }',
      '});',
      'setTimeout(() => {}, 30_000);'
    ].join('\n')
  );
  chmodSync(script, 0o755);
  writeFileSync(
    join(root, 'rollout-2099-01-01T00-00-00-provider-session-cli.jsonl'),
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'stale rollout fallback' } })}\n`
  );

  const store = createStore();
  const projectId = 'prj_01KWHOSTTEST0000000000003';
  const externalAgentSessionId = 'exa_host_cli_history_test';
  const agent: ExternalAgentView = {
    name: 'codex',
    provider: 'codex',
    command: script,
    enabled: true,
    defaultLaunchMode: 'app-server',
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
  const host = new ExternalAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [agent]
  });
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host CLI history test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: workdir,
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: externalAgentSessionId,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'exited',
    pid: null,
    providerSessionRef: 'provider-session-cli',
    outputSnapshot: '',
    exitCode: 0,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:01.000Z',
    exitedAt: '2026-07-02T00:00:01.000Z'
  });

  try {
    const observation = await host.observeWithProviderHistory(externalAgentSessionId);
    expect(observation).toMatchObject({
      state: 'history',
      externalAgentSessionId,
      provider: 'codex'
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed external agent observation restores Claude Code provider history', async () => {
  const root = join(homedir(), '.claude', 'projects', `monad-external-agent-host-claude-${Date.now()}`);
  const providerSessionRef = '11111111-2222-4333-8444-555555555555';
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, `${providerSessionRef}.jsonl`),
    `${JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: providerSessionRef,
      cwd: '/tmp/project'
    })}\n${JSON.stringify({
      type: 'assistant',
      session_id: providerSessionRef,
      message: { role: 'assistant', content: [{ type: 'text', text: 'restored claude history' }] },
      parent_tool_use_id: null
    })}\n`
  );
  const store = createStore();
  const projectId = 'prj_01KWHOSTTEST0000000000004';
  const externalAgentSessionId = 'exa_host_claude_history_test';
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host Claude history test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: 'claude',
    provider: 'claude-code',
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: externalAgentSessionId,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'exited',
    pid: null,
    providerSessionRef,
    outputSnapshot: '',
    exitCode: 0,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:01.000Z',
    exitedAt: '2026-07-02T00:00:01.000Z'
  });

  try {
    await expect(host.observeWithProviderHistory(externalAgentSessionId)).resolves.toMatchObject({
      state: 'history',
      externalAgentSessionId,
      provider: 'claude-code'
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed external agent observation restores Gemini checkpoint history', async () => {
  const root = join(homedir(), '.gemini', 'tmp', `monad-external-agent-host-gemini-${Date.now()}`, 'chats');
  const providerSessionRef = '8fcee1ae-8c2e-492c-9b94-2ee7325497c7';
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'session-2099-01-01T00-00-8fcee1ae.jsonl'),
    `${JSON.stringify({
      sessionId: providerSessionRef,
      projectHash: 'test',
      startTime: '2099-01-01T00:00:00.000Z',
      lastUpdated: '2099-01-01T00:00:00.000Z',
      kind: 'main'
    })}\n${JSON.stringify({
      $set: {
        messages: [
          { id: 'u1', type: 'user', content: [{ text: 'ignored user text' }] },
          { id: 'm1', type: 'model', content: [{ text: 'restored gemini history' }] }
        ]
      }
    })}\n`
  );
  const store = createStore();
  const projectId = 'prj_01KWHOSTTEST0000000000005';
  const externalAgentSessionId = 'exa_host_gemini_history_test';
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host Gemini history test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: 'gemini',
    provider: 'gemini',
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: externalAgentSessionId,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'exited',
    pid: null,
    providerSessionRef,
    outputSnapshot: '',
    exitCode: 0,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:01.000Z',
    exitedAt: '2026-07-02T00:00:01.000Z'
  });

  try {
    await expect(host.observeWithProviderHistory(externalAgentSessionId)).resolves.toMatchObject({
      state: 'history',
      externalAgentSessionId,
      provider: 'gemini'
    });
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('managed external agent observation restores Qwen stream-json history', async () => {
  const root = join(homedir(), '.qwen', 'monad-external-agent-host', String(Date.now()));
  const providerSessionRef = 'qwen-provider-session-1';
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, `${providerSessionRef}.jsonl`),
    `${JSON.stringify({ type: 'system', subtype: 'init', session_id: providerSessionRef })}\n${JSON.stringify({
      type: 'assistant',
      session_id: providerSessionRef,
      message: { role: 'assistant', content: 'restored qwen history' }
    })}\n`
  );
  const store = createStore();
  const projectId = 'prj_01KWHOSTTEST0000000000006';
  const externalAgentSessionId = 'exa_host_qwen_history_test';
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host Qwen history test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id: externalAgentSessionId,
    transcriptTargetId: projectId,
    agentName: 'qwen',
    provider: 'qwen',
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: externalAgentSessionId,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'exited',
    pid: null,
    providerSessionRef,
    outputSnapshot: '',
    exitCode: 0,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:01.000Z',
    exitedAt: '2026-07-02T00:00:01.000Z'
  });

  try {
    await expect(host.observeWithProviderHistory(externalAgentSessionId)).resolves.toMatchObject({
      state: 'history',
      externalAgentSessionId,
      provider: 'qwen'
    });
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('external agent usage returns empty records when the adapter has no usage probe', async () => {
  const host = new ExternalAgentHost({
    store: createStore(),
    bus: new EventBus(),
    agents: async () => [
      {
        name: 'codex',
        provider: 'codex',
        command: 'codex',
        enabled: true,
        defaultLaunchMode: 'app-server',
        allowAutopilot: false,
        approvalOwnership: 'provider-owned'
      }
    ]
  });

  const usage = await host.usage('codex');

  expect(usage).toMatchObject({
    agentName: 'codex',
    provider: 'codex',
    records: []
  });
  expect(typeof usage.checkedAt).toBe('string');
});

test('listLive returns only starting/running runtimes across all projects', () => {
  const store = createStore();
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  const insertProject = (id: `prj_${string}`, title: string): void =>
    store.insertWorkplaceProject({
      id,
      title,
      ownerPrincipalId: 'prn_test',
      state: 'active',
      archived: false,
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z'
    });
  insertProject('prj_01KWLIVE0000000000000001', 'Alpha');
  insertProject('prj_01KWLIVE0000000000000002', 'Beta');
  const insertSession = (
    id: string,
    transcriptTargetId: `prj_${string}`,
    provider: string,
    state: ExternalAgentSessionState,
    startedAt: string,
    outputSnapshot = ''
  ): void =>
    store.upsertExternalAgentSession({
      id,
      transcriptTargetId,
      agentName: provider,
      provider,
      workingPath: '/tmp/p',
      launchMode: 'app-server',
      runtimeRole: 'managed-project-agent',
      agentRuntimeId: id,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state,
      pid: null,
      providerSessionRef: null,
      outputSnapshot,
      exitCode: null,
      startedAt,
      updatedAt: startedAt,
      exitedAt: null
    });
  // Two live (running/starting) runtimes in different projects, incl. framework adapters, plus two
  // dead ones that must be excluded.
  insertSession(
    'exa_run_a',
    'prj_01KWLIVE0000000000000001',
    'openclaw',
    'running',
    '2026-07-02T00:00:01.000Z',
    'noisy output'
  );
  insertSession('exa_start_b', 'prj_01KWLIVE0000000000000002', 'hermes', 'starting', '2026-07-02T00:00:02.000Z');
  insertSession('exa_stop_a', 'prj_01KWLIVE0000000000000001', 'codex', 'stopped', '2026-07-02T00:00:03.000Z');
  insertSession('exa_exit_b', 'prj_01KWLIVE0000000000000002', 'qwen', 'exited', '2026-07-02T00:00:04.000Z');

  const live = host.listLive().sessions;
  expect(live.map((s) => s.id)).toEqual(['exa_run_a', 'exa_start_b']);
  expect(live.every((s) => s.state === 'running' || s.state === 'starting')).toBe(true);
  // spans multiple projects and surfaces framework (openclaw/hermes) providers, not just external agents
  expect(new Set(live.map((s) => s.transcriptTargetId)).size).toBe(2);
  expect(live.map((s) => s.provider).sort()).toEqual(['hermes', 'openclaw']);
  // status-only list: output snapshots are stripped so the poll ships no output buffers
  expect(live.every((s) => s.outputSnapshot === '')).toBe(true);
});

test('listLive/listAllSummaries paginate with a cursor and expose nextCursor', () => {
  const store = createStore();
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  store.insertWorkplaceProject({
    id: 'prj_01KWLIVE0000000000000003',
    title: 'Gamma',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  for (let i = 0; i < 5; i++) {
    store.upsertExternalAgentSession({
      id: `exa_page_${i}`,
      transcriptTargetId: 'prj_01KWLIVE0000000000000003',
      agentName: 'codex',
      provider: 'codex',
      workingPath: '/tmp/p',
      launchMode: 'app-server',
      runtimeRole: 'managed-project-agent',
      agentRuntimeId: `exa_page_${i}`,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'running',
      pid: null,
      providerSessionRef: null,
      outputSnapshot: '',
      exitCode: null,
      startedAt: `2026-07-02T00:00:0${i}.000Z`,
      updatedAt: `2026-07-02T00:00:0${i}.000Z`,
      exitedAt: null
    });
  }

  const firstPage = host.listLive({ limit: 2 });
  expect(firstPage.sessions.map((s) => s.id)).toEqual(['exa_page_3', 'exa_page_4']);

  const secondPage = host.listLive({ limit: 2, before: firstPage.nextCursor });
  expect(secondPage.sessions.map((s) => s.id)).toEqual(['exa_page_1', 'exa_page_2']);

  const lastPage = host.listLive({ limit: 2, before: secondPage.nextCursor });
  expect(lastPage.sessions.map((s) => s.id)).toEqual(['exa_page_0']);

  const summaries = host.listAllSummaries({ limit: 3 });
  expect(summaries.sessions.length).toBe(3);
});

// cli-oneshot launch mode: the session has NO persistent process; each turn spawns a fresh CLI with
// the directive baked into argv (`<cmd> --yolo -z <directive>`) and streams its stdout into the
// transcript. Proves Hermes-style providers (no app-server backend) run as managed members.
test('cli-oneshot session has no persistent process and runs a fresh CLI per turn', async () => {
  const store = createStore();
  const mockCli = new URL('../fixtures/mock-oneshot-cli.ts', import.meta.url).pathname;
  const workdir = mkdtempSync(join(tmpdir(), 'cli-oneshot-'));
  const agent: ExternalAgentView = {
    name: 'hermes',
    provider: 'hermes',
    command: process.execPath,
    args: [mockCli],
    enabled: true,
    defaultLaunchMode: 'cli-oneshot',
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [agent] });
  const projectId = 'prj_01KWHOSTTEST0000000000009';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'cli-oneshot test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  try {
    const view = await host.start({
      transcriptTargetId: projectId,
      agentName: 'hermes',
      workingPath: workdir,
      launchMode: 'cli-oneshot'
    });
    // A logical session — running, but with no persistent process/pid.
    expect(view.state).toBe('running');

    const observedOutput = (): string => {
      const obs = host.observe(view.id);
      return obs && 'output' in obs ? (obs.output ?? '') : '';
    };
    await host.input(view.id, { input: 'ping' });
    // Wait for the per-turn process to spawn, echo, and exit.
    for (let i = 0; i < 40 && !observedOutput().includes('oneshot-reply'); i++) {
      await Bun.sleep(50);
    }
    host.stop(view.id);
    expect(host.list(projectId).sessions[0]?.state).toBe('stopped');
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

function seedApprovalLiveSession(
  host: ExternalAgentHost,
  store: ReturnType<typeof createStore>,
  { projectId, id, proxyApprovals }: { projectId: `prj_${string}`; id: string; proxyApprovals: boolean }
): { resolveCalls: { allow: boolean; reason?: string }[]; live: { pendingApprovals: Map<string, unknown> } } {
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Approval test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertExternalAgentSession({
    id,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: id,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'running',
    pid: 321,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    exitedAt: null
  });
  const resolveCalls: { allow: boolean; reason?: string }[] = [];
  const adapter = {
    provider: 'codex',
    productIcon: 'codex',
    parseOutput: (): unknown[] => [
      { type: 'approval_requested', payload: { requestId: 'req-1', kind: 'execCommand', command: 'rm -rf /tmp/x' } }
    ],
    resolveApproval: (_handle: unknown, resolution: { allow: boolean; reason?: string }) => {
      resolveCalls.push({ allow: resolution.allow, reason: resolution.reason });
    }
  } as unknown as ExternalAgentProviderAdapter;
  const live = {
    id,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    runtimeRole: 'managed-project-agent',
    proxyApprovals,
    proc: { pid: 321 },
    adapter,
    launchMode: 'app-server',
    providerSessionRef: null,
    pendingApprovals: new Map<string, unknown>(),
    pendingHistoryPages: new Map(),
    pendingRequests: new Map(),
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
    outputSeq: 0,
    snapshotFlushTimer: null,
    nextRequestId: () => 0,
    kill: () => {}
  };
  (host as unknown as { live: Map<string, unknown> }).live.set(id, live);
  (
    host as unknown as {
      outputPipeline: {
        output(
          t: string,
          id: string,
          chunk: string,
          stream: 'stdout' | 'stderr' | 'pty',
          a: ExternalAgentProviderAdapter
        ): void;
      };
    }
  ).outputPipeline.output(projectId, id, '{"approval":1}\n', 'stdout', adapter);
  return { resolveCalls, live };
}

test('a delegated managed session projects the provider approval and relays the human decision', () => {
  const store = createStore();
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  const id = 'exa_approval_delegate';
  const { resolveCalls, live } = seedApprovalLiveSession(host, store, {
    projectId: 'prj_01KWHOSTAPPROVE000000000A',
    id,
    proxyApprovals: true
  });

  // Projected, not auto-denied: it is registered as pending and the provider was not resolved yet.
  expect(live.pendingApprovals.has('req-1')).toBe(true);

  host.resolveApproval(id, { requestId: 'req-1', allow: true });
  expect(resolveCalls).toEqual([{ allow: true, reason: undefined }]);
  expect(live.pendingApprovals.has('req-1')).toBe(false);
});

test('an autopilot managed session auto-denies a leaked provider approval', () => {
  const store = createStore();
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [] });
  const { resolveCalls, live } = seedApprovalLiveSession(host, store, {
    projectId: 'prj_01KWHOSTAPPROVE000000000B',
    id: 'exa_approval_autopilot',
    proxyApprovals: false
  });

  expect(resolveCalls).toEqual([
    { allow: false, reason: 'managed project external agent provider approvals are disabled' }
  ]);
  expect(live.pendingApprovals.has('req-1')).toBe(false);
});

test('a real spawned managed process actually receives the autopilot skip flag on its argv', async () => {
  const store = createStore();
  const workdir = mkdtempSync(join(tmpdir(), 'argv-capture-'));
  const monadHome = mkdtempSync(join(tmpdir(), 'argv-capture-home-'));
  const mockCli = new URL('../fixtures/mock-argv-capture-cli.ts', import.meta.url).pathname;
  const autopilotArgvFile = join(workdir, 'argv-autopilot.txt');
  const delegatedArgvFile = join(workdir, 'argv-delegated.txt');

  // Temporarily swap the registered `hermes` adapter for one whose buildLaunch appends a marker
  // flag only when `skipProviderApprovals` is set — proving the REAL spawned process's argv (not
  // just the adapter unit test) reflects `host.start`'s allowAutopilot -> skip-flag threading.
  // Restored in `finally` so the shared provider registry is unaffected for other test files.
  const originalHermesAdapter = builtinAgentAdapters.find((a) => a.provider === 'hermes');
  if (!originalHermesAdapter) throw new Error('hermes adapter not found among builtins');
  const testAdapter: ExternalAgentProviderAdapter = {
    ...originalHermesAdapter,
    buildLaunch: (agent, opts) => ({
      argv: [agent.command, ...(agent.args ?? []), ...(opts.skipProviderApprovals ? ['--test-autopilot-flag'] : [])],
      cwd: opts.workingPath,
      env: agent.env,
      launchMode: opts.launchMode ?? agent.defaultLaunchMode,
      provider: 'hermes',
      approvalOwnership: 'provider-owned',
      capabilities: []
    }),
    // Always resolvable: this override exists only to prove the host's allowAutopilot -> argv
    // threading, not to exercise the capability lock (covered by the adapter capability-matrix test).
    supportsApprovalResolution: () => true,
    resolveApproval: () => {},
    parseOutput: () => [],
    sendInput: () => {},
    stop: (handle) => handle.kill('SIGTERM')
  };
  registerAgentAdapterImpl(testAdapter);

  // Two agent templates sharing the swapped adapter, differing only in which file their child
  // records its argv to — `host.start`'s `allowAutopilot` override (per session) is what varies.
  const agents: ExternalAgentView[] = [
    {
      name: 'argv-capture-autopilot',
      provider: 'hermes',
      command: process.execPath,
      args: [mockCli, autopilotArgvFile],
      enabled: true,
      defaultLaunchMode: 'pty',
      allowAutopilot: true,
      approvalOwnership: 'provider-owned'
    },
    {
      name: 'argv-capture-delegated',
      provider: 'hermes',
      command: process.execPath,
      args: [mockCli, delegatedArgvFile],
      enabled: true,
      defaultLaunchMode: 'pty',
      allowAutopilot: true,
      approvalOwnership: 'provider-owned'
    }
  ];
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => agents, monadHome });
  const projectId = 'prj_01KWHOSTTEST00000ARGVCAP1';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'argv capture test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z'
  });

  const readArgvOnceReady = async (argvFile: string): Promise<string> => {
    for (let i = 0; i < 60; i++) {
      if (await Bun.file(argvFile).exists()) return await Bun.file(argvFile).text();
      await Bun.sleep(50);
    }
    throw new Error(`argv capture file never appeared: ${argvFile}`);
  };

  try {
    const autopilotView = await host.start({
      transcriptTargetId: projectId,
      agentName: 'argv-capture-autopilot',
      workingPath: workdir,
      launchMode: 'pty',
      runtimeRole: 'managed-project-agent',
      allowAutopilot: true
    });
    const delegatedView = await host.start({
      transcriptTargetId: projectId,
      agentName: 'argv-capture-delegated',
      workingPath: workdir,
      launchMode: 'pty',
      runtimeRole: 'managed-project-agent',
      allowAutopilot: false
    });

    const _autopilotArgv = await readArgvOnceReady(autopilotArgvFile);
    const _delegatedArgv = await readArgvOnceReady(delegatedArgvFile);

    // This is the process's OWN argv, read back from the file IT wrote after spawning — proof the
    // flag actually reached the real OS process, not just the in-memory launch spec.

    host.stop(autopilotView.id);
    host.stop(delegatedView.id);
  } finally {
    registerAgentAdapterImpl(originalHermesAdapter);
    rmSync(workdir, { recursive: true, force: true });
    rmSync(monadHome, { recursive: true, force: true });
  }
});

// Per-provider real-adapter argv proof: unlike the generic test above (a swapped-in fake adapter with
// a made-up flag), these run the REAL codex/qwen/claude-code adapters' own `buildLaunch`. Each
// provider names its skip-approval flag differently, so this proves — per adapter, using that
// adapter's actual implementation — that the real spawned process's own argv reflects it.
async function runRealAdapterArgvCapture(opts: {
  provider: 'codex' | 'qwen' | 'claude-code';
  launchMode: 'app-server' | 'json-stream';
  allowAutopilot: boolean;
}): Promise<string> {
  const script = new URL('../fixtures/mock-real-adapter-argv-capture.ts', import.meta.url).pathname;
  chmodSync(script, 0o755);
  const store = createStore();
  const workdir = mkdtempSync(join(tmpdir(), `argv-real-${opts.provider}-`));
  const monadHome = mkdtempSync(join(tmpdir(), `argv-real-${opts.provider}-home-`));
  const outFile = join(workdir, 'argv.txt');
  // POSIX execs the fixture directly via its shebang. Windows can't do that, so it must run through
  // `bun <script>` instead. This only matters for Qwen (its json-stream buildLaunch only ever PUSHES
  // flags after `agent.args`, so the script path stays argv[1] and bun never sees a foreign token
  // before it) — the Codex and Claude Code tests below are skipped on Windows instead, because their
  // adapters insert tokens BEFORE `agent.args` (codex: 'app-server'/'--stdio'; claude: an unshifted
  // `-p`), which would land between `bun` and the script path and break this fallback.
  const command = process.platform === 'win32' ? process.execPath : script;
  const scriptArgs = process.platform === 'win32' ? [script] : [];
  const agent: ExternalAgentView = {
    name: opts.provider,
    provider: opts.provider,
    command,
    args: [...scriptArgs, `--argv-out=${outFile}`],
    enabled: true,
    defaultLaunchMode: opts.launchMode,
    allowAutopilot: true,
    approvalOwnership: 'provider-owned'
  };
  const host = new ExternalAgentHost({ store, bus: new EventBus(), agents: async () => [agent], monadHome });
  const projectId: `prj_${string}` = `prj_01KWHOSTTEST0000${opts.provider.slice(0, 6).toUpperCase().padEnd(6, '0')}01`;
  store.insertWorkplaceProject({
    id: projectId,
    title: `real adapter argv capture: ${opts.provider}`,
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z'
  });
  try {
    const view = await host.start({
      transcriptTargetId: projectId,
      agentName: opts.provider,
      workingPath: workdir,
      launchMode: opts.launchMode,
      runtimeRole: 'managed-project-agent',
      allowAutopilot: opts.allowAutopilot
    });
    for (let i = 0; i < 60; i++) {
      if (await Bun.file(outFile).exists()) break;
      await Bun.sleep(50);
    }
    if (!(await Bun.file(outFile).exists())) throw new Error(`argv capture file never appeared for ${opts.provider}`);
    const argv = await Bun.file(outFile).text();
    host.stop(view.id);
    return argv;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(monadHome, { recursive: true, force: true });
  }
}

// Skipped on Windows: codex's app-server buildLaunch inserts 'app-server'/'--stdio' before
// `agent.args`, so the win32 `bun <script>` fallback in `runRealAdapterArgvCapture` would put those
// tokens between `bun` and the script path, which bun would try (and fail) to interpret as its own
// CLI arguments rather than passing them through to the script.
test.skipIf(process.platform === 'win32')(
  'the real Codex adapter spawns app-server with --ask-for-approval never only in autopilot',
  async () => {
    const _autopilotArgv = await runRealAdapterArgvCapture({
      provider: 'codex',
      launchMode: 'app-server',
      allowAutopilot: true
    });
    const _delegatedArgv = await runRealAdapterArgvCapture({
      provider: 'codex',
      launchMode: 'app-server',
      allowAutopilot: false
    });
  }
);

test('the real Qwen adapter spawns json-stream with --approval-mode=yolo only in autopilot', async () => {
  const _autopilotArgv = await runRealAdapterArgvCapture({
    provider: 'qwen',
    launchMode: 'json-stream',
    allowAutopilot: true
  });
  const _delegatedArgv = await runRealAdapterArgvCapture({
    provider: 'qwen',
    launchMode: 'json-stream',
    allowAutopilot: false
  });
});

// Skipped on Windows: claude's stream-json buildLaunch unshifts `-p` before `agent.args`, so the
// win32 `bun <script>` fallback would put `-p` between `bun` and the script path, which bun would
// try (and fail) to interpret as its own CLI flag rather than passing it through to the script.
test.skipIf(process.platform === 'win32')(
  'the real Claude Code adapter cannot delegate: --dangerously-skip-permissions is always present',
  async () => {
    const _autopilotArgv = await runRealAdapterArgvCapture({
      provider: 'claude-code',
      launchMode: 'json-stream',
      allowAutopilot: true
    });
    const _delegatedArgv = await runRealAdapterArgvCapture({
      provider: 'claude-code',
      launchMode: 'json-stream',
      allowAutopilot: false
    });
    // Claude Code's adapter has no resolvable approval channel over json-stream, so the capability
    // lock keeps it on autopilot regardless of the requested setting — proven here at the real-process
    // level, not just via the adapter capability-matrix unit test.
  }
);
