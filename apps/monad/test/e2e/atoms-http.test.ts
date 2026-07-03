// e2e: the /v1/atoms REST surface over a real temp ~/.monad. Installs a local: atom pack
// (default-deny consent), lists it, then removes it — exercising the controller wiring.

import type { MonadPaths } from '@monad/home';
import type { ModelRouter } from '@/agent/index.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig, saveAll, saveAuth } from '@monad/home';
import { ModelProviderType } from '@monad/protocol';

import { ModelService } from '@/handlers/settings/model/index.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, makeTestPaths, mockModel, seededProviderRegistry } from '../helpers.ts';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base, { mcp: join(base, 'atoms', 'mcp') });
}

// Build a single-entry .tar.gz whose member name is an absolute path. `tar` strips the leading
// slash and Windows has no `python3`, so the traversal fixture is assembled by hand: one 512-byte
// ustar header + padded body + two zero blocks, gzip-compressed. Cross-platform, no external tool.
function tarGzWithName(name: string, body: string): Uint8Array {
  const enc = new TextEncoder();
  const content = enc.encode(body);
  const header = new Uint8Array(512);
  const put = (str: string, off: number, len: number) => header.set(enc.encode(str).subarray(0, len), off);
  const octal = (n: number, len: number) => `${n.toString(8).padStart(len - 1, '0')}\0`;
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(content.length, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put('        ', 148, 8); // checksum computed over spaces, then overwritten
  put('0', 156, 1); // typeflag: regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const bodyBlocks = Math.ceil(content.length / 512) * 512;
  const tar = new Uint8Array(512 + bodyBlocks + 1024);
  tar.set(header, 0);
  tar.set(content, 512);
  return Bun.gzipSync(tar);
}

let dir: string;
let stagedDir: string;
let server: { port: number; stop: (f?: boolean) => void };
let base: string;
let paths: MonadPaths;
let modelService: ModelService;

function reviewModel(text: string): ModelRouter {
  return {
    async complete() {
      return { text };
    },
    async *stream() {}
  };
}

beforeEach(async () => {
  dir = join(tmpdir(), `monad-atomshttp-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  paths = makePaths(dir);
  await initMonadHome(paths);
  stagedDir = join(dir, 'staged');
  await mkdir(join(stagedDir, 'dist'), { recursive: true });
  await writeFile(
    join(stagedDir, 'atom-pack.json'),
    JSON.stringify({
      name: 'wa',
      version: '1.0.0',
      sdkVersion: '0',
      atoms: ['channel'],
      entry: 'dist/atom-pack.js'
    })
  );
  await writeFile(
    join(stagedDir, 'dist', 'atom-pack.js'),
    `const cap={edit:false,typing:false,threads:false,maxMessageChars:1000,markdown:false};
export default {manifest:{name:'wa',version:'1.0.0',sdkVersion:'0',atoms:['channel']},register(ctx){ctx.registerChannel({type:'whatsapp',name:'X',capabilities:cap,create:()=>({type:'whatsapp',capabilities:cap,connect:async()=>{},disconnect:async()=>{},send:async(c)=>({ref:'1',chatId:c})})});}};`
  );

  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing');
  cfg.model.providers = [{ id: 'review-provider', label: 'Review Provider', type: ModelProviderType.OpenAICompatible }];
  cfg.model.profiles = [
    {
      alias: 'review',
      routes: { chat: { provider: 'review-provider', modelId: 'review-model' } },
      params: {},
      fallbacks: []
    }
  ];
  cfg.model.default = 'review';
  cfg.skills.installReview = true;
  await saveAll(paths.config, paths.profile, cfg);
  await saveAuth(paths.auth, {
    version: 1,
    activeProvider: null,
    updatedAt: new Date().toISOString(),
    credentialPool: {
      'review-provider': [
        {
          id: 'cred_review',
          label: 'review',
          authType: 'api_key',
          priority: 0,
          source: 'user',
          accessToken: 'sk-review',
          lastStatus: 'unknown',
          lastStatusAt: null,
          lastErrorCode: null,
          lastErrorReason: null,
          lastErrorMessage: null,
          lastErrorResetAt: null,
          requestCount: 0
        }
      ]
    }
  });
  modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  (modelService as unknown as { router: ModelRouter }).router = reviewModel(
    '{"risky":true,"reason":"declares prompt override instructions"}'
  );
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService })).listen({
    hostname: '127.0.0.1',
    port: 0
  }) as unknown as { server: typeof server };
  server = app.server;
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

test('install default-deny: needsConsent=true, atom pack not installed', async () => {
  const res = await post('/v1/atoms/install', { source: `local:${stagedDir}`, consent: false });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { needsConsent?: boolean }).needsConsent).toBe(true);
  const listed = ((await (await fetch(`${base}/v1/atoms`)).json()) as { atomPacks: { name: string }[] }).atomPacks;
  expect(listed.some((pack) => pack.name === 'wa')).toBe(false);
});

test('install with consent → list → remove over HTTP', async () => {
  const res = await post('/v1/atoms/install', { source: `local:${stagedDir}`, consent: true });
  expect(((await res.json()) as { name: string }).name).toBe('wa');

  const listed = (await (await fetch(`${base}/v1/atoms`)).json()) as {
    atomPacks: { name: string; atoms: string[]; enabled: boolean }[];
  };
  const wa = listed.atomPacks.find((pack) => pack.name === 'wa');
  expect(wa).toMatchObject({ name: 'wa', atoms: ['channel'], enabled: true });

  const del = await fetch(`${base}/v1/atoms/wa`, { method: 'DELETE' });
  expect(del.status).toBe(200);
  const afterDelete = ((await (await fetch(`${base}/v1/atoms`)).json()) as { atomPacks: { name: string }[] }).atomPacks;
  expect(afterDelete.some((pack) => pack.name === 'wa')).toBe(false);
});

test('GET /v1/atoms/:name/assets/* serves installed pack assets and rejects traversal', async () => {
  await post('/v1/atoms/install', { source: `local:${stagedDir}`, consent: true });

  const asset = await fetch(`${base}/v1/atoms/wa/assets/dist/atom-pack.js`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get('content-type')).toContain('text/javascript');
  expect(await asset.text()).toContain('registerChannel');

  const traversal = await fetch(`${base}/v1/atoms/wa/assets/${encodeURIComponent('../atom-pack.json')}`);
  expect(traversal.status).toBeGreaterThanOrEqual(400);

  await writeFile(join(dir, 'secret.txt'), 'secret');
  await symlink(join(dir, 'secret.txt'), join(paths.packs, 'wa', 'dist', 'secret-link.js'));
  const symlinked = await fetch(`${base}/v1/atoms/wa/assets/dist/secret-link.js`);
  expect(symlinked.status).toBeGreaterThanOrEqual(400);
});

test('disable sets enabled:false; enable restores it', async () => {
  await post('/v1/atoms/install', { source: `local:${stagedDir}`, consent: true });

  await post('/v1/atoms/wa/disable');
  const afterDisable = (await (await fetch(`${base}/v1/atoms`)).json()) as {
    atomPacks: { name: string; enabled: boolean }[];
  };
  expect(afterDisable.atomPacks.find((pack) => pack.name === 'wa')?.enabled).toBe(false);

  await post('/v1/atoms/wa/enable');
  const afterEnable = (await (await fetch(`${base}/v1/atoms`)).json()) as {
    atomPacks: { name: string; enabled: boolean }[];
  };
  expect(afterEnable.atomPacks.find((pack) => pack.name === 'wa')?.enabled).toBe(true);
});

// ── skill atom routes (/v1/atoms/skills) — offline: list/remove/updates ──────────
type SkillList = { skills: { name: string; source?: string; commit?: string }[] };

async function dropSkill(name: string): Promise<void> {
  const skillDir = join(dir, 'skills', name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: A ${name} skill.\n---\nbody\n`);
}

test('GET /v1/atoms/skills lists installed skill atoms; a dropped-in one has no source record', async () => {
  await dropSkill('demo');
  const listed = (await (await fetch(`${base}/v1/atoms/skills`)).json()) as SkillList;
  const demo = listed.skills.find((s) => s.name === 'demo');
  expect(demo).toBeDefined();
  expect(demo?.source).toBeUndefined(); // hand-dropped → no install record
});

test('DELETE /v1/atoms/skills/:name removes the skill', async () => {
  await dropSkill('demo');
  const del = await fetch(`${base}/v1/atoms/skills/demo`, { method: 'DELETE' });
  expect(del.status).toBe(200);
  const listed = (await (await fetch(`${base}/v1/atoms/skills`)).json()) as SkillList;
  expect(listed.skills.some((s) => s.name === 'demo')).toBe(false);
});

test('POST /v1/atoms/skills creates a skill from raw content and it lists', async () => {
  const content = '---\nname: scaffolded\ndescription: A scaffolded skill.\n---\nbody\n';
  const res = await post('/v1/atoms/skills', { name: 'scaffolded', content });
  expect(res.status).toBe(200);
  const created = (await res.json()) as { name: string; dir: string };
  expect(created.name).toBe('scaffolded');
  const listed = (await (await fetch(`${base}/v1/atoms/skills`)).json()) as SkillList;
  expect(listed.skills.some((s) => s.name === 'scaffolded')).toBe(true);
});

test('POST /v1/atoms/skills rejects content whose frontmatter name mismatches', async () => {
  const content = '---\nname: other\ndescription: Mismatched name.\n---\nbody\n';
  const res = await post('/v1/atoms/skills', { name: 'mismatch', content });
  expect(res.status).toBeGreaterThanOrEqual(400);
});

test('POST /v1/atoms/skills/upload installs an octet-stream skill upload', async () => {
  const content = '---\nname: uploaded\ndescription: An uploaded skill.\n---\nbody\n';
  const res = await fetch(`${base}/v1/atoms/skills/upload?filename=SKILL.md&overwrite=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: content
  });

  expect(res.status).toBe(200);
  expect(((await res.json()) as { skills: string[] }).skills).toEqual(['uploaded']);
  const listed = (await (await fetch(`${base}/v1/atoms/skills`)).json()) as SkillList;
  expect(listed.skills.some((s) => s.name === 'uploaded')).toBe(true);
});

test('POST /v1/atoms/skills/upload rejects filenames with path separators', async () => {
  const content = '---\nname: uploaded\ndescription: An uploaded skill.\n---\nbody\n';
  const res = await fetch(`${base}/v1/atoms/skills/upload?filename=${encodeURIComponent('dir/SKILL.md')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: content
  });

  expect(res.status).toBeGreaterThanOrEqual(400);
});

test('POST /v1/atoms/skills/install runs model review before remote install consent', async () => {
  const sourceRoot = join(dir, 'review-source');
  const skillDir = join(sourceRoot, 'reviewed');
  const archive = join(dir, 'reviewed.tar.gz');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: reviewed\ndescription: Reviewed skill.\n---\nbody\n');
  await Bun.$`tar -czf ${archive} -C ${sourceRoot} .`.quiet();

  const origin = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(Bun.file(archive))
  }) as unknown as { port: number; stop: (force?: boolean) => void };
  try {
    const source = `http://127.0.0.1:${origin.port}/reviewed.tar.gz`;
    const first = await post('/v1/atoms/skills/install', { source, consent: false });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { needsConsent?: boolean; skills: string[]; warnings: string[] };
    expect(firstBody.needsConsent).toBe(true);
    expect(firstBody.skills).toEqual(['reviewed']);
    expect(firstBody.warnings).toContain('install review flagged this skill: declares prompt override instructions');
    expect(await Bun.file(join(paths.skills, 'reviewed', 'SKILL.md')).exists()).toBe(false);

    const second = await post('/v1/atoms/skills/install', { source, consent: true });
    const secondText = await second.text();
    expect(second.status, secondText).toBe(200);
    const secondBody = JSON.parse(secondText) as { needsConsent?: boolean; skills: string[]; warnings: string[] };
    expect(secondBody.needsConsent).toBeUndefined();
    expect(secondBody.skills).toEqual(['reviewed']);
    expect(secondBody.warnings).toContain('install review flagged this skill: declares prompt override instructions');
    expect(await Bun.file(join(paths.skills, 'reviewed', 'SKILL.md')).exists()).toBe(true);
  } finally {
    origin.stop(true);
  }
});

