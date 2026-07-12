import type { MonadPaths } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { ConfigSnapshot } from '#/config/service.ts';
import type { SandboxSetup } from '#/platform/sandbox/service.ts';
import type { KvService } from '#/services/kv.ts';
import type { SessionSandboxService } from '#/services/session-sandbox.ts';
import type { Store } from '#/store/db/index.ts';
import type { DataLayer } from '#/store/lifecycle.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { createSandboxLifecycleModule } from '#/platform/sandbox/lifecycle.ts';
import { RuntimeContext } from '#/runtime/context.ts';

test('creates the required sandbox module from config and store dependencies', async () => {
  const cfg = createDefaultConfig('usr_test' as PrincipalId, 'Test');
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
