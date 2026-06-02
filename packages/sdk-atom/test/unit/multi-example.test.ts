// The reference multi-atom pack (examples/multi) must register ALL four declared kinds through the
// gated loader in one pass — proving "one submission, many atoms" end-to-end at the SDK boundary.

import type { MessageTypeDescriptor } from '@monad/protocol';
import type { ManifestAtomPackHost, ModelProvider } from '../../src/index.ts';

import { expect, test } from 'bun:test';

import multiPack from '../../examples/multi/atom-pack.ts';
import { loadManifestAtomPack } from '../../src/index.ts';

function collectingHost() {
  const channels: string[] = [];
  const commands: unknown[] = [];
  const providers: ModelProvider[] = [];
  const messageTypes: { atomPackId: string; descriptor: MessageTypeDescriptor }[] = [];
  const host: ManifestAtomPackHost = {
    registerConnector: () => {},
    registerChannel: (c) => channels.push(c.type),
    registerCommand: (c) => commands.push(c),
    registerMessageType: (atomPackId, descriptor) => messageTypes.push({ atomPackId, descriptor }),
    registerProvider: (p) => providers.push(p),
    registerHook: () => {}
  };
  return { host, channels, commands, providers, messageTypes };
}

test('multi-demo pack registers channel + command + provider + message-type in one load', async () => {
  const h = collectingHost();
  await loadManifestAtomPack(multiPack, h.host);

  expect(h.channels).toEqual(['multi-demo']);
  expect(h.commands.length).toBe(1);
  expect(h.providers.map((p) => p.type)).toEqual(['multi-demo']);
  // The host namespaces a message type under the pack id (the daemon renders `<id>:badge`).
  expect(h.messageTypes.length).toBe(1);
  expect(h.messageTypes[0]?.atomPackId).toBe('multi-demo');
  expect(h.messageTypes[0]?.descriptor.type).toBe('badge');
});

test('manifest declares exactly the four kinds it registers', () => {
  expect([...multiPack.manifest.atoms].sort()).toEqual(['channel', 'command', 'message-type', 'provider']);
});
