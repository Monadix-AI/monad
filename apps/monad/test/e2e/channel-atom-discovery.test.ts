// Third-party atom pack discovery: a self-contained bundle dropped in ~/.monad/atoms is loaded
// through the SAME atom-kind-gated path as built-ins. The fixture bundle imports nothing (the
// daemon↔atom pack handshake is structural), exactly like a real `bun build` artifact.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverChannelAdapters } from '#/channels/discover.ts';
import { mergeRegistries } from '#/channels/registry.ts';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `monad-atoms-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A self-contained ManifestAtomPack module (no imports) — what a built bundle looks like.
function atomPackBundle(opts: { type: string; declared: string[] }): string {
  return `
const cap = { edit:false, typing:false, threads:false, maxMessageChars:1000, markdown:false };
const channel = { type:${JSON.stringify(opts.type)}, name:'Ext', capabilities:cap,
  create:(ctx)=>({ type:${JSON.stringify(opts.type)}, capabilities:cap,
    connect:async()=>{}, disconnect:async()=>{}, send:async(chatId)=>({ ref:'1', chatId }) }) };
export default {
  manifest: { name:${JSON.stringify(opts.type)}, version:'1.0.0', sdkVersion:'0', atoms:${JSON.stringify(opts.declared)} },
  register(ctx){ ctx.registerChannel(channel); }
};
`;
}

async function writeAtomPack(name: string, opts: { type: string; declared: string[] }): Promise<void> {
  const pdir = join(dir, name);
  await mkdir(pdir, { recursive: true });
  // atom-pack.json carries the consented atoms — the authoritative gate set (default-deny if absent).
  await writeFile(
    join(pdir, 'atom-pack.json'),
    JSON.stringify({ name, version: '1.0.0', sdkVersion: '0', entry: 'atom-pack.js', atoms: opts.declared })
  );
  await writeFile(join(pdir, 'atom-pack.js'), atomPackBundle(opts));
}

test('discovers a third-party channel atom pack and registers its type', async () => {
  await writeAtomPack('whatsapp', { type: 'whatsapp', declared: ['channel'] });
  const { factories, errors } = await discoverChannelAdapters(dir);
  expect(errors).toEqual([]);
  expect(factories.has('whatsapp')).toBe(true); // open ChannelType: a brand-new platform works
});

test('rediscovery loads updated bundle contents from the same path', async () => {
  await writeAtomPack('reloadable', { type: 'before-update', declared: ['channel'] });
  const before = await discoverChannelAdapters(dir);
  expect({ errors: before.errors, types: [...before.factories.keys()] }).toEqual({
    errors: [],
    types: ['reloadable__before-update', 'before-update']
  });

  await writeFile(
    join(dir, 'reloadable', 'atom-pack.js'),
    atomPackBundle({ type: 'after-update', declared: ['channel'] })
  );
  const after = await discoverChannelAdapters(dir);
  expect({ errors: after.errors, types: [...after.factories.keys()] }).toEqual({
    errors: [],
    types: ['reloadable__after-update', 'after-update']
  });
});

test('an atom pack that registers an undeclared atom kind is rejected (not registered)', async () => {
  await writeAtomPack('sneaky', { type: 'sneaky', declared: [] }); // declares nothing, registers a channel
  const { factories, errors } = await discoverChannelAdapters(dir);
  expect(factories.has('sneaky')).toBe(false);
  expect(errors.some((e) => e.atom === 'sneaky' && /atom/i.test(e.error))).toBe(true);
});

test('an empty / absent atoms dir yields nothing, no throw', async () => {
  const { factories, errors } = await discoverChannelAdapters(join(dir, 'does-not-exist'));
  expect(factories.size).toBe(0);
  expect(errors).toEqual([]);
});

test('a removed connector atom kind is rejected at the manifest boundary', async () => {
  const pdir = join(dir, 'legacy-connector');
  await mkdir(pdir, { recursive: true });
  await writeFile(
    join(pdir, 'atom-pack.json'),
    JSON.stringify({
      name: 'legacy-connector',
      version: '1.0.0',
      sdkVersion: '0',
      entry: 'atom-pack.js',
      atoms: ['connector']
    })
  );
  await writeFile(join(pdir, 'atom-pack.js'), 'export default {};');

  const { factories, errors } = await discoverChannelAdapters(dir);
  expect(factories.size).toBe(0);
  expect(errors.some((e) => e.atom === 'legacy-connector' && /Invalid option/.test(e.error))).toBe(true);
});

test('an atom pack with a mismatched sdkVersion is rejected (goes to errors, no factory)', async () => {
  const pdir = join(dir, 'old-sdk');
  await mkdir(pdir, { recursive: true });
  await writeFile(
    join(pdir, 'atom-pack.json'),
    JSON.stringify({ name: 'old-sdk', version: '1.0.0', sdkVersion: '0', entry: 'atom-pack.js', atoms: ['channel'] })
  );
  // Wrong sdkVersion in the bundle — the atom-kind-gated loader rejects it before register() runs.
  await writeFile(
    join(pdir, 'atom-pack.js'),
    `
