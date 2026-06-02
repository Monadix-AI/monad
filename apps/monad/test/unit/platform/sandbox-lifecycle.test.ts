import type { MonadPaths } from '@monad/environment';
import type { ConfigSnapshot } from '#/config/manager.ts';
import type { SandboxSetup } from '#/platform/sandbox/service.ts';
import type { KvService } from '#/services/kv.ts';
import type { SessionSandboxService } from '#/services/session-sandbox.ts';
import type { Store } from '#/store/db/index.ts';
import type { DataLayer } from '#/store/lifecycle.ts';

import { afterEach, expect, test } from 'bun:test';
import { createDefaultConfig, emptyAuth } from '@monad/environment';
import {
  configureProtectedCredentialResolver,
  configureProtectedExecutionTls,
  configureSandboxLauncher,
  noneLauncher,
  protectedExecutionAvailable,
  resolveProtectedExecutionForAgent
} from '@monad/sandbox';

import { ConfigManager } from '#/config/manager.ts';
import { createSandboxLifecycleModule } from '#/platform/sandbox/lifecycle.ts';
import { RuntimeContext } from '#/runtime/context.ts';

afterEach(() => {
  configureProtectedCredentialResolver(undefined);
  configureProtectedExecutionTls(false);
  configureSandboxLauncher(noneLauncher);
});

test('creates the required sandbox module from config and store dependencies', async () => {
  const cfg = createDefaultConfig('Test');
  const initial: ConfigSnapshot = { cfg, auth: null };
  const paths = { workspace: '/workspace' } as MonadPaths;
  const layer = { kv: {} as KvService, store: {} as Store, stop: async () => {} } satisfies DataLayer;
  const setup: SandboxSetup = {
    effectiveSandboxMode: 'workspace',
    sandboxRoots: ['/workspace'],
    sessionSandbox: {} as SessionSandboxService
  };
  const calls: Array<{ auth: unknown; cfg: unknown; paths: unknown; store: unknown }> = [];
  const context = new RuntimeContext();
  context.commit('store', layer);
  const module = createSandboxLifecycleModule({ initial, paths }, async (nextCfg, nextPaths, store, auth) => {
    calls.push({ auth, cfg: nextCfg, paths: nextPaths, store });
    return setup;
  });

  const output = await module.start(context, new AbortController().signal);

  expect({ calls, criticality: module.criticality, id: module.id, output, requires: module.requires }).toEqual({
    calls: [{ auth: undefined, cfg, paths, store: layer.store }],
    criticality: 'required',
    id: 'platform.sandbox',
    output: setup,
    requires: ['store']
  });
});

test('owns the live Credential resolver through reload and clears it on stop', async () => {
  const agentId = 'agt_00000000LIFE' as const;
  const credentialId = 'cred_000000LIFE';
  const cfg = createDefaultConfig('Test');
  cfg.sandbox.tlsTerminate.enabled = true;
  cfg.agent.agents = [
    {
      id: agentId,
      name: 'Lifecycle Agent',
      capabilities: [],
      credentialIds: [credentialId],
      declaredScopes: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    }
  ];
  const auth = emptyAuth();
  auth.credentials[credentialId] = {
    label: 'Lifecycle',
    environmentVariable: 'LIFECYCLE_TOKEN',
    secret: 'lifecycle-secret-one',
    allowedHosts: ['api.example.com'],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z'
  };
  const initial: ConfigSnapshot = { cfg, auth };
  const config = new ConfigManager({
    initial,
    source: {
      load: async () => null,
      saveAuth: async () => {},
      saveConfig: async () => {}
    },
    apply: async () => {}
  });
  const paths = { workspace: '/workspace' } as MonadPaths;
  const layer = { kv: {} as KvService, store: {} as Store, stop: async () => {} } satisfies DataLayer;
  const setup: SandboxSetup = {
    effectiveSandboxMode: 'workspace',
    sandboxRoots: ['/workspace'],
    sessionSandbox: {} as SessionSandboxService
  };
  const context = new RuntimeContext();
  context.commit('store', layer);
  configureSandboxLauncher({
    kind: 'lifecycle-safe',
    descriptor: { name: 'Lifecycle safe' },
    enforces: { readDeny: true, net: ['filtered'] },
    wrap: (argv) => argv
  });
  const module = createSandboxLifecycleModule({ initial, paths, config: () => config }, async () => setup);

  const output = await module.start(context, new AbortController().signal);
  const first = (await resolveProtectedExecutionForAgent(agentId)).credentials;
  await config.updateAuth((nextAuth) => {
    if (!nextAuth) throw new Error('test auth missing');
    const nextCredential = nextAuth.credentials[credentialId];
    if (!nextCredential) throw new Error('test credential missing');
    nextCredential.secret = 'lifecycle-secret-two';
    return nextAuth;
  });
  const second = (await resolveProtectedExecutionForAgent(agentId)).credentials;
  await config.updateConfig((nextCfg) => {
    nextCfg.sandbox.tlsTerminate.enabled = false;
    return nextCfg;
  });
  const unavailableAfterReload = protectedExecutionAvailable();
  await config.updateConfig((nextCfg) => {
    nextCfg.sandbox.tlsTerminate.enabled = true;
    return nextCfg;
  });

  expect({
    available: protectedExecutionAvailable(),
    first: first.map((credential) => credential.secret),
    firstFrozen: Object.isFrozen(first) && Object.isFrozen(first[0]),
    second: second.map((credential) => credential.secret),
    unavailableAfterReload
  }).toEqual({
    available: true,
    first: ['lifecycle-secret-one'],
    firstFrozen: true,
    second: ['lifecycle-secret-two'],
    unavailableAfterReload: false
  });

  await module.stop?.(output, context);
  await config.stop();
  expect(protectedExecutionAvailable()).toBe(false);
  await expect(resolveProtectedExecutionForAgent(agentId)).rejects.toThrow('protected_execution_unavailable');
});

test('rolls back protected globals when sandbox startup fails', async () => {
  configureProtectedCredentialResolver(async () => ({
    credentials: [],
    credentialVaultContainsSecrets: false
  }));
  configureProtectedExecutionTls(true);
  configureSandboxLauncher({
    kind: 'stale-safe',
    descriptor: { name: 'Stale safe' },
    enforces: { readDeny: true, net: ['filtered'] },
    wrap: (argv) => argv
  });
  const cfg = createDefaultConfig('Test');
  const initial: ConfigSnapshot = { cfg, auth: emptyAuth() };
  const context = new RuntimeContext();
  context.commit('store', {
    kv: {} as KvService,
    store: {} as Store,
    stop: async () => {}
  } satisfies DataLayer);
  const module = createSandboxLifecycleModule(
    { initial, paths: { workspace: '/workspace' } as MonadPaths },
    async () => {
      throw new Error('sandbox-start-canary');
    }
  );

  await expect(module.start(context, new AbortController().signal)).rejects.toThrow('sandbox-start-canary');
  expect(protectedExecutionAvailable()).toBe(false);
  await expect(resolveProtectedExecutionForAgent('agt_00000000FAIL')).rejects.toThrow(
    'protected_execution_unavailable'
  );
});