test('POST /v1/atoms/skills/install rejects tarballs with unsafe absolute paths', async () => {
  const archive = join(dir, 'unsafe-path.tar.gz');
  const payload = '---\nname: unsafe\ndescription: Unsafe path skill.\n---\nbody\n';
  await writeFile(archive, tarGzWithName('/absolute/unsafe/SKILL.md', payload));

  const origin = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(Bun.file(archive))
  }) as unknown as { port: number; stop: (force?: boolean) => void };
  try {
    const source = `http://127.0.0.1:${origin.port}/unsafe-path.tar.gz`;
    const res = await post('/v1/atoms/skills/install', { source, consent: true });
    expect(res.status).toBe(500);
    expect(await Bun.file(join(paths.skills, 'unsafe', 'SKILL.md')).exists()).toBe(false);
  } finally {
    origin.stop(true);
  }
});

test('POST /v1/atoms/skills/install: review model failure still requires consent and supports retry', async () => {
  const sourceRoot = join(dir, 'review-model-failure');
  const skillDir = join(sourceRoot, 'failed');
  const archive = join(dir, 'review-model-failure.tar.gz');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: failed\ndescription: Failing model review.\n---\nbody\n');
  await Bun.$`tar -czf ${archive} -C ${sourceRoot} .`.quiet();

  const origin = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(Bun.file(archive))
  }) as unknown as { port: number; stop: (force?: boolean) => void };
  try {
    (modelService as unknown as { router: ModelRouter }).router = {
      async complete() {
        throw new Error('provider unavailable');
      },
      async *stream() {}
    };

    const source = `http://127.0.0.1:${origin.port}/review-model-failure.tar.gz`;
    const first = await post('/v1/atoms/skills/install', { source, consent: false });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { needsConsent?: boolean; skills: string[]; warnings: string[] };
    expect(firstBody.needsConsent).toBe(true);
    expect(firstBody.skills).toEqual(['failed']);
    expect(firstBody.warnings.some((w) => w.includes('install review failed: model request failed'))).toBe(true);
    expect(await Bun.file(join(paths.skills, 'failed', 'SKILL.md')).exists()).toBe(false);

    const second = await post('/v1/atoms/skills/install', { source, consent: true });
    const secondText = await second.text();
    expect(second.status, secondText).toBe(200);
    const secondBody = JSON.parse(secondText) as { needsConsent?: boolean; skills: string[]; warnings: string[] };
    expect(secondBody.needsConsent).toBeUndefined();
    expect(secondBody.skills).toEqual(['failed']);
    expect(await Bun.file(join(paths.skills, 'failed', 'SKILL.md')).exists()).toBe(true);
  } finally {
    origin.stop(true);
  }
});

