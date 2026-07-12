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

test('config reload targets run network when application reload fails and report the failure', async () => {
  const events: string[] = [];
  const targets = new ConfigReloadTargets();
  const snapshot = { cfg: { locale: 'en' }, auth: null } as never;
  targets.setApplication(() => {
    events.push('application');
    throw new Error('tool backend failed');
  });
  targets.setNetwork(async () => {
    events.push('network');
  });

  await expect(targets.apply(snapshot)).rejects.toThrow('application config reload failed: tool backend failed');
  expect(events).toEqual(['application', 'network']);
});
