import type {
  MeshAgentView,
  MeshSessionId,
  ProjectMember,
  Session,
  SessionId,
  WorkplaceProject
} from '@monad/protocol';
import type { MeshAgentProviderAdapter, PerTurnProviderDriver, ResidentProviderDriver } from '@monad/sdk-atom';
import type { SessionEventRuntimeActivation } from '#/services/mesh-agent/session-event-runtime/types.ts';
import type { MeshSessionUpsert } from '#/store/db/mesh-sessions.ts';

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { EventBus } from '#/services/event-bus.ts';
import { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';
import { registerAgentAdapterImpl, unregisterAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { createStore } from '#/store/db/index.ts';

const events = builtinAgentAdapters[0]?.events;
if (!events) throw new Error('built-in MeshAgent event source is required');

const now = '2026-07-28T00:00:00.000Z';
const SESSION_ID = 'ses_ownership001';
const MEMBER_ID = 'pmem_owner';

const project: WorkplaceProject = {
  id: 'prj_ownership000',
  title: 'Ownership',
  state: 'active',
  archived: false,
  memberTemplates: [],
  createdAt: now,
  updatedAt: now
};
const member: ProjectMember = {
  id: MEMBER_ID,
  projectId: project.id,
  profileId: 'codex',
  type: 'mesh-agent',
  displayName: 'Owner',
  customPrompt: null,
  launchOverrides: {},
  workingDirectoryOverride: null,
  lifecycle: 'enabled',
  createdAt: now,
  updatedAt: now
};
const session = {
  id: SESSION_ID,
  projectId: project.id,
  title: 'Ownership',
  state: 'active',
  agentIds: [],
  archived: false,
  restoreCount: 0,
  activityAt: now,
  createdAt: now,
  updatedAt: now
} as unknown as Session;

function agentView(provider: string, command: string, args: string[]): MeshAgentView {
  return {
    name: provider,
    provider,
    productIcon: 'codex',
    command,
    args,
    enabled: true,
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

// Builds a real host + store with a fake per-turn provider adapter. `onAccept` runs inside the child's
// first-turn `accept` — i.e. DURING runtime.open — so a test can observe store state at that instant.
// `openSessionThrows` makes runtime.open fail after ownership is established.
function buildManagedHost(opts: {
  seedBinding?: 'active' | 'suspended' | 'none';
  onAccept?: (store: ReturnType<typeof createStore>) => void;
  onDispose?: (store: ReturnType<typeof createStore>) => void;
  openSessionThrows?: boolean;
}): { host: MeshAgentHost; store: ReturnType<typeof createStore>; provider: string; workdir: string } {
  if (!events) throw new Error('built-in MeshAgent event source is required');
  const provider = `ownership-${Date.now()}-${Math.round(performance.now())}`;
  const workdir = mkdtempSync(join(tmpdir(), 'monad-ownership-'));
  const script = join(workdir, 'provider.ts');
  writeFileSync(script, "console.log('turn');");
  const store = createStore();
  store.insertWorkplaceProject(project);
  store.insertProjectMember(member);
  store.insertSession(session);
  if (opts.seedBinding && opts.seedBinding !== 'none') {
    store.insertSessionBinding({
      sessionId: SESSION_ID,
      projectMemberId: MEMBER_ID,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now
    });
    if (opts.seedBinding === 'suspended') {
      store.updateSessionBinding(SESSION_ID, MEMBER_ID, { lifecycle: 'suspended', updatedAt: now });
    }
  }
  const driver: PerTurnProviderDriver = {
    processModel: 'per-turn',
    controls: { approvalResolution: false, steer: false, interrupt: false },
    async openSession() {
      if (opts.openSessionThrows) throw new Error('provider open failed');
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
    async accept(_packet, sink) {
      opts.onAccept?.(store);
      await sink.emit({ type: 'agent_message', payload: { text: 'ok', final: true } });
    },
    async completeTurn() {},
    // Runs inside the launcher catch's `await runtime.close()`, before settleFailedManagedRuntime — the
    // seam a test uses to simulate a concurrent binding change during the start-failure cleanup window.
    async dispose() {
      opts.onDispose?.(store);
    }
  };
  const adapter: MeshAgentProviderAdapter = {
    deleteSession: async () => {},
    provider,
    icon: { title: 'Ownership Test', path: 'M4 4h16v16H4z' },
    productIcon: 'codex',
    label: 'Ownership Test',
    managedRuntime: { usesManagedMcpBridge: true },
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Ownership Test',
      command: process.execPath,
      args: [script],
      installHint: 'Install test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: '/tmp' }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: '/tmp' }),
    authStatus: (configured) => ({
      launch: { argv: [configured.command, ...(configured.args ?? [])], cwd: '/tmp' },
      parse: () => 'unknown'
    }),
    parseAuthStatus: () => 'unknown',
    createSessionRuntime: (configured, context) => ({
      plan: {
        processModel: 'per-turn',
        buildTurnLaunch: () => ({ args: configured.args ?? [], cwd: context.workingPath }),
        encodeTurnInput: () => ({ delivery: 'stdin', bytes: new Uint8Array() }),
        startup: { timeoutMs: 1_000 },
        continuation: { strategy: 'provider-session-ref' }
      },
      driver
    })
  };
  registerAgentAdapterImpl(adapter);
  const host = new MeshAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [agentView(provider, process.execPath, [script])]
  });
  cleanup = async () => {
    await host.stopAll();
    unregisterAgentAdapterImpl(provider);
    store.close();
    rmSync(workdir, { recursive: true, force: true });
  };
  return { host, store, provider, workdir };
}

async function startManaged(host: MeshAgentHost, provider: string, workdir: string) {
  return host.start({
    transcriptTargetId: SESSION_ID,
    agentName: provider,
    projectMemberId: MEMBER_ID,
    runtimeRole: 'managed-project-agent',
    workingPath: workdir,
    initialInput: 'initial message'
  });
}

test('ownership and the binding current pointer are established before the provider initial turn opens', async () => {
  let currentDuringOpen: string | null | undefined;
  const { host, store, provider, workdir } = buildManagedHost({
    seedBinding: 'active',
    onAccept: (s) => {
      currentDuringOpen = s.getSessionBinding(SESSION_ID, MEMBER_ID)?.currentNativeRuntimeSessionId ?? null;
    }
  });

  const view = await startManaged(host, provider, workdir);

  const binding = store.getSessionBinding(SESSION_ID, MEMBER_ID);
  expect({
    currentDuringOpen,
    runtimeOwner: store.getMeshSession(view.id)?.projectMemberId,
    bindingCurrent: binding?.currentNativeRuntimeSessionId,
    bindingLifecycle: binding?.lifecycle
  }).toEqual({
    // Observed from inside the first turn's accept → ownership+current were set BEFORE open drove the turn.
    currentDuringOpen: view.id,
    runtimeOwner: MEMBER_ID,
    bindingCurrent: view.id,
    bindingLifecycle: 'active'
  });
});

test('a managed start with no session binding fails closed and leaves no owned runtime', async () => {
  const { host, store, provider, workdir } = buildManagedHost({ seedBinding: 'none' });

  await expect(startManaged(host, provider, workdir)).rejects.toThrow('no active session binding');

  expect({
    binding: store.getSessionBinding(SESSION_ID, MEMBER_ID),
    ownedRuntimes: store.listMeshSessions().filter((r) => r.projectMemberId === MEMBER_ID).length
  }).toEqual({ binding: null, ownedRuntimes: 0 });
});

test('a managed start against a non-active binding fails closed and does not attach the runtime', async () => {
  const { host, store, provider, workdir } = buildManagedHost({ seedBinding: 'suspended' });

  await expect(startManaged(host, provider, workdir)).rejects.toThrow('no active session binding');

  const binding = store.getSessionBinding(SESSION_ID, MEMBER_ID);
  expect({
    bindingCurrent: binding?.currentNativeRuntimeSessionId,
    bindingLifecycle: binding?.lifecycle,
    ownedRuntimes: store.listMeshSessions().filter((r) => r.projectMemberId === MEMBER_ID).length
  }).toEqual({ bindingCurrent: null, bindingLifecycle: 'suspended', ownedRuntimes: 0 });
});

test('a managed start that fails after ownership clears the binding current and records failed health', async () => {
  const { host, store, provider, workdir } = buildManagedHost({ seedBinding: 'active', openSessionThrows: true });

  await expect(startManaged(host, provider, workdir)).rejects.toThrow('provider open failed');

  const binding = store.getSessionBinding(SESSION_ID, MEMBER_ID);
  const ownedStates = store
    .listMeshSessions()
    .filter((r) => r.projectMemberId === MEMBER_ID)
    .map((r) => r.state);
  expect({
    bindingCurrent: binding?.currentNativeRuntimeSessionId,
    bindingHealth: binding?.lastHealth,
    bindingLifecycle: binding?.lifecycle,
    ownedStates
  }).toEqual({
    // A failed runtime is never left as a binding's current attachment; health reflects the terminal state,
    // and the runtime it owned is terminal.
    bindingCurrent: null,
    bindingHealth: 'failed',
    bindingLifecycle: 'active',
    ownedStates: ['failed']
  });
});

test('stopping a managed runtime settles the owning binding: current cleared and terminal health recorded', async () => {
  const { host, store, provider, workdir } = buildManagedHost({ seedBinding: 'active' });

  const view = await startManaged(host, provider, workdir);
  // Ownership was established at start, so the binding points at this runtime.
  const bound = store.getSessionBinding(SESSION_ID, MEMBER_ID);
  if (bound?.currentNativeRuntimeSessionId !== view.id) throw new Error('runtime was not owned before stop');

  await host.stop(view.id);

  const binding = store.getSessionBinding(SESSION_ID, MEMBER_ID);
  expect({
    current: binding?.currentNativeRuntimeSessionId,
    health: binding?.lastHealth,
    lifecycle: binding?.lifecycle,
    runtimeState: store.getMeshSession(view.id)?.state
  }).toEqual({ current: null, health: 'stopped', lifecycle: 'active', runtimeState: 'stopped' });
});

function managedRuntimeRow(id: string, state: MeshSessionUpsert['state'] = 'running'): MeshSessionUpsert {
  return {
    id: id as MeshSessionId,
    transcriptTargetId: SESSION_ID as SessionId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/workspace',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: id,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state,
    pid: 123,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: now,
    updatedAt: now,
    exitedAt: null
  };
}

test('a concurrent leave during the start-failure cleanup await is not clobbered by the failed OLD settle', async () => {
  let currentAtDispose: string | null | undefined;
  const { host, store, provider, workdir } = buildManagedHost({
    seedBinding: 'active',
    openSessionThrows: true,
    onDispose: (s) => {
      // Fires inside the catch's `await runtime.close()`, BEFORE the failed row is settled. Capturing the
      // binding's current here proves the settle has not run yet (the OLD runtime is still current), so the
      // leave genuinely races INSIDE the cleanup window — not by timing luck after it.
      currentAtDispose = s.getSessionBinding(SESSION_ID, MEMBER_ID)?.currentNativeRuntimeSessionId ?? null;
      s.leaveSessionBinding(SESSION_ID, MEMBER_ID, '2026-07-28T00:05:00.000Z');
    }
  });

  await expect(startManaged(host, provider, workdir)).rejects.toThrow('provider open failed');

  const binding = store.getSessionBinding(SESSION_ID, MEMBER_ID);
  const ownedStates = store
    .listMeshSessions()
    .filter((r) => r.projectMemberId === MEMBER_ID)
    .map((r) => r.state);
  expect({
    // A managed runtime was still the binding's current when the leave fired — i.e. before the settle ran.
    disposeSawOwnedCurrent: typeof currentAtDispose === 'string' && currentAtDispose.startsWith('mesh_'),
    lifecycle: binding?.lifecycle,
    current: binding?.currentNativeRuntimeSessionId,
    // 'starting' (the pre-leave health), NOT 'failed' — proving the settle CAS-missed. Were the order
    // reversed (settle before leave), this would be 'failed'.
    health: binding?.lastHealth,
    ownedStates
  }).toEqual({
    disposeSawOwnedCurrent: true,
    lifecycle: 'left',
    current: null,
    health: 'starting',
    ownedStates: ['failed']
  });
});

test('a replacement taking over current during start-failure cleanup is not clobbered by the failed OLD settle', async () => {
  const NEW_ID = 'mesh_replacement1';
  const { host, store, provider, workdir } = buildManagedHost({
    seedBinding: 'active',
    openSessionThrows: true,
    onDispose: (s) => {
      // A fresh runtime re-owns the binding's current during the failed OLD's cleanup window.
      s.upsertMeshSession(managedRuntimeRow(NEW_ID));
      s.replaceSessionBindingRuntime({
        sessionId: SESSION_ID,
        projectMemberId: MEMBER_ID,
        currentNativeRuntimeSessionId: NEW_ID as MeshSessionId,
        updatedAt: '2026-07-28T00:05:00.000Z'
      });
    }
  });

  await expect(startManaged(host, provider, workdir)).rejects.toThrow('provider open failed');

  const binding = store.getSessionBinding(SESSION_ID, MEMBER_ID);
  expect({
    current: binding?.currentNativeRuntimeSessionId,
    health: binding?.lastHealth,
    lifecycle: binding?.lifecycle,
    newRuntimeOwner: store.getMeshSession(NEW_ID)?.projectMemberId
  }).toEqual({
    // The replacement owns current; the failed OLD settle CAS-misses, so NEW's current and health survive.
    current: NEW_ID,
    health: 'running',
    lifecycle: 'active',
    newRuntimeOwner: MEMBER_ID
  });
});

// A mock activation whose child "process" has already exited — driving the resident monitor to a terminal
// 'failed' with no real process, so the provider-driven terminal path is deterministic.
function exitedResidentActivation(exitCode: number): SessionEventRuntimeActivation {
  return {
    process: {
      pid: 4242,
      async writeStdin() {},
      async closeStdin() {},
      async kill() {},
      result: Promise.resolve({ exitCode })
    },
    channel: { async send() {}, async close() {} },
    async *packets() {},
    async close() {}
  };
}

// A real MeshAgentHost whose managed runtime is RESIDENT and whose child exits on its own — the launcher's
// injected resourceFactory yields an already-exited activation, so onSnapshot receives a provider-driven
// terminal 'failed' (not via host.stop).
function buildResidentTerminalHost(): {
  host: MeshAgentHost;
  store: ReturnType<typeof createStore>;
  provider: string;
  workdir: string;
} {
  if (!events) throw new Error('built-in MeshAgent event source is required');
  const provider = `resident-${Date.now()}-${Math.round(performance.now())}`;
  const workdir = mkdtempSync(join(tmpdir(), 'monad-resident-'));
  const store = createStore();
  store.insertWorkplaceProject(project);
  store.insertProjectMember(member);
  store.insertSession(session);
  store.insertSessionBinding({
    sessionId: SESSION_ID,
    projectMemberId: MEMBER_ID,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now
  });
  const residentDriver: ResidentProviderDriver = {
    processModel: 'resident',
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
    async accept(_packet, sink) {
      await sink.emit({ type: 'agent_message', payload: { text: 'ok', final: true } });
    },
    async attachChannel() {
      return undefined;
    },
    async sendTurn() {},
    async dispose() {}
  };
  const adapter: MeshAgentProviderAdapter = {
    deleteSession: async () => {},
    provider,
    icon: { title: 'Launcher Ownership Test', path: 'M4 4h16v16H4z' },
    productIcon: 'codex',
    label: 'Resident Terminal Test',
    managedRuntime: { usesManagedMcpBridge: true },
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Resident Terminal Test',
      command: process.execPath,
      args: [],
      installHint: 'Install test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: '/tmp' }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: '/tmp' }),
    authStatus: (configured) => ({
      launch: { argv: [configured.command, ...(configured.args ?? [])], cwd: '/tmp' },
      parse: () => 'unknown'
    }),
    parseAuthStatus: () => 'unknown',
    createSessionRuntime: (_configured, context) => ({
      plan: {
        processModel: 'resident',
        launch: { args: [], cwd: context.workingPath },
        channel: { kind: 'child-stdio' },
        startup: { timeoutMs: 1_000 }
      },
      driver: residentDriver
    })
  };
  registerAgentAdapterImpl(adapter);
  const host = new MeshAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [agentView(provider, process.execPath, [])],
    resourceFactory: {
      async start() {
        return exitedResidentActivation(1);
      }
    }
  });
  cleanup = async () => {
    await host.stopAll();
    unregisterAgentAdapterImpl(provider);
    store.close();
    rmSync(workdir, { recursive: true, force: true });
  };
  return { host, store, provider, workdir };
}

test('a provider-driven terminal (resident process exit, no host.stop) auto-settles the owning binding', async () => {
  const { host, store, provider, workdir } = buildResidentTerminalHost();

  const view = await startManaged(host, provider, workdir);
  // The resident child has already exited → the resident monitor publishes a terminal 'failed' snapshot
  // asynchronously → the launcher's onSnapshot settles the binding. Wait for that settle (no host.stop).
  for (
    let i = 0;
    i < 200 && store.getSessionBinding(SESSION_ID, MEMBER_ID)?.currentNativeRuntimeSessionId !== null;
    i++
  ) {
    await Bun.sleep(1);
  }

  const binding = store.getSessionBinding(SESSION_ID, MEMBER_ID);
  expect({
    current: binding?.currentNativeRuntimeSessionId,
    health: binding?.lastHealth,
    lifecycle: binding?.lifecycle,
    runtimeState: store.getMeshSession(view.id)?.state
  }).toEqual({ current: null, health: 'failed', lifecycle: 'active', runtimeState: 'failed' });
});
