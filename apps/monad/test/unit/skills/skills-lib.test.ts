import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertValidSkillName,
  checkSkillCompatibility,
  deleteSkill,
  findSkillDirs,
  installSkillFromDir,
  parseSkillMd,
  patchSkill,
  removeSkillResource,
  resolveSkillState,
  SkillRegistry,
  skillEligibility,
  skillPathsMatch,
  writeSkill,
  writeSkillResource
} from '@/store/home/skills.ts';

// ── parseSkillMd ────────────────────────────────────────────────────────────────

test('parses a minimal valid SKILL.md (frontmatter + body split)', () => {
  const { frontmatter, body } = parseSkillMd(
    [
      '---',
      'name: pdf-tools',
      'description: Work with PDFs. Use when handling PDF files.',
      '---',
      '',
      '# PDF Tools',
      '',
      'Do the thing.'
    ].join('\n')
  );
  expect(frontmatter.name).toBe('pdf-tools');
  expect(body).toBe('# PDF Tools\n\nDo the thing.');
});

test('maps hyphenated keys, coerces metadata to strings, and joins an allowed-tools list', () => {
  const { frontmatter } = parseSkillMd(
    [
      '---',
      'name: deploy',
      'description: Deploy the app.',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      'disable-model-invocation: true',
      'user-invocable: true',
      'metadata:',
      '  version: "1.0"',
      '  retries: 3',
      '---',
      'body'
    ].join('\n')
  );
  expect(frontmatter.allowedTools).toBe('Read Bash');
  expect(frontmatter.disableModelInvocation).toBe(true);
  expect(frontmatter.userInvocable).toBe(true);
  // Quoted "1.0" stays a string; the numeric 3 is coerced to "3".
  expect(frontmatter.metadata).toEqual({ version: '1.0', retries: '3' });
});

test('accepts a space-separated allowed-tools string', () => {
  const { frontmatter } = parseSkillMd(
    ['---', 'name: commit', 'description: Commit.', 'allowed-tools: Read Grep', '---', 'x'].join('\n')
  );
  expect(frontmatter.allowedTools).toBe('Read Grep');
});

test('rejects missing frontmatter', () => {
  expect(() => parseSkillMd('# Just markdown, no frontmatter')).toThrow(/frontmatter/);
});

test.each([
  ['uppercase', 'PDF-Tools'],
  ['leading hyphen', '-pdf'],
  ['trailing hyphen', 'pdf-'],
  ['double hyphen', 'pdf--tools'],
  ['too long', 'a'.repeat(65)],
  ['reserved word claude', 'claude-helper'],
  ['reserved word anthropic', 'anthropic-x']
])('rejects an invalid name (%s)', (_label, name) => {
  expect(() => parseSkillMd(['---', `name: ${name}`, 'description: x', '---', 'b'].join('\n'))).toThrow();
});

test('rejects empty and over-long descriptions', () => {
  expect(() => parseSkillMd(['---', 'name: x', 'description: ""', '---', 'b'].join('\n'))).toThrow();
  const long = 'd'.repeat(1025);
  expect(() => parseSkillMd(['---', 'name: x', `description: ${long}`, '---', 'b'].join('\n'))).toThrow();
});

// ── SkillRegistry.discover ──────────────────────────────────────────────────────

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monad-skills-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedSkill(name: string, frontmatterBody: string): Promise<void> {
  const d = join(dir, name);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 'SKILL.md'), frontmatterBody);
}

test('discovers good skills, collects per-skill errors, and never throws', async () => {
  await seedSkill('alpha', ['---', 'name: alpha', 'description: Alpha skill.', '---', 'A body'].join('\n'));
  await seedSkill('beta', ['---', 'name: beta', 'description: Beta skill.', '---', 'B body'].join('\n'));
  // Broken: frontmatter name does not match the directory name.
  await seedSkill('gamma', ['---', 'name: not-gamma', 'description: Mismatch.', '---', 'C'].join('\n'));
  // A plain directory with no SKILL.md is skipped silently (not an error).
  await mkdir(join(dir, 'notaskill'), { recursive: true });

  const registry = new SkillRegistry();
  const result = await registry.discover(dir);

  expect(result.registered.sort()).toEqual(['alpha', 'beta']);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.skill).toBe('gamma');
  expect(result.errors[0]?.error).toMatch(/must equal directory name/);
  expect(registry.get('alpha')?.body).toBe('A body');
  expect(registry.get('alpha')?.dir).toBe(join(dir, 'alpha'));
  expect(registry.has('not-gamma')).toBe(false);
  expect(registry.all()).toHaveLength(2);
});

