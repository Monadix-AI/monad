import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentProviderAdapter, MeshAgentSessionRuntimeContext, PerTurnProviderDriver } from '@monad/sdk-atom';
import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';

import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { EventBus } from '#/services/event-bus.ts';
import { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';
import { registerAgentAdapterImpl, unregisterAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { createStore } from '#/store/db/index.ts';

const events = builtinAgentAdapters[0]?.events;
if (!events) throw new Error('built-in MeshAgent event source is required');

async function removeRuntimeRoot(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 49) throw error;
      // biome-ignore lint/plugin: backoff inside a bounded retry loop; the next attempt is the condition, and Windows keeps directory handles open past the unlink.
      await Bun.sleep(100);
    }
  }
}

test('session-event launcher derives provider approval behavior from runtime role and member setting', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monad-mesh-approval-mode-')));
  const provider = `approval-mode-${crypto.randomUUID()}`;
  const contexts: Array<{ skipProviderApprovals?: boolean; speed?: 'standard' | 'fast' }> = [];
  const driver = (): PerTurnProviderDriver => ({
    processModel: 'per-turn',
    controls: { approvalResolution: false, steer: false, interrupt: false },
    async openSession() {
      return {
        capabilities: {
          input: true,
          steer: false,
          interrupt: false,
          approvalResolution: false,
          providerSessionContinuation: true,
          runtimeRestoration: true,
          sessionReopen: true
        }
      };
    },
    async attachTurnChannel() {},
    async accept() {},
    async completeTurn() {},
    async dispose() {}
  });
  const adapter: MeshAgentProviderAdapter = {
    deleteSession: async () => {},
    provider,
    icon: { title: 'Approval Mode Test', path: 'M4 4h16v16H4z' },
    productIcon: 'codex',
    label: 'Approval Mode Test',
    executionCapabilities: { autopilot: true, fastMode: true },
    managedRuntime: { usesManagedMcpBridge: true },
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Approval Mode Test',
      command: process.execPath,
      args: ['-e', ''],
      installHint: 'test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    modelOptions: () => ({
      resolve: async () => [
        { value: 'default', speeds: ['fast'] },
        { value: 'fast-model', speeds: ['fast'] },
        { value: 'standard-model' }
      ]
    }),
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command], cwd: root }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command], cwd: root }),
    authStatus: (configured) => ({
      launch: { argv: [configured.command], cwd: root },
      parse: () => 'authenticated'
    }),
    parseAuthStatus: () => 'authenticated',
    createSessionRuntime: (_agent, context: MeshAgentSessionRuntimeContext) => {
      contexts.push({ skipProviderApprovals: context.skipProviderApprovals, speed: context.speed });
      return {
        plan: {
          processModel: 'per-turn',
          buildTurnLaunch: () => ({ args: ['-e', ''], cwd: root }),
          encodeTurnInput: () => ({ delivery: 'stdin', bytes: new Uint8Array() }),
          startup: { timeoutMs: 1_000 },
          continuation: { strategy: 'provider-session-ref' }
        },
        driver: driver()
      };
    }
  };
  const configuredAgent: MeshAgentView = {
    name: provider,
    provider,
    productIcon: 'codex',
    command: process.execPath,
    args: ['-e', ''],
    enabled: true,
    allowAutopilot: true,
    approvalOwnership: 'provider-owned'
  };
  registerAgentAdapterImpl(adapter);
  const store = createStore();
  const at = new Date().toISOString();
  store.insertWorkplaceProject({
    id: 'prj_approvalmode',
    title: 'Approval mode',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: at,
    updatedAt: at
  });
  for (const [sessionId, memberId] of [
    ['ses_auto00000000', 'pmem_approvalauto'],
    ['ses_delg00000000', 'pmem_approvaldelegated']
  ] as const) {
    store.insertSession({
      id: sessionId,
      projectId: 'prj_approvalmode',
      title: 'Approval mode',
      state: 'active',
      agentIds: [],
      archived: false,
      restoreCount: 0,
      activityAt: at,
      createdAt: at,
      updatedAt: at
    });
    store.insertProjectMember({
      id: memberId,
      projectId: 'prj_approvalmode',
      profileId: provider,
      type: 'mesh-agent',
      displayName: provider,
      customPrompt: null,
      launchOverrides: {},
      workingDirectoryOverride: null,
      lifecycle: 'enabled',
      createdAt: at,
      updatedAt: at
    });
    store.insertSessionBinding({
      sessionId,
      projectMemberId: memberId,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      lifecycle: 'active',
      createdAt: at,
      updatedAt: at
    });
  }
  const host = new MeshAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [configuredAgent],
    monadHome: root,
    meshAgentLiveStoreDirectory: join(root, 'live')
  });
  try {
    const autopilot = await host.start({
      transcriptTargetId: 'ses_auto00000000',
      agentName: provider,
      projectMemberId: 'pmem_approvalauto',
      workingPath: root,
      runtimeRole: 'managed-project-agent',
      allowAutopilot: true,
      initialInput: 'autopilot'
    });
    const delegated = await host.start({
      transcriptTargetId: 'ses_delg00000000',
      agentName: provider,
      projectMemberId: 'pmem_approvaldelegated',
      workingPath: root,
      runtimeRole: 'managed-project-agent',
      allowAutopilot: false,
      initialInput: 'delegated'
    });
    const interactive = await host.start({
      transcriptTargetId: 'ses_intv00000000',
      agentName: provider,
      workingPath: root,
      runtimeRole: 'interactive',
      allowAutopilot: true
    });
    const fast = await host.start({
      transcriptTargetId: 'ses_fast00000000',
      agentName: provider,
      workingPath: root,
      runtimeRole: 'interactive',
      modelId: 'fast-model',
      speed: 'fast'
    });
    expect({ runtimeRole: fast.runtimeRole, speed: contexts[3]?.speed }).toEqual({
      runtimeRole: 'interactive',
      speed: 'fast'
    });
    const fastDefault = await host.start({
      transcriptTargetId: 'ses_fdef00000000',
      agentName: provider,
      workingPath: root,
      runtimeRole: 'interactive',
      speed: 'fast'
    });
    expect({ runtimeRole: fastDefault.runtimeRole, speed: contexts[4]?.speed }).toEqual({
      runtimeRole: 'interactive',
      speed: 'fast'
    });
    await expect(
      host.start({
        transcriptTargetId: 'ses_fast00000000',
        agentName: provider,
        workingPath: root,
        runtimeRole: 'interactive',
        modelId: 'standard-model',
        speed: 'fast'
      })
    ).rejects.toThrow('does not support fast mode for model "standard-model"');
    adapter.executionCapabilities = { autopilot: true, fastMode: false };
    await expect(
      host.start({
        transcriptTargetId: 'ses_fast00000000',
        agentName: provider,
        workingPath: root,
        runtimeRole: 'interactive',
        modelId: 'fast-model',
        speed: 'fast'
      })
    ).rejects.toThrow('does not support fast mode');
    adapter.executionCapabilities = { autopilot: false, fastMode: false };
    await expect(
      host.start({
        transcriptTargetId: 'ses_auto00000000',
        agentName: provider,
        projectMemberId: 'pmem_approvalauto',
        workingPath: root,
        runtimeRole: 'managed-project-agent',
        allowAutopilot: true,
        initialInput: 'unsupported autopilot'
      })
    ).rejects.toThrow('does not support autopilot');
    const live = (host as unknown as { live: Map<string, LiveMeshSession> }).live;

    expect(
      [
        [autopilot, contexts[0]],
        [delegated, contexts[1]],
        [interactive, contexts[2]]
      ].map(([session, context]) => {
        const view = session as typeof autopilot;
        return {
          runtimeRole: view.runtimeRole,
          skipProviderApprovals: (context as { skipProviderApprovals?: boolean }).skipProviderApprovals,
          approvalMode: live.get(view.id)?.approvalMode
        };
      })
    ).toEqual([
      {
        runtimeRole: 'managed-project-agent',
        skipProviderApprovals: true,
        approvalMode: 'autopilot'
      },
      {
        runtimeRole: 'managed-project-agent',
        skipProviderApprovals: false,
        approvalMode: 'delegated'
      },
      {
        runtimeRole: 'interactive',
        skipProviderApprovals: false,
        approvalMode: 'interactive'
      }
    ]);
  } finally {
    await host.stopAll();
    store.close();
    unregisterAgentAdapterImpl(provider);
    await removeRuntimeRoot(root);
  }
});
