import type { NativeCliAgentView, NativeCliSessionState } from '@monad/protocol';
import type { NativeCliProviderAdapter } from '@/services/native-cli/types.ts';

import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { EventBus } from '@/services/event-bus.ts';
import { BoundedOutputBuffer } from '@/services/native-cli/bounded-output-buffer.ts';
import { AUTH_STATUS_TIMEOUT_MS } from '@/services/native-cli/constants.ts';
import { NativeCliHost } from '@/services/native-cli/host.ts';
import { registerAgentAdapterImpl } from '@/services/native-cli/index.ts';
import { createStore } from '@/store/db/index.ts';

// Adapters are agent-adapter atoms registered at daemon boot; tests drive the host directly, so they
// register the built-ins up front (mirrors the daemon's registration path).
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

test('native CLI auth status probes use a global 20 second timeout', () => {
  expect(AUTH_STATUS_TIMEOUT_MS).toBe(20_000);
});

test('managed provider final can retire a consumed inbox turn without auto-posting', async () => {
  const store = createStore();
  const host = new NativeCliHost({
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
  store.upsertNativeCliSession({
    id: 'ncli_host_test',
    transcriptTargetId: 'prj_01KWHOSTTEST0000000000000',
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'ncli_host_test',
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
      nativeCliSessionId: 'ncli_host_test',
      reasoning: 'Thinking',
      source: 'managed-native-cli'
    },
    includeInContext: false,
    streamStatus: 'streaming'
  });
  store.enqueueNativeCliInboxItem('ncli_host_test', 1);
  store.markNativeCliInboxDelivered('ncli_host_test', 1);
  store.markNativeCliInboxConsumed('ncli_host_test', 1);

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
    'ncli_host_test',
    'No action needed.',
    false,
    false
  );
  await Bun.sleep(0);

  expect(calls).toEqual([
    {
      sessionId: 'prj_01KWHOSTTEST0000000000000',
      nativeCliSessionId: 'ncli_host_test',
      agentName: 'codex',
      text: 'No action needed.',
      error: false,
      post: false
    }
  ]);
});

test('managed native CLI output stays live-only and is not persisted as a raw snapshot', async () => {
  const store = createStore();
  const host = new NativeCliHost({
    store,
    bus: new EventBus(),
    agents: async () => []
  });
  const projectId = 'prj_01KWHOSTTEST0000000000001';
  const nativeCliSessionId = 'ncli_host_snapshot_test';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host snapshot test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertNativeCliSession({
    id: nativeCliSessionId,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: nativeCliSessionId,
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
  } as unknown as NativeCliProviderAdapter;
  const live = {
    id: nativeCliSessionId,
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
    outputBuffer: new BoundedOutputBuffer(256 * 1024),
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
          adapter: NativeCliProviderAdapter
        ): void;
      };
    }
  ).live.set(nativeCliSessionId, live);
  (
    host as unknown as {
      outputPipeline: {
        output(
          transcriptTargetId: string,
          id: string,
          chunk: string,
          stream: 'stdout' | 'stderr' | 'pty',
          adapter: NativeCliProviderAdapter
        ): void;
      };
    }
  ).outputPipeline.output(projectId, nativeCliSessionId, '{"type":"result","result":"secret"}\n', 'stdout', adapter);
  await Bun.sleep(250);

  expect(host.list(projectId).sessions[0]?.outputSnapshot).toContain('secret');
  expect(host.observe(nativeCliSessionId)).toMatchObject({
    state: 'live',
    nativeCliSessionId,
    provider: 'codex',
    output: expect.stringContaining('secret')
  });
  expect(store.getNativeCliSession(nativeCliSessionId)?.outputSnapshot).toBe('');
});

test('native CLI observation stream pushes incremental deltas the client can reconstruct', async () => {
  const store = createStore();
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => [] });
  const projectId = 'prj_01KWHOSTTEST0000000000009';
  const nativeCliSessionId = 'ncli_host_delta_test';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Delta',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertNativeCliSession({
    id: nativeCliSessionId,
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
  } as unknown as NativeCliProviderAdapter;
  const live = {
    id: nativeCliSessionId,
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
      output(t: string, id: string, chunk: string, stream: string, adapter: NativeCliProviderAdapter): void;
    };
  };
  internal.live.set(nativeCliSessionId, live);

  const frames: { output?: string; append?: string; seq?: number }[] = [];
  const sub = host.subscribeObservation(nativeCliSessionId, (access) => {
    if (access.state === 'live') frames.push({ output: access.output, append: access.append, seq: access.seq });
  });
  // The initial access is a full snapshot (empty output so far).
  expect(sub.access.state).toBe('live');

  internal.outputPipeline.output(projectId, nativeCliSessionId, 'Hello, ', 'stdout', adapter);
  await Bun.sleep(250);
  internal.outputPipeline.output(projectId, nativeCliSessionId, 'world!', 'stdout', adapter);
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