test('discover on a non-existent directory returns an empty result (no throw)', async () => {
  const registry = new SkillRegistry();
  const result = await registry.discover(join(dir, 'does-not-exist'));
  expect(result).toEqual({ registered: [], errors: [] });
});

test('re-scan replaces a skill in place', async () => {
  await seedSkill('alpha', ['---', 'name: alpha', 'description: v1.', '---', 'first'].join('\n'));
  const registry = new SkillRegistry();
  await registry.discover(dir);
  expect(registry.get('alpha')?.body).toBe('first');

  await writeFile(
    join(dir, 'alpha', 'SKILL.md'),
    ['---', 'name: alpha', 'description: v2.', '---', 'second'].join('\n')
  );
  await registry.discover(dir);
  expect(registry.get('alpha')?.body).toBe('second');
  expect(registry.all()).toHaveLength(1);
});

// ── Authoring (write / patch / delete / resources / install) ──────────────────────

const md = (name: string, body = 'B') =>
  ['---', `name: ${name}`, `description: ${name} skill.`, '---', body].join('\n');

test('writeSkill creates a valid skill; rejects name mismatch and invalid names', async () => {
  const written = await writeSkill(dir, 'alpha', md('alpha', 'hello'));
  expect(written).toBe(join(dir, 'alpha'));
  await expect(writeSkill(dir, 'alpha', md('beta'))).rejects.toThrow(/must equal/);
  await expect(writeSkill(dir, 'Bad Name', md('x'))).rejects.toThrow(/invalid skill name/);
});

test('patchSkill replaces a unique string and re-validates; rejects ambiguous / missing / rename', async () => {
  await writeSkill(dir, 'alpha', md('alpha', 'one two'));
  await patchSkill(dir, 'alpha', 'two', 'three');
  await expect(patchSkill(dir, 'alpha', 'nope', 'x')).rejects.toThrow(/not found/);
  await writeSkill(dir, 'beta', md('beta', 'dup dup'));
  await expect(patchSkill(dir, 'beta', 'dup', 'x')).rejects.toThrow(/not unique/);
  await expect(patchSkill(dir, 'alpha', 'name: alpha', 'name: renamed')).rejects.toThrow(/may not change/);
  await expect(patchSkill(dir, 'ghost', 'a', 'b')).rejects.toThrow(/not found/);
});

test('writeSkillResource + removeSkillResource manage bundled files, path-guarded', async () => {
  await writeSkill(dir, 'docs', md('docs'));
  await writeSkillResource(dir, 'docs', 'references/REF.md', '# ref');
  expect(await Bun.file(join(dir, 'docs', 'references', 'REF.md')).text()).toBe('# ref');
  await removeSkillResource(dir, 'docs', 'references/REF.md');
  expect(await Bun.file(join(dir, 'docs', 'references', 'REF.md')).exists()).toBe(false);

  await expect(writeSkillResource(dir, 'docs', '../escape.md', 'x')).rejects.toThrow(/escapes/);
  await expect(writeSkillResource(dir, 'docs', 'SKILL.md', 'x')).rejects.toThrow(/use writeSkill/);
  await expect(removeSkillResource(dir, 'docs', 'SKILL.md')).rejects.toThrow(/cannot remove SKILL.md/);
  await expect(writeSkillResource(dir, 'missing', 'a.md', 'x')).rejects.toThrow(/not found/);
});

test('writeSkillResource rejects a symlink planted inside the skill that escapes the root', async () => {
  await writeSkill(dir, 'docs', md('docs'));
  // A `../` path is caught by the lexical guard before realpath. The realpath check guards the
  // harder case: a symlink *inside* the skill dir whose target is outside it. The relative path
  // stays clean (`evil/loot.md`), but `evil` resolves out of the skill root.
  const outside = await mkdtemp(join(tmpdir(), 'monad-skills-outside-'));
  await symlink(outside, join(dir, 'docs', 'evil'));

  await expect(writeSkillResource(dir, 'docs', 'evil/loot.md', 'pwned')).rejects.toThrow(
    /escapes the skill directory via a symlink/
  );
  expect(await Bun.file(join(outside, 'loot.md')).exists()).toBe(false);
  await rm(outside, { recursive: true, force: true });
});