const cap = { edit:false, typing:false, threads:false, maxMessageChars:1000, markdown:false };
export default {
  manifest: { name:'old-sdk', version:'1.0.0', sdkVersion:'99', atoms:['channel'] },
  register(ctx){ ctx.registerChannel({ type:'old', name:'X', capabilities:cap, create:()=>null }); }
};`
  );
  const { factories, errors } = await discoverChannelAdapters(dir);
  expect(factories.has('old' as never)).toBe(false);
  expect(errors.some((e) => e.atom === 'old-sdk' && /sdkVersion/i.test(e.error))).toBe(true);
});

test('an atom pack with invalid JSON in atom-pack.json is recorded as an error, does not block others', async () => {
  // bad atom pack
  const bad = join(dir, 'bad-json');
  await mkdir(bad, { recursive: true });
  await writeFile(join(bad, 'atom-pack.json'), 'NOT_VALID_JSON');
  // good atom pack alongside it
  await writeAtomPack('good', { type: 'good-platform', declared: ['channel'] });
  const { factories, errors } = await discoverChannelAdapters(dir);
  expect(errors.some((e) => e.atom === 'bad-json')).toBe(true);
  expect(factories.has('good-platform')).toBe(true); // good atom pack still loaded
});

test('an atom pack with .install.json enabled:false is skipped without an error', async () => {
  await writeAtomPack('disabled', { type: 'disabled-platform', declared: ['channel'] });
  await writeFile(join(dir, 'disabled', '.install.json'), JSON.stringify({ enabled: false }));
  const { factories, errors } = await discoverChannelAdapters(dir);
  expect(errors).toEqual([]);
  expect(factories.has('disabled-platform')).toBe(false); // skipped, not rejected
});

test('an atom pack with .install.json enabled:true is treated as enabled', async () => {
  await writeAtomPack('explicit-on', { type: 'explicit-platform', declared: ['channel'] });
  await writeFile(join(dir, 'explicit-on', '.install.json'), JSON.stringify({ enabled: true }));
  const { factories, errors } = await discoverChannelAdapters(dir);
  expect(errors).toEqual([]);
  expect(factories.has('explicit-platform')).toBe(true);
});

test('a bundle tampered after install (integrity mismatch) is refused at load', async () => {
  await writeAtomPack('tampered', { type: 'tampered-platform', declared: ['channel'] });
  // Record an integrity hash that does NOT match the on-disk bundle — simulates a bundle rewritten
  // after install (the hash recorded at install time would have matched the original).
  await writeFile(
    join(dir, 'tampered', '.install.json'),
    JSON.stringify({
      enabled: true,
      integrity: 'sha256-0000000000000000000000000000000000000000000000000000000000000000'
    })
  );
  const { factories, errors } = await discoverChannelAdapters(dir);
  expect(factories.has('tampered-platform')).toBe(false); // not loaded
  expect(errors.some((e) => e.atom === 'tampered' && /integrity mismatch/i.test(e.error))).toBe(true);
});

test('a bundle whose recorded integrity matches loads normally', async () => {
  await writeAtomPack('verified', { type: 'verified-platform', declared: ['channel'] });
  const bytes = await readFile(join(dir, 'verified', 'atom-pack.js'));
  const integrity = `sha256-${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
  await writeFile(join(dir, 'verified', '.install.json'), JSON.stringify({ enabled: true, integrity }));
  const { factories, errors } = await discoverChannelAdapters(dir);
  expect(errors).toEqual([]);
  expect(factories.has('verified-platform')).toBe(true);
});

// ── mergeRegistries (pure utility) ───────────────────────────────────────────

test('mergeRegistries: later maps win, all entries collected', () => {
  const fA = () => ({}) as never;
  const fB = () => ({}) as never;
  const fC = () => ({}) as never;

  const base = new Map([['telegram', fA] as const, ['slack', fB] as const]);
  const override = new Map([['telegram', fC] as const]); // overrides telegram
  const third = new Map([['whatsapp', fA] as const]);

  const merged = mergeRegistries(base, override, third);
  expect(merged.get('telegram')).toBe(fC); // override wins
  expect(merged.get('slack')).toBe(fB); // base entry carried forward
  expect(merged.get('whatsapp')).toBe(fA); // new entry from third map
  expect(merged.size).toBe(3);
});

test('mergeRegistries: empty input yields empty map', () => {
  expect(mergeRegistries().size).toBe(0);
  expect(mergeRegistries(new Map()).size).toBe(0);
});
