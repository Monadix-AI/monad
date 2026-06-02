import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';

import { expect, test } from 'bun:test';

import { MeshAgentObservationHub } from '#/services/mesh-agent/host/observation-hub.ts';

test('a lagging second subscriber receives its own catch-up signal', async () => {
  const live = {
    observationEpoch: 'epoch-1',
    outputSeq: 5,
    liveRawStore: {}
  } as LiveMeshSession;
  const hub = new MeshAgentObservationHub({ getLive: () => live });
  const first: unknown[] = [];
  const second: unknown[] = [];

  const firstSubscription = hub.subscribe('mesh-1', (signal) => first.push(signal), 5);
  const secondSubscription = hub.subscribe('mesh-1', (signal) => second.push(signal), 2);
  await Bun.sleep(25);

  expect(first).toEqual([]);
  expect(second).toEqual([{ state: 'live', observationEpoch: 'epoch-1', seq: 5 }]);
  firstSubscription.dispose();
  secondSubscription.dispose();
});