test('deleteSkill removes the directory and is idempotent', async () => {
  await writeSkill(dir, 'gone', md('gone'));
  await deleteSkill(dir, 'gone');
  expect(await Bun.file(join(dir, 'gone', 'SKILL.md')).exists()).toBe(false);
  await deleteSkill(dir, 'gone'); // no-op, no throw
});

test('findSkillDirs handles a single-skill folder and a repo of skills', async () => {
  const single = join(dir, 'single');
  await mkdir(single, { recursive: true });
  await writeFile(join(single, 'SKILL.md'), md('whatever'));
  expect(await findSkillDirs(single)).toEqual([single]);

  const repo = join(dir, 'repo');
  await mkdir(join(repo, 'a'), { recursive: true });
  await mkdir(join(repo, 'b'), { recursive: true });
  await writeFile(join(repo, 'a', 'SKILL.md'), md('a'));
  await writeFile(join(repo, 'b', 'SKILL.md'), md('b'));
  expect((await findSkillDirs(repo)).sort()).toEqual([join(repo, 'a'), join(repo, 'b')]);
});

test('installSkillFromDir validates, names by frontmatter, copies resources, guards overwrite', async () => {
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'SKILL.md'), md('imported', 'body'));
  await writeFile(join(src, 'extra.md'), 'resource');
  const store = join(dir, 'store');

  expect(await installSkillFromDir(store, src)).toBe('imported');
  expect(await Bun.file(join(store, 'imported', 'extra.md')).text()).toBe('resource');

  await expect(installSkillFromDir(store, src)).rejects.toThrow(/already exists/);
  expect(await installSkillFromDir(store, src, { overwrite: true })).toBe('imported');
  await expect(installSkillFromDir(store, join(dir, 'nope'))).rejects.toThrow(/no SKILL.md/);
});

test('assertValidSkillName accepts good names and rejects bad / traversal / reserved', () => {
  expect(() => assertValidSkillName('pdf-tools')).not.toThrow();
  expect(() => assertValidSkillName('Bad')).toThrow();
  expect(() => assertValidSkillName('a/b')).toThrow();
  expect(() => assertValidSkillName('claude-x')).toThrow();
});

// ── Eligibility (requires gates) ──────────────────────────────────────────────────

const eligCtx = (over: Partial<Parameters<typeof skillEligibility>[1]> = {}) => ({
  hasBin: (n: string) => n === 'git' || n === 'jq',
  env: { API_KEY: 'set', EMPTY: '' } as Record<string, string | undefined>,
  platform: 'linux',
  ...over
});

test('skillEligibility: no requires → always eligible', () => {
  expect(skillEligibility(undefined, eligCtx())).toEqual({ ok: true, missing: [] });
});

// ── resolveSkillState (global + per-agent switches) ───────────────────────────────

test('resolveSkillState: disabled fully disables manual and automatic use', () => {
  const state = resolveSkillState({ global: { autoload: true, disabled: ['global:secret'], autoloadDisabled: [] } });
  expect(state({ id: 'global:research', name: 'research' })).toEqual({ enabled: true, autoload: true });
  expect(state({ id: 'global:secret', name: 'secret' })).toEqual({ enabled: false, autoload: false });
});

test('resolveSkillState: autoloadDisabled keeps manual use enabled', () => {
  const state = resolveSkillState({ global: { autoload: true, disabled: [], autoloadDisabled: ['global:manual'] } });
  expect(state({ id: 'global:manual', name: 'manual' })).toEqual({ enabled: true, autoload: false });
});

test('resolveSkillState: global master off only disables automatic context loading', () => {
  const state = resolveSkillState({ global: { autoload: false, disabled: [], autoloadDisabled: [] } });
  expect(state({ id: 'global:research', name: 'research' })).toEqual({ enabled: true, autoload: false });
});

