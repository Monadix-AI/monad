import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentProviderAdapter, PerTurnProviderDriver } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { EventBus } from '#/services/event-bus.ts';
import { AUTH_STATUS_TIMEOUT_MS } from '#/services/mesh-agent/constants.ts';
import { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';
import { registerAgentAdapterImpl, unregisterAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { resolveMeshAgentManagedServerUrl } from '#/services/mesh-agent/managed-server-url.ts';
import { createStore } from '#/store/db/index.ts';

const events = builtinAgentAdapters[0]?.events;
if (!events) throw new Error('built-in MeshAgent event source is required');

function agent(provider: string, command = process.execPath, args: string[] = []): MeshAgentView {
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
    productIcon: 'codex',
    label: 'Auth Timeout',
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Auth Timeout',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000);'],
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
    parseAuthStatus: () => 'unknown'
  };
  registerAgentAdapterImpl(adapter);
  const host = new MeshAgentHost({
    store: createStore(),
    bus: new EventBus(),
    agents: async () => [agent(provider, process.execPath, ['-e', 'setInterval(() => {}, 1000);'])],
    authStatusTimeoutMs: 50
  });
  try {
    await expect(host.authStatus(provider)).rejects.toMatchObject({ code: 'provider_timeout' });
  } finally {
    host.stopAll();
    unregisterAgentAdapterImpl(provider);
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
    productIcon: 'codex',
    label: 'Session Event Test',
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Session Event Test',
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
  const store = createStore();
  const host = new MeshAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [agent(provider, process.execPath, [script])]
  });
  try {
    const view = await host.start({
      transcriptTargetId: 'ses_01KWRUNTIME0',
      agentName: provider,
      workingPath: workdir
    });
    expect({ lifecycle: view.lifecycle, activity: view.activity }).toEqual({
      lifecycle: { state: 'active' },
      activity: { state: 'idle', pid: null, queuedTurnCount: 0 }
    });
    await host.input(view.id, { input: 'hello' });
    expect({ accepted, turns }).toEqual({ accepted: ['structured-event'], turns: [0] });
    host.stop(view.id);
    expect(store.getMeshSession(view.id)?.state).toBe('stopped');
  } finally {
    host.stopAll();
    unregisterAgentAdapterImpl(provider);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('MeshAgent host rejects providers without a resumable structured session-event runtime', async () => {
  const provider = `no-session-events-${Date.now()}`;
  const adapter: MeshAgentProviderAdapter = {
    provider,
    productIcon: 'terminal',
    label: 'No Session Events',
    events,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'terminal',
      label: 'No Session Events',
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
    host.stopAll();
    unregisterAgentAdapterImpl(provider);
  }
});
