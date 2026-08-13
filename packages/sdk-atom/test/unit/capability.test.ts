import type {
  AtomPackManifest,
  ChannelDefinition,
  ExperienceWorker,
  HookDefinition,
  ManifestAtomPack,
  ManifestAtomPackHost,
  WorkplaceExperienceApi,
  WorkplaceExperienceApiContext,
  WorkplaceExperienceDefinition
} from '../../src/index.ts';

import { expect, test } from 'bun:test';
import { parseAtomPackManifest } from '@monad/protocol';
import {
  bindWorkplaceExperience,
  defineWorkplaceExperience,
  WORKPLACE_EXPERIENCE_UPDATE_EVENT
} from '@monad/sdk-experience';

import { defineAtomPack, defineChannel, loadManifestAtomPack, UndeclaredAtomError } from '../../src/index.ts';

const SDK_VERSION = '0';

test('workplace experience permissions are generic and parsed from the manifest', () => {
  const parsed = parseAtomPackManifest({
    name: 'board',
    version: '1.0.0',
    sdkVersion: SDK_VERSION,
    atoms: ['workplace-experience'],
    permissions: [
      'experience.state',
      'project.sessions.read',
      'project.members.read',
      'project.members.invite',
      'project.members.remove'
    ]
  });

  expect(parsed.permissions).toEqual([
    'experience.state',
    'project.sessions.read',
    'project.members.read',
    'project.members.invite',
    'project.members.remove'
  ]);
});

function manifest(over: Partial<AtomPackManifest>): AtomPackManifest {
  return { name: 'p', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: [], ...over };
}

function collectingHost(): ManifestAtomPackHost & {
  channels: ChannelDefinition[];
  hooks: HookDefinition[];
  workplaceExperienceApis: WorkplaceExperienceApi[];
  workplaceExperiences: WorkplaceExperienceDefinition[];
  experienceWorkers: ExperienceWorker[];
} {
  const channels: ChannelDefinition[] = [];
  const hooks: HookDefinition[] = [];
  const workplaceExperienceApis: WorkplaceExperienceApi[] = [];
  const workplaceExperiences: WorkplaceExperienceDefinition[] = [];
  const experienceWorkers: ExperienceWorker[] = [];
  return {
    channels,
    hooks,
    workplaceExperienceApis,
    workplaceExperiences,
    experienceWorkers,
    registerChannel: (c) => channels.push(c as ChannelDefinition),
    registerCommand: () => {},
    registerMessageType: () => {},
    registerHook: (h) => hooks.push(h),
    registerWorkplaceExperienceApi: (api) => workplaceExperienceApis.push(api),
    registerWorkplaceExperience: (experience) => workplaceExperiences.push(experience),
    registerExperienceWorker: (worker) => experienceWorkers.push(worker)
  };
}

const dummyHook: HookDefinition = { event: 'BeforeTool', handler: () => {} };

const dummyWorkplaceExperience: WorkplaceExperienceDefinition = {
  id: 'custom-workspace',
  title: 'Custom workspace',
  api: {
    routes: [{ method: 'POST', path: '/search' }]
  },
  entry: {
    module: './workplace-experience.js',
    tagName: 'custom-workspace',
    type: 'web-component'
  }
};
const dummyWorkplaceExperienceApi: WorkplaceExperienceApi = {
  experienceId: 'custom-workspace',
  routes: [
    {
      method: 'POST',
      path: '/search',
      handle: async (_request: Request, context: WorkplaceExperienceApiContext) =>
        Response.json({ ok: true, pack: context.atomPackId })
    }
  ]
};
const dummyExperienceWorker: ExperienceWorker = {
  experienceId: 'custom-workspace',
  subscriptions: [],
  onProjectStart: async () => {},
  onEvent: async () => {},
  onWake: async () => {}
};

test('workplace experience API handlers receive generic, pack-scoped context', async () => {
  const route = dummyWorkplaceExperienceApi.routes[0];
  if (!route) throw new Error('fixture requires a workplace experience API route');
  const response = await route.handle(new Request('https://example.test/search'), {
    atomPackId: 'pack-a',
    experienceId: 'board',
    experienceState: {
      get: async () => null,
      list: async () => [],
      compareAndSwap: async () => true,
      compareAndDelete: async () => true
    },
    projectSessions: {
      list: async () => [],
      create: async () => ({ id: 'ses_a' }),
      sendMessage: async () => {},
      listMessages: async () => ({ items: [], nextCursor: null }),
      listObservations: async () => ({ items: [], nextCursor: null }),
      runTurn: async () => ({ runId: 'run_a' }),
      getRun: async () => null,
      pause: async () => {},
      cancel: async () => {},
      listPendingApprovals: async () => [],
      resolveApproval: async () => {}
    },
    projectMembers: {
      listTemplates: async () => [],
      listSessionMembers: async () => [],
      inviteSessionMember: async () => ({
        member: {
          id: 'pmem_test00000001',
          projectId: 'prj_test000000001',
          profileId: 'tmpl_a',
          type: 'mesh-agent',
          displayName: 'codex',
          customPrompt: null,
          launchOverrides: {},
          workingDirectoryOverride: null,
          lifecycle: 'enabled',
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:00.000Z'
        },
        binding: {
          sessionId: 'ses_test000000001',
          projectMemberId: 'pmem_test00000001',
          lastDeliveredSeq: 0,
          lastVisibleSeq: 0,
          currentNativeRuntimeSessionId: null,
          lifecycle: 'active',
          lastHealth: null,
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:00.000Z'
        }
      }),
      removeSessionMember: async () => {}
    },
    requestInteraction: async () => ({ status: 'cancelled', reason: 'unavailable' }),
    workerScheduler: {
      schedule: async () => {},
      cancel: async () => {}
    }
  });

  expect(await response.json()).toEqual({ ok: true, pack: 'pack-a' });
});
const dummyChannelAtom = defineChannel({
  type: 'echo',
  name: 'Echo',
  icon: { title: 'Echo', path: 'M4 4h16v16H4z' },
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
    // declares only 'channel' — but tries to register a hook
    manifest: manifest({ name: 'sneaky', atoms: ['channel'] }),
    register: (ctx) => ctx.registerHook(dummyHook)
  };
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
});