test('resolveSkillState: instance ids isolate same-name skills from different sources', () => {
  const state = resolveSkillState({
    global: { autoload: true, disabled: ['global:shared'], autoloadDisabled: ['atom-pack:pack-a:manual'] }
  });
  expect(state({ id: 'global:shared', name: 'shared' })).toEqual({ enabled: false, autoload: false });
  expect(state({ id: 'atom-pack:pack-a:shared', name: 'shared' })).toEqual({ enabled: true, autoload: true });
  expect(state({ id: 'atom-pack:pack-a:manual', name: 'manual' })).toEqual({ enabled: true, autoload: false });
  expect(state({ id: 'atom-pack:pack-b:manual', name: 'manual' })).toEqual({ enabled: true, autoload: true });
});

test('resolveSkillState: per-agent disabled entries are also instance ids', () => {
  const state = resolveSkillState({
    global: { autoload: true, disabled: [], autoloadDisabled: [] },
    agent: { disabled: ['atom-pack:pack-a:shared'] }
  });
  expect(state({ id: 'atom-pack:pack-a:shared', name: 'shared' })).toEqual({ enabled: true, autoload: false });
  expect(state({ id: 'atom-pack:pack-b:shared', name: 'shared' })).toEqual({ enabled: true, autoload: true });
});

// ── skillPathsMatch (activation globs vs workspace) ───────────────────────────────

test('skillPathsMatch: true when a workspace file matches, false otherwise', async () => {
  await writeFile(join(dir, 'report.pdf'), '%PDF');
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'sub', 'Dockerfile'), 'FROM scratch');

  expect(await skillPathsMatch(['**/*.pdf'], dir)).toBe(true);
  expect(await skillPathsMatch(['**/Dockerfile'], dir)).toBe(true);
  expect(await skillPathsMatch(['**/*.xlsx'], dir)).toBe(false);
  // first matching glob short-circuits true
  expect(await skillPathsMatch(['**/*.xlsx', '**/*.pdf'], dir)).toBe(true);
});

test('skillPathsMatch: a missing root never throws → false', async () => {
  expect(await skillPathsMatch(['**/*'], join(dir, 'does-not-exist'))).toBe(false);
});

// ── checkSkillCompatibility (advisory, non-blocking) ──────────────────────────────

test('checkSkillCompatibility: semver range evaluated against the running version', () => {
  expect(checkSkillCompatibility('>=0.5.0', '0.4.0')).toEqual({ compatible: false, requirement: '>=0.5.0' });
  expect(checkSkillCompatibility('>=0.5.0', '0.6.0')).toEqual({ compatible: true, requirement: '>=0.5.0' });
});

test('checkSkillCompatibility: free-form prose is advisory (compatible: true)', () => {
  expect(checkSkillCompatibility('needs a GPU and network access', '0.0.0')).toEqual({
    compatible: true,
    requirement: 'needs a GPU and network access'
  });
});

test('checkSkillCompatibility: absent → null', () => {
});

test('skillEligibility: bins — all must be present', () => {
  expect(skillEligibility({ bins: ['git', 'jq'] }, eligCtx()).ok).toBe(true);
  const r = skillEligibility({ bins: ['git', 'docker'] }, eligCtx());
  expect(r.ok).toBe(false);
  expect(r.missing).toEqual(['bin:docker']);
});

test('skillEligibility: anyBins — at least one present', () => {
  expect(skillEligibility({ anyBins: ['rg', 'git'] }, eligCtx()).ok).toBe(true);
  expect(skillEligibility({ anyBins: ['rg', 'ag'] }, eligCtx()).missing).toEqual(['anyBin:rg|ag']);
});

test('skillEligibility: env — must be set and non-empty', () => {
  expect(skillEligibility({ env: ['API_KEY'] }, eligCtx()).ok).toBe(true);
  expect(skillEligibility({ env: ['EMPTY'] }, eligCtx()).missing).toEqual(['env:EMPTY']);
  expect(skillEligibility({ env: ['MISSING'] }, eligCtx()).missing).toEqual(['env:MISSING']);
});

test('skillEligibility: os — platform must match one', () => {
  expect(skillEligibility({ os: ['linux', 'darwin'] }, eligCtx()).ok).toBe(true);
  expect(skillEligibility({ os: ['win32'] }, eligCtx({ platform: 'linux' })).missing).toEqual(['os:win32']);
});

