import { expect, test } from 'bun:test';

import { ConfigReloadTargets } from '#/config/reload-targets.ts';

test('config reload targets apply application before network and use the latest targets', async () => {
  const events: string[] = [];
  const targets = new ConfigReloadTargets();
  const snapshot = { cfg: { locale: 'en' }, auth: null } as never;

  targets.setApplication(async () => {
    events.push('application:first');
  });
  targets.setApplication(async () => {
    events.push('application:latest');
  });
  targets.setNetwork(async () => {
    events.push('network');
  });

  await targets.apply(snapshot);

  expect(events).toEqual(['application:latest', 'network']);
});
