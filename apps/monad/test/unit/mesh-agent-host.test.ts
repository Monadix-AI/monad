import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentProviderAdapter, MeshAgentSessionStartInput, PerTurnProviderDriver } from '@monad/sdk-atom';
import type { MeshFixtureTap } from '#/services/mesh-agent/fixture-tap.ts';

import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { EventBus } from '#/services/event-bus.ts';
import { AUTH_STATUS_TIMEOUT_MS } from '#/services/mesh-agent/constants.ts';
import { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';
import { registerAgentAdapterImpl, unregisterAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { resolveMeshAgentManagedServerUrl } from '#/services/mesh-agent/managed-server-url.ts';
import { createStore } from '#/store/db/index.ts';

const events = builtinAgentAdapters[0]?.events;
if (!events) throw new Error('built-in MeshAgent event source is required');
const testBunExecutable = Bun.which('bun') ?? process.execPath;
const testCwd = tmpdir();

function agent(provider: string, command = testBunExecutable, args: string[] = []): MeshAgentView {
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

test('MeshAgent auth status probes use the bounded host timeout', async () => {
  expect(AUTH_STATUS_TIMEOUT_MS).toBe(20_000);
  const provider = `auth-timeout-${Date.now()}`;
  const adapter: MeshAgentProviderAdapter = {
    provider,
    icon: { title: 'Auth Timeout', path: 'M4 4h16v16H4z' },
    productIcon: 'codex',
    label: 'Auth Timeout',
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Auth Timeout',
      command: testBunExecutable,
      args: ['-e', 'setInterval(() => {}, 1000);'],
      installHint: 'Install test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: testCwd }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: testCwd }),
    authStatus: (configured) => ({
      launch: { argv: [configured.command, ...(configured.args ?? [])], cwd: testCwd },
      parse: () => 'unknown'
    }),
    parseAuthStatus: () => 'unknown'
  };
  registerAgentAdapterImpl(adapter);
  const host = new MeshAgentHost({
    store: createStore(),
    bus: new EventBus(),
    agents: async () => [agent(provider, testBunExecutable, ['-e', 'setInterval(() => {}, 1000);'])],
    authStatusTimeoutMs: 50
  });
  try {
    await expect(host.authStatus(provider)).rejects.toMatchObject({ code: 'provider_timeout' });
  } finally {
    await host.stopAll();
    unregisterAgentAdapterImpl(provider);
  }
});

test('MeshAgent session usage is rebuilt by the adapter for every request', async () => {
  const provider = `session-usage-${Date.now()}`;
  const runtimeAgentName = `pmem_${provider}`;
  let reads = 0;
  const adapter: MeshAgentProviderAdapter = {
    provider,
    icon: { title: 'Session Usage', path: 'M4 4h16v16H4z' },
    productIcon: 'codex',
    label: 'Session Usage',
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Session Usage',
      command: testBunExecutable,
      args: [],
      installHint: 'Install test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command], cwd: testCwd }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command], cwd: testCwd }),
    authStatus: (configured) => ({
      launch: { argv: [configured.command], cwd: testCwd },
      parse: () => 'unknown'
    }),
    parseAuthStatus: () => 'unknown',
    sessionUsage: {
      read: async () => {
        reads += 1;
        return { total: reads, input: reads, output: 0 };
      }
    }
  };
  registerAgentAdapterImpl(adapter);
  const store = createStore();
  store.upsertMeshSession({
    id: 'mesh_sessionusage01',
    transcriptTargetId: 'ses_sessionusage01',
    agentName: runtimeAgentName,
    provider,
    workingPath: '/tmp',
    runtimeRole: 'interactive',
    agentRuntimeId: null,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'stopped',
    pid: null,
    providerSessionRef: 'thread-1',
    outputSnapshot: '',
    exitCode: 0,
    startedAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    exitedAt: '2026-07-30T00:00:00.000Z'
  });
  const host = new MeshAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [agent(provider)]
  });
  try {
    expect([await host.sessionUsage('mesh_sessionusage01'), await host.sessionUsage('mesh_sessionusage01')]).toEqual([
      { total: 1, input: 1, output: 0 },
      { total: 2, input: 2, output: 0 }
    ]);
  } finally {
    await host.stopAll();
    unregisterAgentAdapterImpl(provider);
  }
});

test('MeshAgent session usage returns no data before the provider session reference is available', async () => {
  const provider = `session-usage-absent-${Date.now()}`;
  let reads = 0;
  const adapter: MeshAgentProviderAdapter = {
    provider,
    icon: { title: 'Session Usage Absent', path: 'M4 4h16v16H4z' },
    productIcon: 'codex',
    label: 'Session Usage Absent',
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Session Usage Absent',
      command: testBunExecutable,
      args: [],
      installHint: 'Install test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command], cwd: testCwd }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command], cwd: testCwd }),
    authStatus: (configured) => ({
      launch: { argv: [configured.command], cwd: testCwd },
      parse: () => 'unknown'
    }),
    parseAuthStatus: () => 'unknown',
    sessionUsage: {
      read: async () => {
        reads += 1;
        return { total: 1, input: 1, output: 0 };
      }
    }
  };
  registerAgentAdapterImpl(adapter);
  const store = createStore();
  store.upsertMeshSession({
    id: 'mesh_usageabsent01',
    transcriptTargetId: 'ses_usageabsent01',
    agentName: provider,
    provider,
    workingPath: '/tmp',
    runtimeRole: 'interactive',
    agentRuntimeId: null,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'stopped',
    pid: null,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: 0,
    startedAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    exitedAt: '2026-07-30T00:00:00.000Z'
  });
  const host = new MeshAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [agent(provider)]
  });
  try {
    const usage = await host.sessionUsage('mesh_usageabsent01');
    expect({ reads, usage }).toEqual({ reads: 0, usage: null });
  } finally {
    await host.stopAll();
    unregisterAgentAdapterImpl(provider);
  }
});