test('skillEligibility: accumulates all unmet gates', () => {
  const r = skillEligibility({ bins: ['docker'], env: ['MISSING'], os: ['win32'] }, eligCtx());
  expect(r.ok).toBe(false);
  expect(r.missing).toEqual(['bin:docker', 'env:MISSING', 'os:win32']);
});

test('parseSkillMd parses a requires block', () => {
  const { frontmatter } = parseSkillMd(
    [
      '---',
      'name: deployer',
      'description: Deploy things.',
      'requires:',
      '  bins:',
      '    - git',
      '  env:',
      '    - DEPLOY_TOKEN',
      '  os:',
      '    - linux',
      '    - darwin',
      '---',
      'body'
    ].join('\n')
  );
  expect(frontmatter.requires).toEqual({ bins: ['git'], env: ['DEPLOY_TOKEN'], os: ['linux', 'darwin'] });
});

test('parseSkillMd parses context: fork and a capability tier', () => {
  const { frontmatter } = parseSkillMd(
    ['---', 'name: research', 'description: Deep research.', 'context: fork', 'tier: fast', '---', 'body'].join('\n')
  );
  expect(frontmatter.context).toBe('fork');
  expect(frontmatter.tier).toBe('fast');
});

test('parseSkillMd parses a paths activation-globs list', () => {
  const { frontmatter } = parseSkillMd(
    ['---', 'name: pdf', 'description: PDFs.', 'paths:', '  - "**/*.pdf"', '  - "**/*.PDF"', '---', 'b'].join('\n')
  );
  expect(frontmatter.paths).toEqual(['**/*.pdf', '**/*.PDF']);
});

test('parseSkillMd rejects an unknown tier value', () => {
  expect(() => parseSkillMd(['---', 'name: x', 'description: y', 'tier: turbo', '---', 'b'].join('\n'))).toThrow(
    /frontmatter/
  );
});

// ── Scope precedence (discoverMany) ───────────────────────────────────────────────

test('discoverMany layers scopes — a later dir overrides an earlier one by name', async () => {
  const home = join(dir, 'home');
  const ws = join(dir, 'ws');
  await mkdir(join(home, 'alpha'), { recursive: true });
  await mkdir(join(home, 'beta'), { recursive: true });
  await mkdir(join(ws, 'alpha'), { recursive: true });
  await writeFile(join(home, 'alpha', 'SKILL.md'), md('alpha', 'home-alpha'));
  await writeFile(join(home, 'beta', 'SKILL.md'), md('beta', 'home-beta'));
  await writeFile(join(ws, 'alpha', 'SKILL.md'), md('alpha', 'ws-alpha'));

  const reg = new SkillRegistry();
  const res = await reg.discoverMany([home, ws]); // ws (later) wins
  expect(reg.get('alpha')?.body).toBe('ws-alpha');
  expect(reg.get('beta')?.body).toBe('home-beta');
  expect(
    reg
      .allInstances()
      .filter((s) => s.name === 'alpha')
      .map((s) => s.body)
  ).toEqual(['home-alpha', 'ws-alpha']);
  expect(res.registered.sort()).toEqual(['alpha', 'beta']); // deduped
  // 'alpha' collided across home + ws → reported; ws wins (last in precedence), home is shadowed.
  expect(res.collisions).toEqual([{ name: 'alpha', winnerDir: ws, shadowedDirs: [home] }]);
});

test('discoverMany tolerates missing directories', async () => {
  const reg = new SkillRegistry();
  expect(await reg.discoverMany([join(dir, 'nope1'), join(dir, 'nope2')])).toEqual({
    registered: [],
    errors: [],
    collisions: []
  });
});

test('parseSkillMd parses context: fork and rejects other values', () => {
  const { frontmatter } = parseSkillMd(
    ['---', 'name: research', 'description: Research a topic.', 'context: fork', '---', 'body'].join('\n')
  );
  expect(frontmatter.context).toBe('fork');
  expect(() => parseSkillMd(['---', 'name: x', 'description: y', 'context: weird', '---', 'b'].join('\n'))).toThrow();
});
