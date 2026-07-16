import type { MonadPaths } from '@monad/environment';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAtomPacksModule } from '#/handlers/atom-pack/index.ts';

let base: string;
let atomsDir: string;
let stagedDir: string;
let mod: ReturnType<typeof createAtomPacksModule>;

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
  base = join(tmpdir(), `monad-amod-container-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
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
  await rm(base, { recursive: true, force: true });
});

test('uploadAtomPack installs a zip through the same consent flow', async () => {
  const zipPath = join(base, 'wa.zip');
  await Bun.$`zip -qr ${zipPath} atom-pack.json dist skills`.cwd(stagedDir).quiet();
  const bytes = new Uint8Array(await readFile(zipPath));

  const preview = await mod.uploadAtomPack({ filename: 'wa.zip', bytes, consent: false });
  expect(preview.needsConsent).toBe(true);
  expect(preview.atoms).toEqual(['channel', 'skill']);

  const installed = await mod.uploadAtomPack({ filename: 'wa.zip', bytes, consent: true });
  expect(installed.name).toBe('wa');
  expect((await mod.listAtomPacks()).atomPacks.some((p) => p.name === 'wa' && p.atoms.includes('skill'))).toBe(true);
});
