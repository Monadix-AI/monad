import { expect, test } from 'bun:test';

import { readCoreRuntimeOutputs } from '#/application/core-runtime.ts';
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