test('developer fixture capture requires and uses only the explicit canonical directory', async () => {
  const monadHome = mkdtempSync(join(tmpdir(), 'monad-host-fixture-directory-'));
  const canonical = join(monadHome, 'logs', 'mesh-agent-fixture-capture');
  const legacy = join(monadHome, 'fixtures', 'mesh-observation');
  const deps = { store: createStore(), bus: new EventBus(), agents: async () => [], developerMode: true, monadHome };

  expect(() => new MeshAgentHost(deps)).toThrow('meshFixtureCaptureDirectory is required in developer mode');
  const host = new MeshAgentHost({
    ...deps,
    meshAgentLiveStoreDirectory: join(monadHome, 'live'),
    meshLiveEventLogsDirectory: join(monadHome, 'logs', 'live-events'),
    meshFixtureCaptureDirectory: canonical
  });
  try {
    const tap = (host as unknown as { fixtureTap?: MeshFixtureTap }).fixtureTap;
    if (!tap) throw new Error('developer fixture tap was not installed');
    tap.record({
      provider: 'codex',
      meshSessionId: 'mesh_100000000001',
      observationEpoch: 'oep_100000000001',
      stream: 'stdout',
      payload: '{"type":"session_meta","payload":{}}\n',
      observedAt: '2026-07-21T00:00:00.000Z'
    });
    await tap.flush('mesh_100000000001', 'oep_100000000001');

    expect({ canonicalFiles: readdirSync(canonical), legacyExists: existsSync(legacy) }).toEqual({
      canonicalFiles: ['codex-mesh_100000000001-oep_100000000001.jsonl'],
      // presence-ok: explicit capture publication created only the canonical directory
      legacyExists: false
    });
  } finally {
    await host.stopAll();
    rmSync(monadHome, { recursive: true, force: true });
  }
});

test('managed MeshAgent server URL follows daemon HTTPS and explicit overrides', () => {
  expect(resolveMeshAgentManagedServerUrl({ networkHttps: { enabled: true }, port: 53210 })).toBe(
    'https://127.0.0.1:53210'
  );
  expect(
    resolveMeshAgentManagedServerUrl({
      serverUrl: 'http://127.0.0.1:59999',
      networkHttps: { enabled: true },
      port: 53210
    })
  ).toBe('http://127.0.0.1:59999');
});

