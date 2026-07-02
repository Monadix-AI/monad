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
