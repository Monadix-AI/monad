import type { NativeCliAgentView } from '@monad/protocol';
import type { NativeCliProviderAdapter } from '@/services/native-cli/types.ts';

import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '@/services/event-bus.ts';
import { NativeCliHost } from '@/services/native-cli/host.ts';
import { createStore } from '@/store/db/index.ts';

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
    outputBuffer: '',
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
    `${JSON.stringify({ type: 'init', session_id: providerSessionRef })}\n${JSON.stringify({
      type: 'message',
      text: 'restored qwen history'
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
