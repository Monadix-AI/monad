import type { ChannelDefinition, ManifestAtomPackHost } from '../../src/index.ts';

import { expect, test } from 'bun:test';

import echoAtomPack, { echoChannelAtom } from '../../examples/echo/atom-pack.ts';
import { createChannelTestHarness, loadManifestAtomPack } from '../../src/index.ts';

function host(): ManifestAtomPackHost & { channels: ChannelDefinition[] } {
  const channels: ChannelDefinition[] = [];
  return {
    channels,
    registerConnector: () => {},
    registerChannel: (c) => channels.push(c as ChannelDefinition),
    registerCommand: () => {},
    registerMessageType: () => {}
  };
}

test('echo example: the atom pack registers its channel (atom kind declared)', async () => {
  const h = host();
  await loadManifestAtomPack(echoAtomPack, h);
  expect(h.channels.map((c) => c.type)).toEqual(['echo']);
});

test('echo example: the adapter loops an outbound back as a normalized inbound', async () => {
  const harness = createChannelTestHarness(echoChannelAtom);
  await harness.adapter.send('chat1', 'hello');
  expect(harness.received.length).toBe(1);
  expect(harness.received[0]?.text).toBe('↩ hello');
  expect(harness.received[0]?.chatId).toBe('chat1');
  // the guard prevents a second hop
  await harness.adapter.send('chat1', '↩ hello');
  expect(harness.received.length).toBe(1);
});
