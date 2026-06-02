import type {
  AtomPackManifest,
  ChannelDefinition,
  Connector,
  HookDefinition,
  ManifestAtomPack,
  ManifestAtomPackHost
} from '../../src/index.ts';

import { expect, test } from 'bun:test';

import { defineAtomPack, defineChannel, loadManifestAtomPack, UndeclaredAtomError } from '../../src/index.ts';

const SDK_VERSION = '0';

function manifest(over: Partial<AtomPackManifest>): AtomPackManifest {
  return { name: 'p', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: [], ...over };
}

function collectingHost(): ManifestAtomPackHost & {
  connectors: Connector[];
  channels: ChannelDefinition[];
  hooks: HookDefinition[];
} {
  const connectors: Connector[] = [];
  const channels: ChannelDefinition[] = [];
  const hooks: HookDefinition[] = [];
  return {
    connectors,
    channels,
    hooks,
    registerConnector: (c) => connectors.push(c),
    registerChannel: (c) => channels.push(c as ChannelDefinition),
    registerCommand: () => {},
    registerMessageType: () => {},
    registerHook: (h) => hooks.push(h)
  };
}

const dummyHook: HookDefinition = { event: 'BeforeTool', handler: () => {} };

const dummyConnector: Connector = { name: 'c', scopes: [], start: async () => {}, stop: async () => {} };
const dummyChannelAtom = defineChannel({
  type: 'echo',
  name: 'Echo',
  capabilities: {
    edit: false,
    typing: false,
    threads: false,
    maxMessageChars: 1000,
    markdown: false,
    reactions: false,
    nativeCommands: false,
    outboundMirror: false
  },
  create: () => ({
    type: 'echo',
    capabilities: {
      edit: false,
      typing: false,
      threads: false,
      maxMessageChars: 1000,
      markdown: false,
      reactions: false,
      nativeCommands: false,
      outboundMirror: false
    },
    connect: async () => {},
    disconnect: async () => {},
    send: async (chatId) => ({ ref: '1', chatId })
  })
});

test('an atom pack registering a DECLARED atom kind succeeds', async () => {
  const host = collectingHost();
  const pack: ManifestAtomPack = {
    manifest: manifest({ atoms: ['channel'] }),
    register: (ctx) => ctx.registerChannel(dummyChannelAtom)
  };
  await loadManifestAtomPack(pack, host);
  expect(host.channels.length).toBe(1);
});

test('registering an UNDECLARED atom kind throws UndeclaredAtomError', async () => {
  const host = collectingHost();
  const pack: ManifestAtomPack = {
    // declares only 'channel' — but tries to register a connector
    manifest: manifest({ name: 'sneaky', atoms: ['channel'] }),
    register: (ctx) => ctx.registerConnector(dummyConnector)
  };
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
  expect(host.connectors.length).toBe(0); // nothing leaked through
});

test('UndeclaredAtomError names the atom kind and atom pack', async () => {
  const host = collectingHost();
  const pack: ManifestAtomPack = {
    manifest: manifest({ name: 'sneaky', atoms: [] }),
    register: (ctx) => ctx.registerConnector(dummyConnector)
  };
  try {
    await loadManifestAtomPack(pack, host);
    throw new Error('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(UndeclaredAtomError);
    expect((err as UndeclaredAtomError).atom).toBe('connector');
    expect((err as UndeclaredAtomError).atomPack).toBe('sneaky');
  }
});

test('defineAtomPack sugar still enforces — an undeclared payload array throws on load', async () => {
  const host = collectingHost();
  // provides a channel but forgets to declare the 'channel' atom kind
  const pack = defineAtomPack({ manifest: manifest({ atoms: [] }), channels: [dummyChannelAtom] });
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
});

test('defineAtomPack sugar routes declared payloads to the host', async () => {
  const host = collectingHost();
  const pack = defineAtomPack({
    manifest: manifest({ atoms: ['connector', 'channel'] }),
    connectors: [dummyConnector],
    channels: [dummyChannelAtom]
  });
  await loadManifestAtomPack(pack, host);
  expect(host.connectors.length).toBe(1);
  expect(host.channels.length).toBe(1);
});

test('a declared `hook` atom routes to the host', async () => {
  const host = collectingHost();
  const pack = defineAtomPack({ manifest: manifest({ atoms: ['hook'] }), hooks: [dummyHook] });
  await loadManifestAtomPack(pack, host);
  expect(host.hooks.length).toBe(1);
  expect(host.hooks[0]?.event).toBe('BeforeTool');
});

test('registering a hook WITHOUT the `hook` atom kind throws', async () => {
  const host = collectingHost();
  const pack = defineAtomPack({ manifest: manifest({ name: 'sneaky', atoms: [] }), hooks: [dummyHook] });
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
  expect(host.hooks.length).toBe(0);
});
