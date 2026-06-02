import { expect, test } from 'bun:test';

import { MeshAgentSessionUsageHub } from '#/services/mesh-agent/host/session-usage-hub.ts';

test('session usage hub publishes only live in-memory updates', () => {
  const hub = new MeshAgentSessionUsageHub();
  const received: unknown[] = [];
  const subscription = hub.subscribe('mesh-1', (usage) => received.push(usage));

  const delivered = hub.publish('mesh-1', {
    total: 30,
    input: 20,
    output: 10,
    context: { used: 12, window: 100 }
  });
  subscription.dispose();
  const ignored = hub.publish('mesh-1', { total: 40, input: 25, output: 15 });

  expect({ delivered, ignored, received }).toEqual({
    delivered: true,
    ignored: false,
    received: [{ total: 30, input: 20, output: 10, context: { used: 12, window: 100 } }]
  });
});
