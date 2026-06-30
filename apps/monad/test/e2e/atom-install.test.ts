// Install pipeline: fetch (injected) → manifest validate → integrity → sdkVersion → scan →
// consent (default-deny) → write. Then the written atom pack is loaded by the real discovery path.

import type { StagedAtomPack } from '@/atoms/install/index.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installAtomPack, parseAtomPackSource } from '@/atoms/install/index.ts';
import { sourceIdentity } from '@/atoms/install/source.ts';
import { discoverChannelAdapters } from '@/channels/discover.ts';

let atomsDir: string;

beforeEach(async () => {
  atomsDir = join(tmpdir(), `monad-install-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  await mkdir(atomsDir, { recursive: true });
});
afterEach(async () => {
  await rm(atomsDir, { recursive: true, force: true });
});

function staged(opts: {
  name: string;
  type: string;
  atoms: string[];
  sdkVersion?: string;
  monadVersion?: string;
  integrity?: string;
  bundleExtra?: string;
}): StagedAtomPack {
  const t = JSON.stringify(opts.type);
  const monadVersion = opts.monadVersion ? `,monadVersion:${JSON.stringify(opts.monadVersion)}` : '';
  const bundle = new TextEncoder().encode(`${opts.bundleExtra ?? ''}
const cap={edit:false,typing:false,threads:false,maxMessageChars:1000,markdown:false};
const channel={type:${t},name:'X',capabilities:cap,create:()=>({type:${t},capabilities:cap,connect:async()=>{},disconnect:async()=>{},send:async(c)=>({ref:'1',chatId:c})})};
export default {manifest:{name:${JSON.stringify(opts.name)},version:'1.0.0',sdkVersion:${JSON.stringify(opts.sdkVersion ?? '0')},atoms:${JSON.stringify(opts.atoms)}${monadVersion}},register(ctx){ctx.registerChannel(channel);}};`);
  return {
    manifestRaw: {
      name: opts.name,
      version: '1.0.0',
      sdkVersion: opts.sdkVersion ?? '0',
      atoms: opts.atoms,
      entry: 'dist/atom-pack.js',
      ...(opts.monadVersion ? { monadVersion: opts.monadVersion } : {}),
      integrity: opts.integrity
    },
    bundle
  };
}

/** A staged bundle that registers MULTIPLE atom kinds in one pack (channel + command + provider). */
function stagedMulti(name: string): StagedAtomPack {
  const bundle = new TextEncoder().encode(`
const cap={edit:false,typing:false,threads:false,maxMessageChars:1000,markdown:false};
const channel={type:'mc',name:'MC',capabilities:cap,create:()=>({type:'mc',capabilities:cap,connect:async()=>{},disconnect:async()=>{},send:async(c)=>({ref:'1',chatId:c})})};
const command={name:'mc-ping',description:'pong',run:async()=>({message:'pong'})};
const provider={type:'mc',descriptor:{type:'mc',label:'MC',strategy:'native'},async*stream(){}};
export default {manifest:{name:${JSON.stringify(name)},version:'1.0.0',sdkVersion:'0',atoms:['channel','command','provider']},register(ctx){ctx.registerChannel(channel);ctx.registerCommand(command);ctx.registerProvider(provider);}};`);
  return {
    manifestRaw: {
      name,
      version: '1.0.0',
      sdkVersion: '0',
      atoms: ['channel', 'command', 'provider'],
      entry: 'dist/atom-pack.js'
    },
    bundle
  };
}

test('install + discovery loads a MULTI-atom pack — all declared kinds register', async () => {
  const out = await installAtomPack('local:/x', {
    atomPacksDir: atomsDir,
    fetch: async () => stagedMulti('multi'),
    consent: () => true,
    now: () => '1970-01-01T00:00:00.000Z'
  });
  expect(out.installed).toBe(true);
  expect(out.atoms.sort()).toEqual(['channel', 'command', 'provider']);

  const commands: unknown[] = [];
  const providers: string[] = [];
  const { factories, errors } = await discoverChannelAdapters(atomsDir, {
    onCommand: (_atomName, cmd) => commands.push(cmd),
    onProvider: (p) => providers.push(p.type)
  });
  expect(errors).toEqual([]);
  expect(factories.has('mc')).toBe(true); // channel
  expect(commands.length).toBe(1); // command
  expect(providers).toEqual(['mc']); // provider
});

test('parseAtomPackSource handles github / npm / local', () => {
  expect(parseAtomPackSource('github:o/r@abc123')).toMatchObject({
    kind: 'github',
    owner: 'o',
    repo: 'r',
    ref: 'abc123'
  });
  expect(parseAtomPackSource('github:nolangz/pixel2motion')).toMatchObject({
    kind: 'github',
    owner: 'nolangz',
    repo: 'pixel2motion',
    ref: 'main'
  });
  expect(parseAtomPackSource('github:vercel-labs/skills@main/skills/find-skills')).toMatchObject({
    kind: 'github',
    owner: 'vercel-labs',
    repo: 'skills',
    ref: 'main',
    path: 'skills/find-skills'
  });
  expect(parseAtomPackSource('https://github.com/nolangz/pixel2motion/blob/main/SKILL.md')).toMatchObject({
    kind: 'github',
    owner: 'nolangz',
    repo: 'pixel2motion',
    ref: 'main'
  });
  expect(parseAtomPackSource('https://github.com/acme/skills/blob/main/pixel2motion/SKILL.md')).toMatchObject({
    kind: 'github',
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    path: 'pixel2motion'
  });
  expect(parseAtomPackSource('https://github.com/nolangz/pixel2motion')).toMatchObject({
    kind: 'github',
    owner: 'nolangz',
    repo: 'pixel2motion',
    ref: 'main'
  });
  expect(parseAtomPackSource('https://github.com/acme/skills/tree/main/pixel2motion')).toMatchObject({
    kind: 'github',
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    path: 'pixel2motion'
  });
  expect(parseAtomPackSource('npm:@scope/n@1.2.3')).toMatchObject({ kind: 'npm', name: '@scope/n', version: '1.2.3' });
  expect(parseAtomPackSource('/abs/p')).toMatchObject({ kind: 'local', path: '/abs/p' });
});

test('github source identity includes subdirectory path but not ref', () => {
  const first = parseAtomPackSource('https://github.com/acme/skills/tree/main/pixel2motion');
  const second = parseAtomPackSource('https://github.com/acme/skills/tree/v2/pixel2motion');
  const other = parseAtomPackSource('https://github.com/acme/skills/tree/main/documents');
  const shorthand = parseAtomPackSource('github:acme/skills@main/pixel2motion');

  expect(sourceIdentity(first)).toBe('github:acme/skills/pixel2motion');
  expect(sourceIdentity(second)).toBe(sourceIdentity(first));
  expect(sourceIdentity(shorthand)).toBe(sourceIdentity(first));
  expect(sourceIdentity(other)).toBe('github:acme/skills/documents');
});

test('install writes the atom pack and discovery loads it', async () => {
  const out = await installAtomPack('local:/x', {
    atomPacksDir: atomsDir,
    fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'] }),
    consent: () => true,
    now: () => '1970-01-01T00:00:00.000Z'
  });
  expect(out.installed).toBe(true);
  expect(out.atoms).toEqual(['channel']);

  const record = JSON.parse(await readFile(join(atomsDir, 'wa', '.install.json'), 'utf8'));
  expect(record.grantedAtoms).toEqual(['channel']);
  expect(record.source).toBe('local:/x');

  // the real discovery path loads the freshly-installed atom pack
  const { factories, errors } = await discoverChannelAdapters(atomsDir);
  expect(errors).toEqual([]);
  expect(factories.has('whatsapp')).toBe(true);
});

test('consent is default-deny — declining installs nothing', async () => {
  const out = await installAtomPack('local:/x', {
    atomPacksDir: atomsDir,
    fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'] }),
    consent: () => false
  });
  expect(out.installed).toBe(false);
  expect(out.needsConsent).toBe(true);
  const { factories } = await discoverChannelAdapters(atomsDir);
  expect(factories.size).toBe(0);
});

test('integrity mismatch is rejected', async () => {
  await expect(
    installAtomPack('local:/x', {
      atomPacksDir: atomsDir,
      fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'], integrity: 'sha256-deadbeef' }),
      consent: () => true
    })
  ).rejects.toThrow(/integrity/i);
});

test('integrity match passes', async () => {
  const s = staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'] });
  const hash = `sha256-${new Bun.CryptoHasher('sha256').update(s.bundle).digest('hex')}`;
  const withHash: StagedAtomPack = { bundle: s.bundle, manifestRaw: { ...(s.manifestRaw as object), integrity: hash } };
  const out = await installAtomPack('local:/x', {
    atomPacksDir: atomsDir,
    fetch: async () => withHash,
    consent: () => true
  });
  expect(out.installed).toBe(true);
});

test('incompatible sdkVersion is rejected', async () => {
  await expect(
    installAtomPack('local:/x', {
      atomPacksDir: atomsDir,
      fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'], sdkVersion: '999' }),
      consent: () => true
    })
  ).rejects.toThrow(/SDK/i);
});

test('incompatible monadVersion is rejected at install time', async () => {
  await expect(
    installAtomPack('local:/x', {
      atomPacksDir: atomsDir,
      fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'], monadVersion: '>=999.0.0' }),
      consent: () => true
    })
  ).rejects.toThrow(/monad/i);
});

test('incompatible monadVersion is skipped at discovery time', async () => {
  const out = await installAtomPack('local:/x', {
    atomPacksDir: atomsDir,
    fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'] }),
    consent: () => true
  });
  expect(out.installed).toBe(true);

  const manifestPath = join(atomsDir, 'wa', 'atom-pack.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await Bun.write(manifestPath, `${JSON.stringify({ ...manifest, monadVersion: '>=999.0.0' }, null, 2)}\n`);

  const { factories, errors } = await discoverChannelAdapters(atomsDir);
  expect(factories.has('whatsapp')).toBe(false);
  expect(errors).toEqual([{ atom: 'wa', error: expect.stringMatching(/monad/i) }]);
});

test('static scan surfaces advisory flags to the consent step', async () => {
  let seen: string[] = [];
  await installAtomPack('local:/x', {
    atomPacksDir: atomsDir,
    fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'], bundleExtra: 'eval("1+1");' }),
    consent: (info) => {
      seen = info.warnings;
      return true;
    }
  });
  expect(seen).toContain('uses eval()');
});

test('re-installing the same source updates in place (dedup), even across a version bump', async () => {
  const v1 = staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'] });
  await installAtomPack('github:o/r@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    atomPacksDir: atomsDir,
    fetch: async () => v1,
    consent: () => true
  });
  // same repo, new SHA → same source identity → reuse the dir, no duplicate
  await installAtomPack('github:o/r@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', {
    atomPacksDir: atomsDir,
    fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'] }),
    consent: () => true
  });
  const dirs = (await readdir(atomsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  expect(dirs.length).toBe(1); // updated in place, not duplicated
});

test('a different source with the same name coexists under a disambiguated dir (no clobber)', async () => {
  const a = await installAtomPack('github:owner-a/repo@1111111111111111111111111111111111111111', {
    atomPacksDir: atomsDir,
    fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'] }),
    consent: () => true
  });
  // different repo, same manifest name → coexists under <name>-<hash>, the first stays put
  const b = await installAtomPack('github:owner-b/repo@2222222222222222222222222222222222222222', {
    atomPacksDir: atomsDir,
    fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'] }),
    consent: () => true
  });
  expect(a.name).toBe('wa');
  expect(b.name).not.toBe('wa'); // disambiguated folder, e.g. wa-<hash>
  expect(b.name.startsWith('wa-')).toBe(true);
  const dirs = (await readdir(atomsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  expect(dirs.length).toBe(2); // both coexist
});

test('a path-traversal entry is rejected at manifest parse (arbitrary-write guard)', async () => {
  const s = staged({ name: 'evil', type: 'x', atoms: ['channel'] });
  const traversal: StagedAtomPack = {
    bundle: s.bundle,
    manifestRaw: { ...(s.manifestRaw as object), entry: '../../../../tmp/monad-evil.js' }
  };
  await expect(
    installAtomPack('github:o/r@abc', { atomPacksDir: atomsDir, fetch: async () => traversal, consent: () => true })
  ).rejects.toThrow(/entry/i);
});

test('remote source without integrity + mutable github ref both warn at consent', async () => {
  let seen: string[] = [];
  await installAtomPack('github:owner/repo@main', {
    atomPacksDir: atomsDir,
    fetch: async () => staged({ name: 'wa', type: 'whatsapp', atoms: ['channel'] }), // no integrity
    consent: (info) => {
      seen = info.warnings;
      return true;
    }
  });
  expect(seen.some((w) => /integrity/i.test(w))).toBe(true);
  expect(seen.some((w) => /mutable ref/i.test(w))).toBe(true);
});