test('MeshAgent host runs only the provider session-event runtime', async () => {
  const provider = `session-event-${Date.now()}`;
  const workdir = mkdtempSync(join(tmpdir(), 'monad-host-session-event-'));
  const script = join(workdir, 'provider.ts');
  writeFileSync(script, "console.log('structured-event');");
  const accepted: string[] = [];
  const turns: Array<number | null> = [];
  let runtimeStartInput: MeshAgentSessionStartInput | undefined;
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
    async attachTurnChannel() {},
    async accept(packet, sink) {
      accepted.push(new TextDecoder().decode(packet.bytes).trim());
      await sink.emit({ type: 'agent_message', payload: { text: 'ok', final: true } });
    },
    async completeTurn(result) {
      turns.push(result.exitCode);
    },
    async dispose() {}
  };
  const adapter: MeshAgentProviderAdapter = {
    provider,
    icon: { title: 'Session Event Test', path: 'M4 4h16v16H4z' },
    productIcon: 'codex',
    label: 'Session Event Test',
    managedRuntime: { usesManagedMcpBridge: true },
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Session Event Test',
      command: testBunExecutable,
      args: [script],
      installHint: 'Install test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: testCwd }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: testCwd }),
    authStatus: (configured) => ({
      launch: { argv: [configured.command, ...(configured.args ?? [])], cwd: testCwd },
      parse: () => 'unknown'
    }),
    parseAuthStatus: () => 'unknown',
    createSessionRuntime: (configured, context) => {
      runtimeStartInput = context.startInput;
      return {
        plan: {
          processModel: 'per-turn',
          buildTurnLaunch: () => ({ args: configured.args ?? [], cwd: context.workingPath }),
          encodeTurnInput: () => ({ delivery: 'stdin', bytes: new Uint8Array() }),
          startup: { timeoutMs: 1_000 },
          continuation: { strategy: 'provider-session-ref' }
        },
        driver
      };
    }
  };
  registerAgentAdapterImpl(adapter);
  const store = createStore();
  // A managed runtime is owned by a ProjectMember with an active SessionBinding — the host establishes
  // ownership before the initial turn opens, so the fixture must provide that binding.
  const at = '2026-06-30T00:00:00.000Z';
  store.insertWorkplaceProject({
    id: 'prj_hostruntime0',
    title: 'Host runtime',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: at,
    updatedAt: at
  });
  store.insertSession({
    id: 'ses_01KWRUNTIME0',
    projectId: 'prj_hostruntime0',
    title: 'Host runtime',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    activityAt: at,
    createdAt: at,
    updatedAt: at
  });
  store.insertProjectMember({
    id: 'pmem_hostagent',
    projectId: 'prj_hostruntime0',
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
    sessionId: 'ses_01KWRUNTIME0',
    projectMemberId: 'pmem_hostagent',
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: 'active',
    createdAt: at,
    updatedAt: at
  });
  const bus = new EventBus();
  const turnEvents: Array<{ type: string; payload: unknown }> = [];
  const dispose = bus.subscribe('ses_01KWRUNTIME0', (event) => {
    if (event.type === 'mesh.turn_started') {
      turnEvents.push({ type: event.type, payload: event.payload });
    }
  });
  const host = new MeshAgentHost({
    store,
    bus,
    agents: async () => [agent(provider, testBunExecutable, [script])]
  });
  try {
    const view = await host.start({
      transcriptTargetId: 'ses_01KWRUNTIME0',
      projectId: 'prj_hostruntime0',
      agentName: provider,
      projectMemberId: 'pmem_hostagent',
      runtimeRole: 'managed-project-agent',
      workingPath: workdir,
      initialInput: 'initial message'
    });
    expect({ lifecycle: view.lifecycle, activity: view.activity }).toEqual({
      lifecycle: { state: 'active' },
      activity: { state: 'idle', pid: null, queuedTurnCount: 0 }
    });
    const expectedPromptFile = join(
      dirname(realpathSync(workdir)),
      'workplace',
      'prj_hostruntime0',
      'runtime',
      'ses_01KWRUNTIME0',
      'pmem_hostagent',
      'GEMINI.md'
    );
    expect(runtimeStartInput).toEqual({
      immutableInstructions: { file: expectedPromptFile, text: readFileSync(expectedPromptFile, 'utf8') },
      initialTurn: { text: 'initial message', attachments: [] }
    });
    await host.input(view.id, { input: 'later message' });
    expect({ accepted, turns, turnEvents }).toEqual({
      accepted: ['structured-event', 'structured-event'],
      turns: [0, 0],
      turnEvents: [{ type: 'mesh.turn_started', payload: { meshSessionId: view.id } }]
    });
    await host.stop(view.id);
    expect(store.getMeshSession(view.id)?.state).toBe('stopped');
  } finally {
    dispose();
    await host.stopAll();
    unregisterAgentAdapterImpl(provider);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('MeshAgent host rejects providers without a resumable structured session-event runtime', async () => {
  const provider = `no-session-events-${Date.now()}`;
  const adapter: MeshAgentProviderAdapter = {
    provider,
    icon: { title: 'No Session Events', path: 'M4 4h16v16H4z' },
    productIcon: 'terminal',
    label: 'No Session Events',
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'terminal',
      label: 'No Session Events',
      command: testBunExecutable,
      args: [],
      installHint: 'Install test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: testCwd }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command, ...(configured.args ?? [])], cwd: testCwd }),
    authStatus: (configured) => ({
      launch: { argv: [configured.command, ...(configured.args ?? [])], cwd: testCwd },
      parse: () => 'unknown'
    }),
    parseAuthStatus: () => 'unknown'
  };
  registerAgentAdapterImpl(adapter);
  const host = new MeshAgentHost({ store: createStore(), bus: new EventBus(), agents: async () => [agent(provider)] });
  try {
    await expect(
      host.start({ transcriptTargetId: 'ses_01KWRUNTIME1', agentName: provider, workingPath: '/tmp' })
    ).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: 'MeshAgent provider "No Session Events" does not expose a resumable structured session-event runtime'
    });
  } finally {
    await host.stopAll();
    unregisterAgentAdapterImpl(provider);
  }
});
