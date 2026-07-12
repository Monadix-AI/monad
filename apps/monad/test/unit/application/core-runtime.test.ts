import { expect, test } from 'bun:test';

import { readCoreRuntimeOutputs, registerProviderWatcher } from '#/application/core-runtime.ts';
import { RuntimeContext } from '#/runtime/context.ts';

test('core runtime exposes domain outputs as one structured value', () => {
  const context = new RuntimeContext();
  const expected = {
    dataLayer: { id: 'store' },
    sandbox: { id: 'sandbox' },
    model: { id: 'model' },
    capabilities: { id: 'capabilities' },
    atoms: { id: 'atoms' },
    skills: { id: 'skills' },
    mcp: { id: 'mcp' }
  };
  context.commit('store', expected.dataLayer);
  context.commit('platform.sandbox', expected.sandbox);
  context.commit('agent.model', expected.model);
  context.commit('capabilities', expected.capabilities);
  context.commit('atoms', expected.atoms);
  context.commit('capabilities.skills', expected.skills);
  context.commit('capabilities.mcp', expected.mcp);

  expect(readCoreRuntimeOutputs(context) as unknown).toEqual(expected);
});

test('provider watcher reloads JavaScript provider atoms and reports each discovery error', async () => {
  let reload: () => Promise<void> = async () => {
    throw new Error('watch source was not registered');
  };
  const warnings: string[] = [];
  const discovered: string[] = [];

  registerProviderWatcher({
    providersPath: '/runtime/providers',
    watchService: {
      register(value) {
        expect([value.name, value.path, value.filter?.('provider.js'), value.filter?.('provider.json')]).toEqual([
          'providers',
          '/runtime/providers',
          true,
          false
        ]);
        reload = async () => value.onChange();
        return true;
      }
    },
    discoverProviders: async (path) => {
      discovered.push(path);
      return {
        loaded: [],
        errors: [
          { file: 'broken-a.js', error: 'invalid manifest' },
          { file: 'broken-b.js', error: 'registration failed' }
        ]
      };
    },
    warn: (message) => warnings.push(message)
  });

  await reload();
  expect(discovered).toEqual(['/runtime/providers']);
  expect(warnings).toEqual([
    'monad: provider atom "broken-a.js" failed to reload: invalid manifest',
    'monad: provider atom "broken-b.js" failed to reload: registration failed'
  ]);
});