test('UndeclaredAtomError names the atom kind and atom pack', async () => {
  const host = collectingHost();
  const pack: ManifestAtomPack = {
    manifest: manifest({ name: 'sneaky', atoms: [] }),
    register: (ctx) => ctx.registerHook(dummyHook)
  };
  try {
    await loadManifestAtomPack(pack, host);
    throw new Error('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(UndeclaredAtomError);
    expect((err as UndeclaredAtomError).atom).toBe('hook');
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
    manifest: manifest({ atoms: ['channel'] }),
    channels: [dummyChannelAtom]
  });
  await loadManifestAtomPack(pack, host);
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
});

test('a declared `workplace-experience` atom routes to the host', async () => {
  const host = collectingHost();
  const pack = defineAtomPack({
    manifest: manifest({ atoms: ['workplace-experience'] }),
    workplaceExperienceApis: [dummyWorkplaceExperienceApi],
    workplaceExperiences: [dummyWorkplaceExperience],
    experienceWorkers: [dummyExperienceWorker]
  });
  await loadManifestAtomPack(pack, host);
  expect(host.workplaceExperiences).toEqual([dummyWorkplaceExperience]);
  expect(host.workplaceExperienceApis).toEqual([dummyWorkplaceExperienceApi]);
  expect(host.experienceWorkers).toEqual([dummyExperienceWorker]);
});

test('registering a workplace experience WITHOUT the atom kind throws', async () => {
  const host = collectingHost();
  const pack = defineAtomPack({
    manifest: manifest({ name: 'sneaky', atoms: [] }),
    workplaceExperienceApis: [dummyWorkplaceExperienceApi],
    workplaceExperiences: [dummyWorkplaceExperience]
  });
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
});

test('registering a workplace experience API WITHOUT the atom kind throws', async () => {
  const host = collectingHost();
  const pack = defineAtomPack({
    manifest: manifest({ name: 'sneaky-api', atoms: [] }),
    workplaceExperienceApis: [dummyWorkplaceExperienceApi]
  });
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
});

test('defineWorkplaceExperience preserves the descriptor and exposes the update event name', () => {
  expect(defineWorkplaceExperience(dummyWorkplaceExperience)).toBe(dummyWorkplaceExperience);
  expect(WORKPLACE_EXPERIENCE_UPDATE_EVENT).toBe('monad-workplace-experience:update');
});

test('bindWorkplaceExperience receives the current host api, update events, and unsubscribes', () => {
  type Api = {
    version: number;
    snapshot: { id: string };
    actions: Record<string, never>;
    embedded: boolean;
    requestProjectDialog(): void;
    openStudio(): void;
  };
  const listeners = new Set<(event: { type: typeof WORKPLACE_EXPERIENCE_UPDATE_EVENT; detail: Api }) => void>();
  const target = {
    monadWorkplaceExperience: {
      version: 1,
      actions: {},
      embedded: true,
      requestProjectDialog: () => {},
      openStudio: () => {},
      snapshot: { id: 'initial' }
    },
    addEventListener: (
      _type: typeof WORKPLACE_EXPERIENCE_UPDATE_EVENT,
      listener: (event: { type: typeof WORKPLACE_EXPERIENCE_UPDATE_EVENT; detail: Api }) => void
    ) => {
      listeners.add(listener);
    },
    removeEventListener: (
      _type: typeof WORKPLACE_EXPERIENCE_UPDATE_EVENT,
      listener: (event: { type: typeof WORKPLACE_EXPERIENCE_UPDATE_EVENT; detail: Api }) => void
    ) => {
      listeners.delete(listener);
    }
  };
  const seen: string[] = [];

  const unbind = bindWorkplaceExperience(target, (api) => seen.push(api.snapshot.id));
  for (const listener of listeners) {
    listener({
      type: WORKPLACE_EXPERIENCE_UPDATE_EVENT,
      detail: {
        version: 1,
        actions: {},
        embedded: false,
        requestProjectDialog: () => {},
        openStudio: () => {},
        snapshot: { id: 'next' }
      }
    });
  }
  unbind();
  for (const listener of listeners) {
    listener({
      type: WORKPLACE_EXPERIENCE_UPDATE_EVENT,
      detail: {
        version: 1,
        actions: {},
        embedded: false,
        requestProjectDialog: () => {},
        openStudio: () => {},
        snapshot: { id: 'after-unbind' }
      }
    });
  }

  expect(seen).toEqual(['initial', 'next']);
});
