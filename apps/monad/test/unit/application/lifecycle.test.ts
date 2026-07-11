import { expect, test } from 'bun:test';

import { createApplicationLifecycleModule } from '#/application/lifecycle-module.ts';
import { RuntimeContext } from '#/runtime/context.ts';

test('application lifecycle receives core outputs and owns reload and stop', async () => {
  const events: string[] = [];
  const context = new RuntimeContext();
  const outputs = {
    store: { name: 'store' },
    sandbox: { name: 'sandbox' },
    model: { name: 'model' },
    capabilities: { name: 'capabilities' },
    atoms: { name: 'atoms' },
    skills: { name: 'skills' },
    mcp: { name: 'mcp' }
  };
  context.commit('store', outputs.store);
  context.commit('platform.sandbox', outputs.sandbox);
  context.commit('agent.model', outputs.model);
  context.commit('capabilities', outputs.capabilities);
  context.commit('atoms', outputs.atoms);
  context.commit('capabilities.skills', outputs.skills);
  context.commit('capabilities.mcp', outputs.mcp);

  const module = createApplicationLifecycleModule({
    start: async (core) => {
      expect(core).toEqual(outputs);
      return {
        reload: async (snapshot) => {
          events.push(`reload:${snapshot.cfg.locale}`);
        },
        stop: async () => {
          events.push('stop');
        }
      };
    }
  });

  const application = await module.start(context, new AbortController().signal);
  const snapshot = { cfg: { locale: 'zh-CN' }, auth: null } as never;
  await module.reload?.(application, snapshot, context, new AbortController().signal);
  await module.stop?.(application, context);

  expect(events).toEqual(['reload:zh-CN', 'stop']);
});