test('native CLI observation resume returns only the delta past the client cursor', async () => {
  const host = new NativeCliHost({ store: createStore(), bus: new EventBus(), agents: async () => [] });
  const id = 'ncli_resume_seq_test';
  const adapter = {
    provider: 'codex',
    productIcon: 'openai',
    parseOutput: () => []
  } as unknown as NativeCliProviderAdapter;
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
      output(t: string, id: string, chunk: string, stream: string, adapter: NativeCliProviderAdapter): void;
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
  expect(resume.state === 'live' && resume.output).toBeUndefined();
  // Cursor at head → nothing new, full snapshot.
  expect(host.observe(id, 13)).toMatchObject({ state: 'live', output: 'Hello, world!', seq: 13 });
});

test('native CLI app-server reconnect re-dials the socket and resumes the thread', async () => {
  const host = new NativeCliHost({ store: createStore(), bus: new EventBus(), agents: async () => [] });
  const nativeCliSessionId = 'ncli_reconnect_test';
  const initCalls: { providerSessionRef?: string }[] = [];
  const adapter = {
    provider: 'codex',
    productIcon: 'openai',
    parseOutput: () => [],
    initialize: (_h: unknown, ctx: { providerSessionRef?: string }) =>
      initCalls.push({ providerSessionRef: ctx.providerSessionRef })
  } as unknown as NativeCliProviderAdapter;
  const freshConnection = { send: () => {}, close: () => {} };
  let redials = 0;
  const live = {
    id: nativeCliSessionId,
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
  internal.live.set(nativeCliSessionId, live);

  await internal.appServerConnections.reconnect(nativeCliSessionId);

  expect(redials).toBe(1);
  expect(live.appServer).toBe(freshConnection); // swapped to the fresh connection
  expect(live.pendingRequests.size).toBe(0); // stale request ids from the dropped socket cleared
  expect(initCalls).toEqual([{ providerSessionRef: 'codex-thread-resume' }]); // re-init resumes the thread
});

test('native CLI app-server gives up instead of reconnecting forever when the transport keeps reopening but the handshake keeps failing', async () => {
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
  const host = new NativeCliHost({ store: createStore(), bus, agents: async () => [] });
  const nativeCliSessionId = 'ncli_reconnect_churn_test';
  const adapter = {
    provider: 'openclaw',
    productIcon: 'openclaw',
    parseOutput: () => [],
    initialize: () => {},
    stop: () => {}
  } as unknown as NativeCliProviderAdapter;

  let redials = 0;
  // Comfortably past any reasonable churn cap — if the host's own cap doesn't fire, this backstop keeps
  // the test from looping forever, and the assertions below fail loudly instead.
  const MAX_DRIVER_ITERATIONS = 30;
  const internal = host as unknown as {
    live: Map<string, unknown>;
    appServerConnections: { handleDisconnect(id: string): void };
  };
  const live = {
    id: nativeCliSessionId,
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
        setTimeout(() => internal.appServerConnections.handleDisconnect(nativeCliSessionId), 20);
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
  internal.live.set(nativeCliSessionId, live);

  internal.appServerConnections.handleDisconnect(nativeCliSessionId);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && internal.live.has(nativeCliSessionId)) {
    await Bun.sleep(100);
  }

  expect(internal.live.has(nativeCliSessionId)).toBe(false); // gave up — not stuck reconnecting forever
  expect(redials).toBeGreaterThan(1); // retried more than once (not just fast-failed on the first drop)
  expect(redials).toBeLessThan(MAX_DRIVER_ITERATIONS); // the HOST's own cap fired, not the driver's backstop
  expect(events).toContain('native_cli.connection_required'); // user-visible signal, not a silent hang
}, 20_000);

test('native CLI app-server disconnect during initial startup redials before failing, and exhaustion still rejects the pending startup', async () => {
  // Locks in the `handleAppServerDisconnect` reorder's intent: a drop while `live.startup` is still
  // pending gets a few redial attempts (a slow-starting gateway shouldn't fail on its very first
  // handshake attempt), but if the handshake never succeeds, the session still fails — not hangs.
  const host = new NativeCliHost({ store: createStore(), bus: new EventBus(), agents: async () => [] });
  const id = 'ncli_pending_startup_churn_test';
  const adapter = {
    provider: 'openclaw',
    productIcon: 'openclaw',
    parseOutput: () => [],
    initialize: () => {},
    stop: () => {}
  } as unknown as NativeCliProviderAdapter;
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

test('native CLI input throws instead of silently vanishing into a stale connection while the app-server is reconnecting', () => {
  // Between a socket drop and a completed redial, `live.appServer` still references the dead connection
  // (`reconnectAppServer` only reassigns it on success) — it stays truthy, so a naive `!appServer` guard
  // wouldn't catch this window. `input()` must fail loudly instead of silently sending into the void.
  const host = new NativeCliHost({ store: createStore(), bus: new EventBus(), agents: async () => [] });
  const id = 'ncli_reconnect_input_test';
  let sent = 0;
  const adapter = {
    provider: 'openclaw',
    productIcon: 'openclaw',
    parseOutput: () => [],
    sendInput: () => {
      sent++;
    }
  } as unknown as NativeCliProviderAdapter;
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

  expect(() => host.input(id, { input: 'hello' })).toThrow(/reconnecting/i);
  expect(sent).toBe(0); // never reached the stale connection
});

test('managed native CLI observation restores Codex provider history from persisted pointers', async () => {
  const store = createStore();
  const host = new NativeCliHost({
    store,
    bus: new EventBus(),
    agents: async () => []
  });
  const projectId = 'prj_01KWHOSTTEST0000000000002';
  const nativeCliSessionId = 'ncli_host_unavailable_test';
  const testRun = `monad-native-cli-host-${Date.now()}`;
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
  store.upsertNativeCliSession({
    id: nativeCliSessionId,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: nativeCliSessionId,
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
    await expect(host.observeWithProviderHistory(nativeCliSessionId)).resolves.toMatchObject({
      state: 'history',
      nativeCliSessionId,
      provider: 'codex',
      output: expect.stringContaining('restored from provider history')
    });
  } finally {
    rmSync(rolloutDir, { recursive: true, force: true });
  }
});

test('managed native CLI observation prefers Codex CLI history over rollout fallback', async () => {
  const root = join(homedir(), '.codex', 'sessions', '2099', '01', `monad-native-cli-host-cli-${Date.now()}`);
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
  const nativeCliSessionId = 'ncli_host_cli_history_test';
  const agent: NativeCliAgentView = {
    name: 'codex',
    provider: 'codex',
    command: script,
    enabled: true,
    defaultLaunchMode: 'app-server',
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
  const host = new NativeCliHost({
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
  store.upsertNativeCliSession({
    id: nativeCliSessionId,
    transcriptTargetId: projectId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: workdir,
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: nativeCliSessionId,
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
    const observation = await host.observeWithProviderHistory(nativeCliSessionId);
    expect(observation).toMatchObject({
      state: 'history',
      nativeCliSessionId,
      provider: 'codex',
      output: expect.stringContaining('restored through codex cli')
    });
    expect(observation).not.toMatchObject({ output: expect.stringContaining('stale rollout fallback') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed native CLI observation restores Claude Code provider history', async () => {
  const root = join(homedir(), '.claude', 'projects', `monad-native-cli-host-claude-${Date.now()}`);
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
  const nativeCliSessionId = 'ncli_host_claude_history_test';
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => [] });
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host Claude history test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertNativeCliSession({
    id: nativeCliSessionId,
    transcriptTargetId: projectId,
    agentName: 'claude',
    provider: 'claude-code',
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: nativeCliSessionId,
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
    await expect(host.observeWithProviderHistory(nativeCliSessionId)).resolves.toMatchObject({
      state: 'history',
      nativeCliSessionId,
      provider: 'claude-code',
      output: expect.stringContaining('restored claude history')
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed native CLI observation restores Gemini checkpoint history', async () => {
  const root = join(homedir(), '.gemini', 'tmp', `monad-native-cli-host-gemini-${Date.now()}`, 'chats');
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
  const nativeCliSessionId = 'ncli_host_gemini_history_test';
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => [] });
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host Gemini history test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertNativeCliSession({
    id: nativeCliSessionId,
    transcriptTargetId: projectId,
    agentName: 'gemini',
    provider: 'gemini',
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: nativeCliSessionId,
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
    await expect(host.observeWithProviderHistory(nativeCliSessionId)).resolves.toMatchObject({
      state: 'history',
      nativeCliSessionId,
      provider: 'gemini',
      output: expect.stringContaining('restored gemini history')
    });
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('managed native CLI observation restores Qwen stream-json history', async () => {
  const root = join(homedir(), '.qwen', 'monad-native-cli-host', String(Date.now()));
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
  const nativeCliSessionId = 'ncli_host_qwen_history_test';
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => [] });
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Host Qwen history test',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });
  store.upsertNativeCliSession({
    id: nativeCliSessionId,
    transcriptTargetId: projectId,
    agentName: 'qwen',
    provider: 'qwen',
    workingPath: '/tmp/project',
    launchMode: 'json-stream',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: nativeCliSessionId,
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
    await expect(host.observeWithProviderHistory(nativeCliSessionId)).resolves.toMatchObject({
      state: 'history',
      nativeCliSessionId,
      provider: 'qwen',
      output: expect.stringContaining('restored qwen history')
    });
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('native CLI usage returns empty records when the adapter has no usage probe', async () => {
  const host = new NativeCliHost({
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
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => [] });
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
    state: NativeCliSessionState,
    startedAt: string,
    outputSnapshot = ''
  ): void =>
    store.upsertNativeCliSession({
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
    'ncli_run_a',
    'prj_01KWLIVE0000000000000001',
    'openclaw',
    'running',
    '2026-07-02T00:00:01.000Z',
    'noisy output'
  );
  insertSession('ncli_start_b', 'prj_01KWLIVE0000000000000002', 'hermes', 'starting', '2026-07-02T00:00:02.000Z');
  insertSession('ncli_stop_a', 'prj_01KWLIVE0000000000000001', 'codex', 'stopped', '2026-07-02T00:00:03.000Z');
  insertSession('ncli_exit_b', 'prj_01KWLIVE0000000000000002', 'qwen', 'exited', '2026-07-02T00:00:04.000Z');

  const live = host.listLive().sessions;
  expect(live.map((s) => s.id)).toEqual(['ncli_run_a', 'ncli_start_b']);
  expect(live.every((s) => s.state === 'running' || s.state === 'starting')).toBe(true);
  // spans multiple projects and surfaces framework (openclaw/hermes) providers, not just native CLIs
  expect(new Set(live.map((s) => s.transcriptTargetId)).size).toBe(2);
  expect(live.map((s) => s.provider).sort()).toEqual(['hermes', 'openclaw']);
  // status-only list: output snapshots are stripped so the poll ships no output buffers
  expect(live.every((s) => s.outputSnapshot === '')).toBe(true);
});

// cli-oneshot launch mode: the session has NO persistent process; each turn spawns a fresh CLI with
// the directive baked into argv (`<cmd> --yolo -z <directive>`) and streams its stdout into the
// transcript. Proves Hermes-style providers (no app-server backend) run as managed members.
test('cli-oneshot session has no persistent process and runs a fresh CLI per turn', async () => {
  const store = createStore();
  const mockCli = new URL('../fixtures/mock-oneshot-cli.ts', import.meta.url).pathname;
  const workdir = mkdtempSync(join(tmpdir(), 'cli-oneshot-'));
  const agent: NativeCliAgentView = {
    name: 'hermes',
    provider: 'hermes',
    command: process.execPath,
    args: [mockCli],
    enabled: true,
    defaultLaunchMode: 'cli-oneshot',
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => [agent] });
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
    expect(view.pid).toBeNull();

    const observedOutput = (): string => {
      const obs = host.observe(view.id);
      return obs && 'output' in obs ? (obs.output ?? '') : '';
    };
    host.input(view.id, { input: 'ping' });
    // Wait for the per-turn process to spawn, echo, and exit.
    for (let i = 0; i < 40 && !observedOutput().includes('oneshot-reply'); i++) {
      await Bun.sleep(50);
    }
    expect(observedOutput()).toContain('oneshot-reply: ping');
    host.stop(view.id);
    expect(host.list(projectId).sessions[0]?.state).toBe('stopped');
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

function seedApprovalLiveSession(
  host: NativeCliHost,
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
  store.upsertNativeCliSession({
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
  } as unknown as NativeCliProviderAdapter;
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
          a: NativeCliProviderAdapter
        ): void;
      };
    }
  ).outputPipeline.output(projectId, id, '{"approval":1}\n', 'stdout', adapter);
  return { resolveCalls, live };
}

test('a delegated managed session projects the provider approval and relays the human decision', () => {
  const store = createStore();
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => [] });
  const id = 'ncli_approval_delegate';
  const { resolveCalls, live } = seedApprovalLiveSession(host, store, {
    projectId: 'prj_01KWHOSTAPPROVE000000000A',
    id,
    proxyApprovals: true
  });

  // Projected, not auto-denied: it is registered as pending and the provider was not resolved yet.
  expect(live.pendingApprovals.has('req-1')).toBe(true);
  expect(resolveCalls).toHaveLength(0);

  host.resolveApproval(id, { requestId: 'req-1', allow: true });
  expect(resolveCalls).toEqual([{ allow: true, reason: undefined }]);
  expect(live.pendingApprovals.has('req-1')).toBe(false);
});

test('an autopilot managed session auto-denies a leaked provider approval', () => {
  const store = createStore();
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => [] });
  const { resolveCalls, live } = seedApprovalLiveSession(host, store, {
    projectId: 'prj_01KWHOSTAPPROVE000000000B',
    id: 'ncli_approval_autopilot',
    proxyApprovals: false
  });

  expect(resolveCalls).toEqual([
    { allow: false, reason: 'managed project native CLI provider approvals are disabled' }
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
  const testAdapter: NativeCliProviderAdapter = {
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
  const agents: NativeCliAgentView[] = [
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
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => agents, monadHome });
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

    const autopilotArgv = await readArgvOnceReady(autopilotArgvFile);
    const delegatedArgv = await readArgvOnceReady(delegatedArgvFile);

    // This is the process's OWN argv, read back from the file IT wrote after spawning — proof the
    // flag actually reached the real OS process, not just the in-memory launch spec.
    expect(autopilotArgv).toContain('--test-autopilot-flag');
    expect(delegatedArgv).not.toContain('--test-autopilot-flag');

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
  const agent: NativeCliAgentView = {
    name: opts.provider,
    provider: opts.provider,
    command,
    args: [...scriptArgs, `--argv-out=${outFile}`],
    enabled: true,
    defaultLaunchMode: opts.launchMode,
    allowAutopilot: true,
    approvalOwnership: 'provider-owned'
  };
  const host = new NativeCliHost({ store, bus: new EventBus(), agents: async () => [agent], monadHome });
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
    const autopilotArgv = await runRealAdapterArgvCapture({
      provider: 'codex',
      launchMode: 'app-server',
      allowAutopilot: true
    });
    const delegatedArgv = await runRealAdapterArgvCapture({
      provider: 'codex',
      launchMode: 'app-server',
      allowAutopilot: false
    });
    expect(autopilotArgv).toContain('--ask-for-approval never');
    expect(delegatedArgv).not.toContain('--ask-for-approval');
  }
);

test('the real Qwen adapter spawns json-stream with --approval-mode=yolo only in autopilot', async () => {
  const autopilotArgv = await runRealAdapterArgvCapture({
    provider: 'qwen',
    launchMode: 'json-stream',
    allowAutopilot: true
  });
  const delegatedArgv = await runRealAdapterArgvCapture({
    provider: 'qwen',
    launchMode: 'json-stream',
    allowAutopilot: false
  });
  expect(autopilotArgv).toContain('--approval-mode=yolo');
  expect(delegatedArgv).not.toContain('--approval-mode=yolo');
});

// Skipped on Windows: claude's stream-json buildLaunch unshifts `-p` before `agent.args`, so the
// win32 `bun <script>` fallback would put `-p` between `bun` and the script path, which bun would
// try (and fail) to interpret as its own CLI flag rather than passing it through to the script.
test.skipIf(process.platform === 'win32')(
  'the real Claude Code adapter cannot delegate: --dangerously-skip-permissions is always present',
  async () => {
    const autopilotArgv = await runRealAdapterArgvCapture({
      provider: 'claude-code',
      launchMode: 'json-stream',
      allowAutopilot: true
    });
    const delegatedArgv = await runRealAdapterArgvCapture({
      provider: 'claude-code',
      launchMode: 'json-stream',
      allowAutopilot: false
    });
    // Claude Code's adapter has no resolvable approval channel over json-stream, so the capability
    // lock keeps it on autopilot regardless of the requested setting — proven here at the real-process
    // level, not just via the adapter capability-matrix unit test.
    expect(autopilotArgv).toContain('--dangerously-skip-permissions');
    expect(delegatedArgv).toContain('--dangerously-skip-permissions');
  }
);
