import type {
  AtomPackManifest,
  ChannelDefinition,
  Connector,
  HookDefinition,
  ManifestAtomPack,
  ManifestAtomPackHost,
  WorkspaceExperienceApi,
  WorkspaceExperienceDefinition
} from '../../src/index.ts';

import { expect, test } from 'bun:test';

import {
  bindWorkspaceExperience,
  defineAtomPack,
  defineChannel,
  defineWorkspaceExperience,
  loadManifestAtomPack,
  UndeclaredAtomError,
  WORKSPACE_EXPERIENCE_UPDATE_EVENT
} from '../../src/index.ts';

const SDK_VERSION = '0';

function manifest(over: Partial<AtomPackManifest>): AtomPackManifest {
  return { name: 'p', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: [], ...over };
}

function collectingHost(): ManifestAtomPackHost & {
  connectors: Connector[];
  channels: ChannelDefinition[];
  hooks: HookDefinition[];
  workspaceExperienceApis: WorkspaceExperienceApi[];
  workspaceExperiences: WorkspaceExperienceDefinition[];
} {
  const connectors: Connector[] = [];
  const channels: ChannelDefinition[] = [];
  const hooks: HookDefinition[] = [];
  const workspaceExperienceApis: WorkspaceExperienceApi[] = [];
  const workspaceExperiences: WorkspaceExperienceDefinition[] = [];
  return {
    connectors,
    channels,
    hooks,
    workspaceExperienceApis,
    workspaceExperiences,
    registerConnector: (c) => connectors.push(c),
    registerChannel: (c) => channels.push(c as ChannelDefinition),
    registerCommand: () => {},
    registerMessageType: () => {},
    registerHook: (h) => hooks.push(h),
    registerWorkspaceExperienceApi: (api) => workspaceExperienceApis.push(api),
    registerWorkspaceExperience: (experience) => workspaceExperiences.push(experience)
  };
}

const dummyHook: HookDefinition = { event: 'BeforeTool', handler: () => {} };

const dummyConnector: Connector = { name: 'c', scopes: [], start: async () => {}, stop: async () => {} };
const dummyWorkspaceExperience: WorkspaceExperienceDefinition = {
  id: 'custom-workspace',
  title: 'Custom workspace',
  api: {
    routes: [{ method: 'POST', path: '/search' }]
  },
  entry: {
    module: './workspace-experience.js',
    tagName: 'custom-workspace',
    type: 'web-component'
  }
};
const dummyWorkspaceExperienceApi: WorkspaceExperienceApi = {
  experienceId: 'custom-workspace',
  routes: [
    {
      method: 'POST',
      path: '/search',
      handle: async () => Response.json({ ok: true })
    }
  ]
};
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

test('a declared `workspace-experience` atom routes to the host', async () => {
  const host = collectingHost();
  const pack = defineAtomPack({
    manifest: manifest({ atoms: ['workspace-experience'] }),
    workspaceExperienceApis: [dummyWorkspaceExperienceApi],
    workspaceExperiences: [dummyWorkspaceExperience]
  });
  await loadManifestAtomPack(pack, host);
  expect(host.workspaceExperiences).toEqual([dummyWorkspaceExperience]);
  expect(host.workspaceExperienceApis).toEqual([dummyWorkspaceExperienceApi]);
});

test('registering a workspace experience WITHOUT the atom kind throws', async () => {
  const host = collectingHost();
  const pack = defineAtomPack({
    manifest: manifest({ name: 'sneaky', atoms: [] }),
    workspaceExperienceApis: [dummyWorkspaceExperienceApi],
    workspaceExperiences: [dummyWorkspaceExperience]
  });
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
  expect(host.workspaceExperiences).toHaveLength(0);
  expect(host.workspaceExperienceApis).toHaveLength(0);
});

test('registering a workspace experience API WITHOUT the atom kind throws', async () => {
  const host = collectingHost();
  const pack = defineAtomPack({
    manifest: manifest({ name: 'sneaky-api', atoms: [] }),
    workspaceExperienceApis: [dummyWorkspaceExperienceApi]
  });
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
  expect(host.workspaceExperienceApis).toHaveLength(0);
});

test('defineWorkspaceExperience preserves the descriptor and exposes the update event name', () => {
  expect(defineWorkspaceExperience(dummyWorkspaceExperience)).toBe(dummyWorkspaceExperience);
  expect(WORKSPACE_EXPERIENCE_UPDATE_EVENT).toBe('monad-workspace-experience:update');
});

test('bindWorkspaceExperience receives the current host api, update events, and unsubscribes', () => {
  type Api = {
    snapshot: { id: string };
    actions: Record<string, never>;
    embedded: boolean;
    requestProjectDialog(): void;
  };
  const listeners = new Set<(event: { type: typeof WORKSPACE_EXPERIENCE_UPDATE_EVENT; detail: Api }) => void>();
  const target = {
    monadWorkspaceExperience: {
      actions: {},
      embedded: true,
      requestProjectDialog: () => {},
      snapshot: { id: 'initial' }
    },
    addEventListener: (
      _type: typeof WORKSPACE_EXPERIENCE_UPDATE_EVENT,
      listener: (event: { type: typeof WORKSPACE_EXPERIENCE_UPDATE_EVENT; detail: Api }) => void
    ) => {
      listeners.add(listener);
    },
    removeEventListener: (
      _type: typeof WORKSPACE_EXPERIENCE_UPDATE_EVENT,
      listener: (event: { type: typeof WORKSPACE_EXPERIENCE_UPDATE_EVENT; detail: Api }) => void
    ) => {
      listeners.delete(listener);
    }
  };
  const seen: string[] = [];

  const unbind = bindWorkspaceExperience(target, (api) => seen.push(api.snapshot.id));
  for (const listener of listeners) {
    listener({
      type: WORKSPACE_EXPERIENCE_UPDATE_EVENT,
      detail: {
        actions: {},
        embedded: false,
        requestProjectDialog: () => {},
        snapshot: { id: 'next' }
      }
    });
  }
  unbind();
  for (const listener of listeners) {
    listener({
      type: WORKSPACE_EXPERIENCE_UPDATE_EVENT,
      detail: {
        actions: {},
        embedded: false,
        requestProjectDialog: () => {},
        snapshot: { id: 'after-unbind' }
      }
    });
  }

  expect(seen).toEqual(['initial', 'next']);
});
