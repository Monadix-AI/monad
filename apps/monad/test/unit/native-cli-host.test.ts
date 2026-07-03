import type { NativeCliProviderAdapter } from '@/services/native-cli/types.ts';

import { expect, test } from 'bun:test';

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

test('managed native CLI observation reports unavailable when only persisted pointers remain', () => {
  const store = createStore();
  const host = new NativeCliHost({
    store,
    bus: new EventBus(),
    agents: async () => []
  });
  const projectId = 'prj_01KWHOSTTEST0000000000002';
  const nativeCliSessionId = 'ncli_host_unavailable_test';
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

  expect(host.observe(nativeCliSessionId)).toEqual({
    state: 'unavailable',
    nativeCliSessionId,
    provider: 'codex',
    reason: 'provider history unavailable'
  });
});
