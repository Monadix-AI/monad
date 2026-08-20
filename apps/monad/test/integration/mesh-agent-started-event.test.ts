import type { Event, MeshAgentView } from '@monad/protocol';
import type { MeshAgentProviderAdapter, PerTurnProviderDriver } from '@monad/sdk-atom';

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

test('a managed runtime announces mesh.started before its opening turn settles', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monad-mesh-started-')));
  const provider = `started-event-${crypto.randomUUID()}`;
  let releaseTurn: (() => void) | undefined;
  const turnBlocked = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let turnAttached: (() => void) | undefined;
  const attached = new Promise<void>((resolve) => {
    turnAttached = resolve;
  });
  const driver: PerTurnProviderDriver = {
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
    async attachTurnChannel() {
      turnAttached?.();
      await turnBlocked;
    },
    async accept() {},
    async completeTurn() {},
    async dispose() {}
  };
  const adapter: MeshAgentProviderAdapter = {
    provider,
    icon: { title: 'Started Event Test', path: 'M4 4h16v16H4z' },
    productIcon: 'codex',
    label: 'Started Event Test',
    executionCapabilities: { autopilot: true, fastMode: false },
    managedRuntime: { usesManagedMcpBridge: true },
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Started Event Test',
      command: process.execPath,
      args: ['-e', ''],
      installHint: 'test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command], cwd: root }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command], cwd: root }),
    authStatus: (configured) => ({
      launch: { argv: [configured.command], cwd: root },
      parse: () => 'authenticated' as const
    }),
    parseAuthStatus: () => 'authenticated',
    deleteSession: () => {},
    createSessionRuntime: () => ({
      plan: {
        processModel: 'per-turn',
        buildTurnLaunch: () => ({ args: ['-e', ''], cwd: root }),
        encodeTurnInput: () => ({ delivery: 'stdin', bytes: new Uint8Array() }),
        startup: { timeoutMs: 5_000 },
        continuation: { strategy: 'provider-session-ref' }
      },
      driver
    })
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
    id: 'prj_startedevent',
    title: 'Started event',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: at,
    updatedAt: at
  });
  store.insertSession({
    id: 'ses_started00000',
    projectId: 'prj_startedevent',
    title: 'Started event',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    activityAt: at,
    createdAt: at,
    updatedAt: at
  });
  store.insertProjectMember({
    id: 'pmem_startedevent',
    projectId: 'prj_startedevent',
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
    sessionId: 'ses_started00000',
    projectMemberId: 'pmem_startedevent',
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: 'active',
    createdAt: at,
    updatedAt: at
  });
  const bus = new EventBus();
  const observed: Event['type'][] = [];
  const unsubscribe = bus.subscribeAll((event) => observed.push(event.type));
  const host = new MeshAgentHost({
    store,
    bus,
    agents: async () => [configuredAgent],
    monadHome: root,
    meshAgentLiveStoreDirectory: join(root, 'live')
  });
  try {
    const start = host.start({
      transcriptTargetId: 'ses_started00000',
      agentName: provider,
      templateAgentName: provider,
      projectMemberId: 'pmem_startedevent',
      workingPath: root,
      runtimeRole: 'managed-project-agent',
      allowAutopilot: true,
      initialInput: 'join the project'
    });
    await attached;
    expect(observed).toContain('mesh.started');
    expect(observed).toContain('mesh.turn_started');
    expect(observed).not.toContain('mesh.turn_settled');
    releaseTurn?.();
    const session = await start;
    expect(session.runtimeRole).toBe('managed-project-agent');
    expect(observed.filter((type) => type === 'mesh.started')).toHaveLength(1);
    expect(observed.filter((type) => type === 'mesh.turn_settled')).toHaveLength(1);
    await host.stop(session.id).catch(() => {});
  } finally {
    unsubscribe();
    unregisterAgentAdapterImpl(provider);
    await rm(root, { recursive: true, force: true });
  }
});
