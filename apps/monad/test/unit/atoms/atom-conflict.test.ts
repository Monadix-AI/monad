// Multi-atom conflict policy. Within a SINGLE load call (e.g. all third-party packs discovered
// together), two packs claiming the same channel/provider type must not silently clobber each
// other: the second is rejected + warned, the first survives, and the colliding pack's OTHER atoms
// still load. A pack that registers the same id twice is an authoring bug → the pack aborts.
// (Cross-CALL overrides — builtin vs discovered — are deliberate and handled by mergeRegistries.)

import type { MessageTypeDescriptor } from '@monad/protocol';
import type { ModelProvider, WorkspaceExperienceDefinition } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { unregisterMessageType } from '@monad/protocol';
import { defineAtomPack, defineChannel, defineProvider, SDK_VERSION } from '@monad/sdk-atom';
import { z } from 'zod';

import { loadChannelAtomPacks } from '#/channels/atom-pack-host.ts';
import { AtomPackRegistry } from '#/handlers/atom-pack/atom-pack-registry.ts';

const caps = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 1000,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: false
};

function channel(type: string) {
  return defineChannel({
    type,
    name: type,
    capabilities: caps,
    create: () => ({
      type,
      capabilities: caps,
      connect: async () => {},
      disconnect: async () => {},
      send: async (chatId: string) => ({ ref: '1', chatId })
    })
  });
}

function connector(name: string) {
  return { name, scopes: [], start: async () => {}, stop: async () => {} };
}

function provider(type: string): ModelProvider {
  return defineProvider({
    type,
    descriptor: { type, label: type, strategy: 'native' },
    // biome-ignore lint/correctness/useYield: stub
    async *stream() {
      throw new Error('unused');
    }
  });
}

const projectExperience: WorkspaceExperienceDefinition = {
  id: 'custom-workspace',
  title: 'Custom workspace',
  entry: { type: 'web-component', module: './workspace-experience.js', tagName: 'custom-workspace' }
};

function pack(name: string, opts: { channels?: string[]; providers?: string[] }) {
  return defineAtomPack({
    manifest: {
      name,
      version: '1.0.0',
      sdkVersion: SDK_VERSION,
      atoms: ['channel', 'provider']
    },
    channels: (opts.channels ?? []).map(channel),
    providers: (opts.providers ?? []).map(provider)
  });
}

test('cross-pack channel-type clash: namespace-coexist — both addressable, bare = first-wins, warned', async () => {
  const warnings: string[] = [];
  const providers: string[] = [];
  const channels = await loadChannelAtomPacks(
    [pack('first', { channels: ['shared'] }), pack('second', { channels: ['shared', 'other'], providers: ['pb'] })],
    { onProvider: (p) => providers.push(p.type), log: (lvl, msg) => lvl === 'warn' && warnings.push(msg) }
  );

  // both packs' channels remain addressable under qualified names; nothing is dropped
  expect(channels.has('first__shared')).toBe(true);
  expect(channels.has('second__shared')).toBe(true);
  // bare 'shared' resolves to first-wins (the 'first' pack); 'other' (unique) is bare too
  expect(channels.get('shared')).toBe(channels.get('first__shared'));
  expect(channels.has('other')).toBe(true);
  expect(providers).toEqual(['pb']);
});

test('onCollision emits structured conflicts for the UI (channel + connector)', async () => {
  const mixed = (name: string) =>
    defineAtomPack({
      manifest: { name, version: '1.0.0', sdkVersion: SDK_VERSION, atoms: ['channel', 'connector'] },
      channels: [channel('shared')],
      connectors: [connector('search')]
    });
  const conflicts: { kind: string; bareId: string; winner: string; shadowed: string[] }[] = [];
  await loadChannelAtomPacks([mixed('a'), mixed('b')], {
    onConnector: () => {},
    onCollision: (c) => conflicts.push(c)
  });
  expect(conflicts).toContainEqual({ kind: 'channel', bareId: 'shared', winner: 'a', shadowed: ['b'] });
  expect(conflicts).toContainEqual({ kind: 'connector', bareId: 'search', winner: 'a', shadowed: ['b'] });
});

test('channel pin overrides first-wins for the bare type', async () => {
  const channels = await loadChannelAtomPacks(
    [pack('first', { channels: ['shared'] }), pack('second', { channels: ['shared'] })],
    { channelPins: { shared: 'second' } }
  );
  // pin makes bare 'shared' resolve to the 'second' pack instead of first-wins ('first')
  expect(channels.get('shared')).toBe(channels.get('second__shared'));
  expect(channels.has('first__shared')).toBe(true); // the other is still addressable
});

