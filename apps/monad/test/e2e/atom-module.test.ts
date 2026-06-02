// The atom packs handler module: install (default-deny consent) → list → remove, end-to-end over a
// real temp ~/.monad/atoms using a local: source (no network).

import type { MonadPaths } from '@monad/environment';
import type { AgentId } from '@monad/protocol';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, loadAll, saveAll } from '@monad/environment';

import { ConfigManager } from '#/config/manager.ts';
import { createAtomPacksModule } from '#/handlers/atom-pack/index.ts';
import { createTestConfigManager } from '../helpers.ts';

let base: string;
let atomsDir: string;
let stagedDir: string;
let mod: ReturnType<typeof createAtomPacksModule>;
let config: ConfigManager;
const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
const privateAgentId = 'agt_100000000000' as AgentId;
const privateAgentDir = 'private-agent';

function paths(): MonadPaths {
  return {
    home: base,
    logs: join(base, 'logs'),
    runtime: base,
    configs: base,
    agentsConfig: join(base, 'agents.json'),
    mesh: join(base, 'mesh.json'),
    approvals: join(base, 'approvals.json'),
    config: join(base, 'config.json'),
    credentials: join(base, 'credentials'),
    auth: join(base, 'credentials', 'auth.json'),
    tls: join(base, 'credentials', 'tls'),
    workspace: base,
    providers: base,
    skills: base,
    skillsLock: join(base, 'skills.lock'),
    locales: '/dev/null',
    mcp: '/dev/null',
    atoms: atomsDir,
    packs: join(atomsDir, 'packs'),
    agents: base,
    memory: base,
    backup: base,
    cache: base,
    bin: join(base, 'bin'),
    dbDir: base,
    db: join(base, 'db'),
    sock: join(base, 'sock'),
    kvSock: join(base, 'kvsock'),
    pid: join(base, 'monad.pid')
  };
}

