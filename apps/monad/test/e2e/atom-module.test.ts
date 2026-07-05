// The atom packs handler module: install (default-deny consent) → list → remove, end-to-end over a
// real temp ~/.monad/atoms using a local: source (no network).

import type { MonadPaths } from '@monad/home';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, loadAll, saveAll } from '@monad/home';

import { createAtomPacksModule } from '@/handlers/atom-pack/index.ts';

let base: string;
let atomsDir: string;
let stagedDir: string;
let mod: ReturnType<typeof createAtomPacksModule>;
const realFetch = globalThis.fetch;
const realPath = process.env.PATH;

function paths(): MonadPaths {
  return {
    home: base,
    logs: join(base, 'logs'),
    runtime: base,
    configs: base,
    profile: join(base, 'profile.json'),
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
  mod = createAtomPacksModule({ paths: paths() });
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

  expect(await mod.removeAtomPack({ name: 'wa' })).toEqual({ ok: true });
  expect(await installed()).toEqual([]);
});

test('listWorkspaceExperiences returns the daemon registry snapshot', async () => {
  const m = createAtomPacksModule({
    paths: paths(),
    getWorkspaceExperiences: () => [
      {
        atomPackId: 'canvas-pack',
        id: 'canvas',
        title: 'Canvas',
        api: { routes: [{ method: 'POST', path: '/search' }] },
        entry: { type: 'web-component', module: './dist/canvas.js', tagName: 'monad-canvas' }
      },
      {
        atomPackId: 'bad-pack',
        id: 'bad',
        title: 'Bad',
        entry: { type: 'web-component', module: '../bad.js', tagName: 'bad-canvas' }
      }
    ]
  });

  expect(await m.listWorkspaceExperiences()).toEqual({
    experiences: [
      {
        id: 'canvas',
        title: 'Canvas',
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
  const { discoverChannelAdapters } = await import('@/channels/discover.ts');
  const p = paths();
  await saveAll(p.config, p.profile, createDefaultConfig('prn_test', 'Test User'));
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
  expect((await loadAll(p.config, p.profile))?.skills.disabled).toContain('atom-pack:wa:summarize-changes');

  await mod.setAtomPackEnabled({ name: 'wa', enabled: true });
  expect((await discoverChannelAdapters(join(atomsDir, 'packs'))).factories.has('whatsapp')).toBe(true);
  expect((await loadAll(p.config, p.profile))?.skills.disabled).not.toContain('atom-pack:wa:summarize-changes');
});

test('onChanged fires on install + remove (live re-discovery hook)', async () => {
  let calls = 0;
  const m = createAtomPacksModule({
    paths: paths(),
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