test('same-pack duplicate id aborts that pack (authoring bug), others unaffected', async () => {
  const errors: { atomPack: string; error: unknown }[] = [];
  const channels = await loadChannelAtomPacks(
    [
      pack('dup', { channels: ['x', 'x'] }), // registers 'x' twice
      pack('clean', { channels: ['y'] })
    ],
    { onError: (atomPack, error) => errors.push({ atomPack, error }) }
  );

  expect(errors[0]?.atomPack).toBe('dup');
  // The clean pack is unaffected; both bare types resolve ('x' from dup's first registration, 'y').
  expect(channels.has('x')).toBe(true);
  expect(channels.has('y')).toBe(true);
});

test('cross-pack connector-name clash: first wins, second rejected + warned', async () => {
  const connPack = (name: string, connectors: string[]) =>
    defineAtomPack({
      manifest: { name, version: '1.0.0', sdkVersion: SDK_VERSION, atoms: ['connector'] },
      connectors: connectors.map(connector)
    });
  const warnings: string[] = [];
  const registered: string[] = [];
  await loadChannelAtomPacks([connPack('a', ['t1']), connPack('b', ['t1', 't2'])], {
    onConnector: (c) => registered.push(c.name),
    log: (lvl, msg) => lvl === 'warn' && warnings.push(msg)
  });
  // namespace-coexist: a's t1 wins the bare name; b's t1 is still reachable as 'b__t1'; b's t2 is bare
  expect(registered.sort()).toEqual(['b__t1', 't1', 't2']);
});

test('cross-pack connector-name clash: a pin makes the bare name resolve to the pinned pack', async () => {
  const connPack = (name: string, connectors: string[]) =>
    defineAtomPack({
      manifest: { name, version: '1.0.0', sdkVersion: SDK_VERSION, atoms: ['connector'] },
      connectors: connectors.map(connector)
    });
  const registered: string[] = [];
  await loadChannelAtomPacks([connPack('a', ['t1']), connPack('b', ['t1'])], {
    onConnector: (c) => registered.push(c.name),
    connectorPins: { t1: 'b' } // pin bare 't1' to pack b
  });
  // b wins the bare name; a's is reachable as 'a__t1'
  expect(registered.sort()).toEqual(['a__t1', 't1']);
});

// message-type: namespaced under packId, so cross-pack same type name is never a collision.
// Same-pack duplicate throws → pack aborts via onError; other packs load fine.
const MSG_TYPES_REGISTERED = ['dup-msg:badge', 'other-msg:badge'];
afterEach(() => {
  for (const t of MSG_TYPES_REGISTERED) unregisterMessageType(t);
});

test('provider is globally unique: a reserved (built-in) type is a hard error, aborts the pack', async () => {
  const errors: { atomPack: string; error: unknown }[] = [];
  const registered: string[] = [];
  await loadChannelAtomPacks([pack('shadower', { providers: ['openai'] })], {
    onProvider: (p) => registered.push(p.type),
    reservedProviderTypes: new Set(['openai']),
    onError: (atomPack, error) => errors.push({ atomPack, error })
  });
  expect(errors[0]?.atomPack).toBe('shadower');
  expect(String((errors[0]?.error as Error).message)).toMatch(/reserved by a built-in provider/i);
});

test('provider is globally unique: two packs claiming the same type → second is a hard error', async () => {
  const errors: { atomPack: string; error: unknown }[] = [];
  const registered: string[] = [];
  await loadChannelAtomPacks([pack('a', { providers: ['vend'] }), pack('b', { providers: ['vend'] })], {
    onProvider: (p) => registered.push(p.type),
    onError: (atomPack, error) => errors.push({ atomPack, error })
  });
  expect(registered).toEqual(['vend']); // a's wins; b's is not a silent first-wins skip but an error
  expect(errors[0]?.atomPack).toBe('b');
  expect(String((errors[0]?.error as Error).message)).toMatch(/globally unique/i);
});

test('message-type same-pack duplicate aborts that pack; cross-pack same name is fine', async () => {
  const errors: { atomPack: string; error: unknown }[] = [];

  const msgType = (type: string): MessageTypeDescriptor => ({
    type,
    dataSchema: z.unknown(),
    fallbacks: ['text'],
    includeInContext: true
  });

  const dupPack = defineAtomPack({
    manifest: { name: 'dup-msg', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: ['channel', 'message-type'] },
    channels: [channel('dup-ch')],
    messageTypes: [msgType('badge'), msgType('badge')] // same type twice → should throw
  });

  const otherPack = defineAtomPack({
    manifest: { name: 'other-msg', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: ['message-type'] },
    messageTypes: [msgType('badge')] // same name, different pack → 'other-msg:badge', fine
  });

  const channelMap = await loadChannelAtomPacks([dupPack, otherPack], {
    onError: (atomPack, error) => errors.push({ atomPack, error })
  });

  expect(errors[0]?.atomPack).toBe('dup-msg');
  expect(errors.length).toBe(1); // other-msg loaded fine
  expect(channelMap.has('dup-ch')).toBe(true); // dup-ch registered before the throw, survives
});