test('GET and PUT /v1/atoms/skills/:name/content match the nested content route', async () => {
  const content = '---\nname: content-route\ndescription: A content route skill.\n---\nbody\n';
  const created = await post('/v1/atoms/skills', { name: 'content-route', content });
  expect(created.status).toBe(200);

  const read = await fetch(`${base}/v1/atoms/skills/content-route/content`);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { content: string }).content).toBe(content);

  const next = '---\nname: content-route\ndescription: A content route skill.\n---\nupdated body\n';
  const edited = await fetch(`${base}/v1/atoms/skills/content-route/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: next })
  });
  expect(edited.status).toBe(200);

  const reread = await fetch(`${base}/v1/atoms/skills/content-route/content`);
  expect(((await reread.json()) as { content: string }).content).toBe(next);
});

test('GET and PUT /v1/atoms/skills/:name/content can address atom-pack skills by id', async () => {
  const paths = makePaths(dir);
  const skillDir = join(paths.packs, 'wa', 'skills', 'same-name');
  await mkdir(skillDir, { recursive: true });
  const packContent = '---\nname: same-name\ndescription: Atom pack skill.\n---\nfrom atom pack\n';
  await writeFile(join(skillDir, 'SKILL.md'), packContent);
  const globalContent = '---\nname: same-name\ndescription: Global skill.\n---\nfrom global\n';
  const created = await post('/v1/atoms/skills', { name: 'same-name', content: globalContent });
  expect(created.status).toBe(200);

  const id = encodeURIComponent('atom-pack:wa:same-name');
  const read = await fetch(`${base}/v1/atoms/skills/same-name/content?id=${id}`);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { content: string }).content).toBe(packContent);

  const next = '---\nname: same-name\ndescription: Atom pack skill.\n---\nupdated atom pack\n';
  const edited = await fetch(`${base}/v1/atoms/skills/same-name/content?id=${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: next })
  });
  expect(edited.status).toBe(200);

  expect(await Bun.file(join(skillDir, 'SKILL.md')).text()).toBe(next);
  expect(await Bun.file(join(paths.skills, 'same-name', 'SKILL.md')).text()).toBe(globalContent);
});

