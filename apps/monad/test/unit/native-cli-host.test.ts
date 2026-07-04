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
      emitManagedProjectOutput(
        transcriptTargetId: string,
        id: string,
        text: string,
        error?: boolean,
        post?: boolean
      ): void;
    }
  ).emitManagedProjectOutput('prj_01KWHOSTTEST0000000000000', 'ncli_host_test', 'No action needed.', false, false);
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
      output(
        transcriptTargetId: string,
        id: string,
        chunk: string,
        stream: 'stdout' | 'stderr' | 'pty',
        adapter: NativeCliProviderAdapter
      ): void;
    }
  ).live.set(nativeCliSessionId, live);
  (
    host as unknown as {
      output(
        transcriptTargetId: string,
        id: string,
        chunk: string,
        stream: 'stdout' | 'stderr' | 'pty',
        adapter: NativeCliProviderAdapter
      ): void;
    }
  ).output(projectId, nativeCliSessionId, '{"type":"result","result":"secret"}\n', 'stdout', adapter);
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
    output(t: string, id: string, chunk: string, stream: string, adapter: NativeCliProviderAdapter): void;
  };
  internal.live.set(nativeCliSessionId, live);

  const frames: { output?: string; append?: string; seq?: number }[] = [];
  const sub = host.subscribeObservation(nativeCliSessionId, (access) => {
    if (access.state === 'live') frames.push({ output: access.output, append: access.append, seq: access.seq });
  });
  // The initial access is a full snapshot (empty output so far).
  expect(sub.access.state).toBe('live');

  internal.output(projectId, nativeCliSessionId, 'Hello, ', 'stdout', adapter);
  await Bun.sleep(250);
  internal.output(projectId, nativeCliSessionId, 'world!', 'stdout', adapter);
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
    output(t: string, id: string, chunk: string, stream: string, adapter: NativeCliProviderAdapter): void;
  };
  internal.live.set(id, live);
  internal.output(live.transcriptTargetId, id, 'Hello, ', 'stdout', adapter);
  internal.output(live.transcriptTargetId, id, 'world!', 'stdout', adapter);

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
    reconnectAppServer(id: string): Promise<void>;
  };
  internal.live.set(nativeCliSessionId, live);

  await internal.reconnectAppServer(nativeCliSessionId);

  expect(redials).toBe(1);
  expect(live.appServer).toBe(freshConnection); // swapped to the fresh connection
  expect(live.pendingRequests.size).toBe(0); // stale request ids from the dropped socket cleared
  expect(initCalls).toEqual([{ providerSessionRef: 'codex-thread-resume' }]); // re-init resumes the thread
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
    allowDangerousMode: false,
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
        allowDangerousMode: false,
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
    allowDangerousMode: false,
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