test('workspace-experience atoms are forwarded to the daemon sink', async () => {
  const registered: WorkspaceExperienceDefinition[] = [];
  const experiencePack = defineAtomPack({
    manifest: { name: 'px', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: ['workspace-experience'] },
    workspaceExperiences: [projectExperience]
  });

  await loadChannelAtomPacks([experiencePack], { onWorkspaceExperience: (experience) => registered.push(experience) });

  expect(registered).toEqual([projectExperience]);
});

test('workspace-experience duplicate ids are rejected by the daemon registry', () => {
  const registry = new AtomPackRegistry();
  registry.registerWorkspaceExperience(projectExperience, 'first-pack');

  expect(() =>
    registry.registerWorkspaceExperience({ ...projectExperience, title: 'Other custom workspace' }, 'second-pack')
  ).toThrow(/duplicate workspace experience id "custom-workspace"/);
  expect([...registry.workspaceExperiences.values()]).toEqual([{ ...projectExperience, atomPackId: 'first-pack' }]);
});

test('workspace-experience host component entries are first-party only', () => {
  const registry = new AtomPackRegistry();

  expect(() =>
    registry.registerWorkspaceExperience(
      {
        id: 'fake-chatroom',
        title: 'Fake chatroom',
        entry: { type: 'host-component', component: 'chat-room' }
      },
      'third-party'
    )
  ).toThrow(/host-only component entry/);
});

test('workspace-experience API routes must be registered by the experience owner', () => {
  const registry = new AtomPackRegistry();
  registry.registerWorkspaceExperience(projectExperience, 'owner-pack');

  expect(() =>
    registry.registerWorkspaceExperienceApi(
      {
        experienceId: 'custom-workspace',
        routes: [{ method: 'POST', path: '/search', handle: async () => Response.json({ owner: 'attacker-pack' }) }]
      },
      'attacker-pack'
    )
  ).toThrow(/workspace experience API route "POST \/search" for "custom-workspace" from "attacker-pack" is not owned/);

  const ownerHandler = async () => Response.json({ owner: 'owner-pack' });
  registry.registerWorkspaceExperienceApi(
    { experienceId: 'custom-workspace', routes: [{ method: 'POST', path: '/search', handle: ownerHandler }] },
    'owner-pack'
  );

  expect(registry.getWorkspaceExperienceApiHandler('custom-workspace', 'POST', '/search')).toBe(ownerHandler);
});

test('workspace-experience API routes cannot be preempted before the experience owner registers', () => {
  const registry = new AtomPackRegistry();

  expect(() =>
    registry.registerWorkspaceExperienceApi(
      {
        experienceId: 'custom-workspace',
        routes: [{ method: 'POST', path: '/search', handle: async () => Response.json({ owner: 'attacker-pack' }) }]
      },
      'attacker-pack'
    )
  ).toThrow(/unknown workspace experience id "custom-workspace"/);

  registry.registerWorkspaceExperience(projectExperience, 'owner-pack');
  const ownerHandler = async () => Response.json({ owner: 'owner-pack' });
  registry.registerWorkspaceExperienceApi(
    { experienceId: 'custom-workspace', routes: [{ method: 'POST', path: '/search', handle: ownerHandler }] },
    'owner-pack'
  );

  expect(registry.getWorkspaceExperienceApiHandler('custom-workspace', 'POST', '/search')).toBe(ownerHandler);
});

test('undeclared workspace-experience atoms are rejected during daemon atom loading', async () => {
  const registered: WorkspaceExperienceDefinition[] = [];
  const errors: { atomPack: string; error: unknown }[] = [];
  const experiencePack = defineAtomPack({
    manifest: { name: 'px-sneaky', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: [] },
    workspaceExperiences: [projectExperience]
  });

  await loadChannelAtomPacks([experiencePack], {
    onError: (atomPack, error) => errors.push({ atomPack, error }),
    onWorkspaceExperience: (experience) => registered.push(experience)
  });

  expect(errors[0]?.atomPack).toBe('px-sneaky');
  expect((errors[0]?.error as Error).name).toBe('UndeclaredAtomError');
});