async function makeSourceTree(...names: string[]): Promise<string> {
  const root = join(tmpdir(), `monad-skill-src-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const name of names) {
    const d = join(root, name);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: A ${name} skill.\n---\nbody\n`);
  }
  return root;
}

test('POST /v1/atoms/skills/local installs every skill under a local path', async () => {
  const src = await makeSourceTree('alpha', 'beta');
  try {
    const res = await post('/v1/atoms/skills/local', { path: src });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: string[]; warnings: string[] };
    expect(body.skills.sort()).toEqual(['alpha', 'beta']);
    const listed = (await (await fetch(`${base}/v1/atoms/skills`)).json()) as SkillList;
    expect(listed.skills.some((s) => s.name === 'alpha')).toBe(true);
    expect(listed.skills.some((s) => s.name === 'beta')).toBe(true);
  } finally {
    await rm(src, { recursive: true, force: true });
  }
});

test('POST /v1/atoms/skills/validate reports ok and name-mismatch per skill', async () => {
  const root = join(tmpdir(), `monad-skill-val-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, 'good'), { recursive: true });
  await writeFile(join(root, 'good', 'SKILL.md'), '---\nname: good\ndescription: Fine.\n---\nbody\n');
  await mkdir(join(root, 'bad'), { recursive: true });
  await writeFile(join(root, 'bad', 'SKILL.md'), '---\nname: wrong\ndescription: Mismatch.\n---\nbody\n');
  try {
    const res = await post('/v1/atoms/skills/validate', { path: root });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: { name: string; dir: string; ok: boolean; error?: string }[] };
    expect(results.find((r) => r.dir.endsWith('good'))?.ok).toBe(true);
    const bad = results.find((r) => r.dir.endsWith('bad'));
    expect(bad?.ok).toBe(false);
    expect(bad?.error).toContain('must equal directory name');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /v1/atoms/skills/updates ignores skills without a github install record', async () => {
  await dropSkill('demo');
  const res = (await (await fetch(`${base}/v1/atoms/skills/updates`)).json()) as { updates: unknown[] };
  expect(res.updates).toEqual([]); // no network hit — nothing is github-tracked
});

// ── MCP atom routes (/v1/atoms/mcp) — offline: default-deny install, list, remove ───
type McpList = { servers: { name: string; transport: string; command?: string }[] };
const npxServer = (name: string) => ({
  server: {
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'x'],
    enabled: true,
    trust: { autoApproveTools: [] }
  }
});

test('POST /v1/atoms/mcp/install default-deny → needsConsent, nothing written', async () => {
  const res = await post('/v1/atoms/mcp/install', { ...npxServer('fs'), consent: false });
  expect(((await res.json()) as { needsConsent?: boolean }).needsConsent).toBe(true);
  expect(((await (await fetch(`${base}/v1/atoms/mcp`)).json()) as McpList).servers).toEqual([]);
});

test('install with consent → list → remove an MCP atom over HTTP', async () => {
  await post('/v1/atoms/mcp/install', { ...npxServer('fs'), consent: true });
  const listed = (await (await fetch(`${base}/v1/atoms/mcp`)).json()) as McpList;
  expect(listed.servers).toContainEqual(expect.objectContaining({ name: 'fs', transport: 'stdio', command: 'npx' }));

  const del = await fetch(`${base}/v1/atoms/mcp/fs`, { method: 'DELETE' });
  expect(del.status).toBe(200);
  expect(((await (await fetch(`${base}/v1/atoms/mcp`)).json()) as McpList).servers).toEqual([]);
});

type EnabledList = { servers: { name: string; enabled: boolean }[] };
test('disable then enable an MCP atom over HTTP', async () => {
  await post('/v1/atoms/mcp/install', { ...npxServer('fs'), consent: true });

  await post('/v1/atoms/mcp/fs/disable');
  const off = (await (await fetch(`${base}/v1/atoms/mcp`)).json()) as EnabledList;
  expect(off.servers.find((s) => s.name === 'fs')?.enabled).toBe(false);

  await post('/v1/atoms/mcp/fs/enable');
  const on = (await (await fetch(`${base}/v1/atoms/mcp`)).json()) as EnabledList;
  expect(on.servers.find((s) => s.name === 'fs')?.enabled).toBe(true);
});

test('updating a hand-dropped skill (no recorded source) errors', async () => {
  await dropSkill('manual'); // no .install.json → nothing to update from
  const res = await post('/v1/atoms/skills/manual/update', { consent: true });
  expect(res.status).toBeGreaterThanOrEqual(400);
});