beforeEach(async () => {
  base = join(tmpdir(), `monad-amod-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  atomsDir = join(base, 'atoms');
  stagedDir = join(base, 'staged');
  await mkdir(atomsDir, { recursive: true });
  await mkdir(join(stagedDir, 'dist'), { recursive: true });
  await mkdir(join(stagedDir, 'skills', 'summarize-changes'), { recursive: true });
  await writeFile(
    join(stagedDir, 'atom-pack.json'),
    JSON.stringify({
      name: 'wa',
      version: '1.0.0',
      sdkVersion: '0',
      atoms: ['channel', 'skill'],
      entry: 'dist/atom-pack.js'
    })
  );
  await writeFile(
    join(stagedDir, 'dist', 'atom-pack.js'),
    `const cap={edit:false,typing:false,threads:false,maxMessageChars:1000,markdown:false};
const channel={type:'whatsapp',name:'X',capabilities:cap,create:()=>({type:'whatsapp',capabilities:cap,connect:async()=>{},disconnect:async()=>{},send:async(c)=>({ref:'1',chatId:c})})};
export default {manifest:{name:'wa',version:'1.0.0',sdkVersion:'0',atoms:['channel']},register(ctx){ctx.registerChannel(channel);}};`
  );
  await writeFile(
    join(stagedDir, 'skills', 'summarize-changes', 'SKILL.md'),
    ['---', 'name: summarize-changes', 'description: Summarize changes.', '---', 'Summarize.'].join('\n')
  );
  const initial = createDefaultConfig('Test User');
  initial.agent.agents.push({
    id: privateAgentId,
    name: 'Private Agent',
    dir: privateAgentDir,
    capabilities: [],
    credentialIds: [],
    declaredScopes: [],
    memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
    atoms: { mode: 'inherit', allow: [], deny: [] },
    visibility: { subagentCallable: false, public: false },
    a2a: { enabled: false },
    monadix: { consume: false }
  });
  await saveAll(paths(), initial);
  config = await createTestConfigManager(paths());
  mod = createAtomPacksModule({ paths: paths(), config });
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env.PATH = realPath;
  await rm(base, { recursive: true, force: true });
});

test('install is default-deny without consent', async () => {
  const res = await mod.installAtomPack({ source: `local:${stagedDir}`, consent: false });
  expect(res.needsConsent).toBe(true);
  expect(res.atoms).toEqual(['channel', 'skill']);
  // Only the always-on first-party pack is listed; nothing was installed.
  expect((await mod.listAtomPacks()).atomPacks.filter((p) => p.source !== 'builtin')).toEqual([]);
});

test('create and upload install Skills inside the targeted Agent directory', async () => {
  const createContent = ['---', 'name: created-private', 'description: Created privately.', '---', 'Body.'].join('\n');
  const uploadContent = ['---', 'name: uploaded-private', 'description: Uploaded privately.', '---', 'Body.'].join(
    '\n'
  );

  const created = await mod.createSkill({
    name: 'created-private',
    content: createContent,
    target: { kind: 'agent', agentId: privateAgentId }
  });
  const uploaded = await mod.uploadSkill({
    agentId: privateAgentId,
    filename: 'uploaded-private.md',
    bytes: new TextEncoder().encode(uploadContent)
  });

  expect({
    created,
    uploaded,
    createdContent: await readFile(join(base, privateAgentDir, 'skills', 'created-private', 'SKILL.md'), 'utf8'),
    uploadedContent: await readFile(join(base, privateAgentDir, 'skills', 'uploaded-private', 'SKILL.md'), 'utf8')
  }).toEqual({
    created: {
      id: `agent:${privateAgentDir}:created-private`,
      name: 'created-private',
      dir: join(base, privateAgentDir, 'skills', 'created-private'),
      warnings: []
    },
    uploaded: {
      skills: ['uploaded-private'],
      skillIds: [`agent:${privateAgentDir}:uploaded-private`],
      commit: '',
      warnings: []
    },
    createdContent: createContent,
    uploadedContent: uploadContent
  });

  await expect(
    mod.createSkill({
      name: 'missing-agent',
      content: createContent.replaceAll('created-private', 'missing-agent'),
      target: { kind: 'agent', agentId: 'agt_999999999999' as AgentId }
    })
  ).rejects.toThrow('agent not found');
});

test('install with consent → list → remove', async () => {
  const res = await mod.installAtomPack({ source: `local:${stagedDir}`, consent: true });
  expect(res.needsConsent).toBeUndefined();
  expect(res.name).toBe('wa');

  // listAtomPacks always leads with the first-party `monad-builtins` pack (source:'builtin');
  // assert on the installed (non-builtin) subset.
  const installed = () => mod.listAtomPacks().then((r) => r.atomPacks.filter((p) => p.source !== 'builtin'));
  const listed = await installed();
  expect(listed.length).toBe(1);
  expect(listed[0]).toMatchObject({ name: 'wa', atoms: ['channel', 'skill'], source: `local:${stagedDir}` });
  expect(listed[0]?.atomDetails).toContainEqual({
    kind: 'skill',
    id: 'summarize-changes',
    description: 'Summarize changes.'
  });

  expect(await mod.removeAtomPack({ name: 'wa' })).toEqual({ ok: true });
  expect(await installed()).toEqual([]);
});

test('listWorkplaceExperiences returns the daemon registry snapshot', async () => {
  const m = createAtomPacksModule({
    paths: paths(),
    config,
    getWorkplaceExperiences: () => [
      {
        atomPackId: 'canvas-pack',
        id: 'canvas',
        permissions: ['project.sessions.read'],
        title: 'Canvas',
        api: { routes: [{ method: 'POST', path: '/search' }] },
        entry: { type: 'web-component', module: './dist/canvas.js', tagName: 'monad-canvas' }
      },
      {
        atomPackId: 'bad-pack',
        id: 'bad',
        permissions: [],
        title: 'Bad',
        entry: { type: 'web-component', module: '../bad.js', tagName: 'bad-canvas' }
      }
    ]
  });

  expect(await m.listWorkplaceExperiences()).toEqual({
    experiences: [
      {
        id: 'canvas',
        title: 'Canvas',
        permissions: ['project.sessions.read'],
        api: { routes: [{ method: 'POST', path: '/search' }] },
        entry: {
          type: 'web-component',
          module: '/v1/atoms/canvas-pack/assets/dist/canvas.js',
          tagName: 'monad-canvas'
        }
      }
    ]
  });
});

test('getAtomPackAsset serves pack files without allowing path traversal', async () => {
  await mod.installAtomPack({ source: `local:${stagedDir}`, consent: true });

  const asset = await mod.getAtomPackAsset({ name: 'wa', path: 'dist/atom-pack.js' });
  expect(asset.contentType).toBe('text/javascript');
  expect(new TextDecoder().decode(asset.bytes)).toContain('registerChannel');

  await expect(mod.getAtomPackAsset({ name: 'wa', path: '../atom-pack.json' })).rejects.toThrow();

  await writeFile(join(base, 'secret.txt'), 'secret');
  await symlink(join(base, 'secret.txt'), join(atomsDir, 'packs', 'wa', 'dist', 'secret-link.js'));
  await expect(mod.getAtomPackAsset({ name: 'wa', path: 'dist/secret-link.js' })).rejects.toThrow();
});

test('removeAtomPack rejects path-traversal names', async () => {
  await expect(mod.removeAtomPack({ name: '../evil' })).rejects.toThrow();
});

test('disable hides an atom pack from discovery; enable restores it', async () => {
  const { discoverChannelAdapters } = await import('#/channels/discover.ts');
  const p = paths();
  await mod.installAtomPack({ source: `local:${stagedDir}`, consent: true });
  await mkdir(join(atomsDir, 'packs', 'wa', 'skills', 'summarize-changes'), { recursive: true });
  await writeFile(
    join(atomsDir, 'packs', 'wa', 'skills', 'summarize-changes', 'SKILL.md'),
    ['---', 'name: summarize-changes', 'description: Summarize changes.', '---', 'Summarize.'].join('\n')
  );
  expect((await discoverChannelAdapters(join(atomsDir, 'packs'))).factories.has('whatsapp')).toBe(true);

  await mod.setAtomPackEnabled({ name: 'wa', enabled: false });
  expect((await mod.listAtomPacks()).atomPacks.find((p) => p.name === 'wa')?.enabled).toBe(false);
  expect((await discoverChannelAdapters(join(atomsDir, 'packs'))).factories.has('whatsapp')).toBe(false); // skipped
  expect((await loadAll(p))?.skills.disabled).toContain('atom-pack:wa:summarize-changes');

  await mod.setAtomPackEnabled({ name: 'wa', enabled: true });
  expect((await discoverChannelAdapters(join(atomsDir, 'packs'))).factories.has('whatsapp')).toBe(true);
  expect((await loadAll(p))?.skills.disabled).not.toContain('atom-pack:wa:summarize-changes');
});

test('updateAtomPack reinstalls the exact recorded source in place and preserves disabled state', async () => {
  await mod.installAtomPack({ source: `local:${stagedDir}`, consent: true });
  await mod.setAtomPackEnabled({ name: 'wa', enabled: false });
  await writeFile(
    join(stagedDir, 'atom-pack.json'),
    JSON.stringify({
      name: 'wa',
      version: '2.0.0',
      sdkVersion: '0',
      atoms: ['channel', 'skill'],
      entry: 'dist/atom-pack.js'
    })
  );
  await writeFile(join(stagedDir, 'dist', 'atom-pack.js'), 'export default { version: "updated" };');

  const check = await mod.checkAtomPackUpdate({ name: 'wa' });
  await writeFile(join(stagedDir, 'dist', 'atom-pack.js'), 'export default { version: "changed-after-check" };');
  await expect(mod.updateAtomPack({ name: 'wa', confirm: true, revision: check.latestRevision })).rejects.toThrow(
    'source changed after the update check'
  );
  const refreshedCheck = await mod.checkAtomPackUpdate({ name: 'wa' });
  const result = await mod.updateAtomPack({ name: 'wa', confirm: true, revision: refreshedCheck.latestRevision });
  const installed = (await mod.listAtomPacks()).atomPacks.find((pack) => pack.name === 'wa');
  const bundle = await readFile(join(atomsDir, 'packs', 'wa', 'dist', 'atom-pack.js'), 'utf8');

  expect({ result, installed, bundle }).toEqual({
    result: { name: 'wa', atoms: ['channel', 'skill'], warnings: [] },
    installed: expect.objectContaining({
      name: 'wa',
      version: '2.0.0',
      enabled: false,
      canUpdate: true,
      source: `local:${stagedDir}`
    }),
    bundle: 'export default { version: "changed-after-check" };'
  });

  await rm(stagedDir, { recursive: true, force: true });
  expect((await mod.listAtomPacks()).atomPacks.map((pack) => ({ name: pack.name, canUpdate: pack.canUpdate }))).toEqual(
    [
      { name: 'monad-builtins', canUpdate: false },
      { name: 'wa', canUpdate: false }
    ]
  );
});

test('listAtomPacks marks a drop-in pack without an install record as not updateable', async () => {
  const dropIn = join(atomsDir, 'packs', 'drop-in');
  await mkdir(join(dropIn, 'dist'), { recursive: true });
  await writeFile(
    join(dropIn, 'atom-pack.json'),
    JSON.stringify({ name: 'drop-in', version: '1.0.0', sdkVersion: '0', atoms: [], entry: 'dist/atom-pack.js' })
  );
  await writeFile(join(dropIn, 'dist', 'atom-pack.js'), 'export default {};');

  const listed = (await mod.listAtomPacks()).atomPacks.find((pack) => pack.name === 'drop-in');
  expect(listed).toEqual(
    expect.objectContaining({ name: 'drop-in', source: undefined, canUpdate: false, enabled: true })
  );
});

test('onChanged fires on install + remove (live re-discovery hook)', async () => {
  let calls = 0;
  const m = createAtomPacksModule({
    paths: paths(),
    config,
    onChanged: async () => {
      calls += 1;
    }
  });
  await m.installAtomPack({ source: `local:${stagedDir}`, consent: false }); // declined → no fire
  expect(calls).toBe(0);
  await m.installAtomPack({ source: `local:${stagedDir}`, consent: true }); // installed → fire
  expect(calls).toBe(1);
  await m.removeAtomPack({ name: 'wa' }); // remove → fire
  expect(calls).toBe(2);
});

test('removeAtomPack completes deletion when live re-discovery fails', async () => {
  const m = createAtomPacksModule({
    paths: paths(),
    config,
    onChanged: async () => {
      throw new Error('rediscovery failed');
    }
  });
  await mod.installAtomPack({ source: `local:${stagedDir}`, consent: true });

  expect(await m.removeAtomPack({ name: 'wa' })).toEqual({ ok: true });
  // presence-ok: removeAtomPack deleted the pack despite the post-delete refresh failure.
  await expect(m.getAtomPack({ name: 'wa' })).rejects.toThrow('Atom Pack not found: wa');
});

test('disable and remove consult the active sandbox fallback guard before mutating a pack', async () => {
  const guarded: string[] = [];
  const m = createAtomPacksModule({
    paths: paths(),
    config,
    sandboxActivation: {
      activateBackend: async (ref) => ({ requested: ref, effective: ref, status: 'active' }),
      ensurePackCanDeactivate: async (packId) => {
        guarded.push(packId);
      }
    }
  });
  await m.installAtomPack({ source: `local:${stagedDir}`, consent: true });

  await m.setAtomPackEnabled({ name: 'wa', enabled: false });
  await m.setAtomPackEnabled({ name: 'wa', enabled: true });
  await m.removeAtomPack({ name: 'wa' });

  expect(guarded).toEqual(['wa', 'wa']);
});

test('a failed sandbox fallback refuses active-pack disable before changing install state', async () => {
  const m = createAtomPacksModule({
    paths: paths(),
    config,
    sandboxActivation: {
      activateBackend: async (ref) => ({ requested: ref, effective: ref, status: 'active' }),
      ensurePackCanDeactivate: async () => {
        throw new Error('auto unavailable');
      }
    }
  });
  await m.installAtomPack({ source: `local:${stagedDir}`, consent: true });

  await expect(m.setAtomPackEnabled({ name: 'wa', enabled: false })).rejects.toThrow('auto unavailable');
  expect((await m.listAtomPacks()).atomPacks.find((pack) => pack.name === 'wa')?.enabled).toBe(true);
});
