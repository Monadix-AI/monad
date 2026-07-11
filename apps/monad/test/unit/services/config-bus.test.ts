import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { ConfigBus } from '#/services/config-bus.ts';

test('routes external publish through reload request and delivers accepted snapshots separately', async () => {
  const events: string[] = [];
  const cfg = createDefaultConfig('usr_test' as never, 'Test');
  const snapshot = { cfg, auth: null };
  const bus = new ConfigBus(
    () => {},
    async () => void events.push('reload')
  );
  bus.subscribe(() => void events.push('delivered'));

  await bus.publish(snapshot);
  await bus.deliver(snapshot);

  expect(events).toEqual(['reload', 'delivered']);
});
