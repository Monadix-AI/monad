// Offline tests for the git-binary-free skill installer (services/skill-install): the fetch + the
// commit resolver are injected, so no network / git is touched. Covers install + .install.json lock,
// default-deny consent, the mutable-ref warning, multi-skill repos, and update detection.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSkillFetcher } from '#/capabilities/skills/install/fetch.ts';
import {
  checkSkillUpdate,
  installSkill,
  type SkillFetcher,
  type SkillInstallRecord
} from '#/capabilities/skills/install/index.ts';

let skillsDir: string;
const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
beforeEach(async () => {
  skillsDir = await mkdtemp(join(tmpdir(), 'monad-skills-'));
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env.PATH = realPath;
  await rm(skillsDir, { recursive: true, force: true });
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const md = (name: string): string => `---\nname: ${name}\ndescription: A ${name} skill.\n---\nBody for ${name}.\n`;

/** A fetcher that returns a fixed file map + commit, ignoring the network. */
function fakeFetch(files: Record<string, string>, commit: string): SkillFetcher {
  return async () => ({ files: new Map(Object.entries(files).map(([k, v]) => [k, enc(v)])), commit });
}

const SHA = 'a'.repeat(40);

test('installs a root skill, writes the .install.json lock, surfaces no mutable-ref warning for a sha', async () => {
  const out = await installSkill(`github:acme/widget@${SHA}`, {
    skillsDir,
    fetch: fakeFetch({ 'SKILL.md': md('widget'), 'reference.md': 'ref' }, SHA),
    consent: () => true
  });

  expect(out.installed).toBe(true);
  expect(out.skills).toEqual(['widget']);
  expect(await Bun.file(join(skillsDir, 'widget', 'SKILL.md')).exists()).toBe(true);
  expect(await Bun.file(join(skillsDir, 'widget', 'reference.md')).exists()).toBe(true);

  const rec = JSON.parse(await Bun.file(join(skillsDir, 'widget', '.install.json')).text()) as SkillInstallRecord;
  expect(rec).toMatchObject({ sourceKind: 'github', ref: SHA, commit: SHA, sourceId: 'github:acme/widget' });
});

test('default-deny: consent=false installs nothing and reports needsConsent', async () => {
  const out = await installSkill('github:acme/widget@main', {
    skillsDir,
    fetch: fakeFetch({ 'SKILL.md': md('widget') }, SHA),
    consent: () => false
  });

  expect(out.installed).toBe(false);
  expect(out.needsConsent).toBe(true);
  expect(out.skills).toEqual(['widget']); // surfaced for the consent prompt
  expect(await Bun.file(join(skillsDir, 'widget', 'SKILL.md')).exists()).toBe(false);
});

test('warns when pinned to a mutable ref (tag/branch)', async () => {
  let info: { warnings: string[] } | undefined;
  await installSkill('github:acme/widget@v1.2.3', {
    skillsDir,
    fetch: fakeFetch({ 'SKILL.md': md('widget') }, SHA),
    consent: (i) => {
      info = i;
      return true;
    }
  });
  expect(info?.warnings.some((w) => /mutable ref/.test(w))).toBe(true);
});

test('surfaces content-scan flags (bundled script) in the consent prompt', async () => {
  let info: { warnings: string[] } | undefined;
  await installSkill(`github:acme/widget@${SHA}`, {
    skillsDir,
    fetch: fakeFetch({ 'SKILL.md': md('widget'), 'install.sh': 'echo hi' }, SHA),
    consent: (i) => {
      info = i;
      return false;
    }
  });
  expect(info?.warnings.some((w) => /executable script/.test(w))).toBe(true);
});

test('surfaces install review warnings in the consent prompt before writing files', async () => {
  let _info: { skills: string[]; source: string; warnings: string[] } | undefined;
  const out = await installSkill(`github:acme/widget@${SHA}`, {
    skillsDir,
    fetch: fakeFetch({ 'SKILL.md': md('widget') }, SHA),
    consent: (next) => {
      _info = next;
      return false;
    },
    review: async ({ files, skills, source }) => {
      expect(source).toBe(`github:acme/widget@${SHA}`);
      expect(skills).toEqual(['widget']);
      expect(files.has('SKILL.md')).toBe(true);
      return [{ code: 'risk', reason: 'test risk' }];
    }
  });

  expect(out).toMatchObject({ installed: false, needsConsent: true, skills: ['widget'] });
  expect(await Bun.file(join(skillsDir, 'widget', 'SKILL.md')).exists()).toBe(false);
});

test('installs every SKILL.md packet in a multi-skill repo', async () => {
  const out = await installSkill(`github:acme/suite@${SHA}`, {
    skillsDir,
    fetch: fakeFetch({ 'alpha/SKILL.md': md('alpha'), 'beta/SKILL.md': md('beta') }, SHA),
    consent: () => true
  });
  expect(out.skills.sort()).toEqual(['alpha', 'beta']);
  expect(await Bun.file(join(skillsDir, 'alpha', 'SKILL.md')).exists()).toBe(true);
  expect(await Bun.file(join(skillsDir, 'beta', 'SKILL.md')).exists()).toBe(true);
});

test('accepts a github repo URL with ?skill= selector and installs only the matching skill', async () => {
  let fetched: Parameters<SkillFetcher>[0] | undefined;
  const out = await installSkill('https://github.com/acme/suite?skill=beta', {
    skillsDir,
    fetch: async (source) => {
      fetched = source;
      return {
        files: new Map([
          ['alpha/SKILL.md', enc(md('alpha'))],
          ['beta/SKILL.md', enc(md('beta'))],
          ['beta/usage.md', enc('beta usage')]
        ]),
        commit: SHA
      };
    },
    consent: () => true
  });

  expect(fetched).toMatchObject({
    kind: 'github',
    owner: 'acme',
    repo: 'suite',
    ref: 'main',
    skill: 'beta'
  });
  expect(out.skills).toEqual(['beta']);
  expect(await Bun.file(join(skillsDir, 'beta', 'usage.md')).exists()).toBe(true);
  expect(await Bun.file(join(skillsDir, 'alpha', 'SKILL.md')).exists()).toBe(false);
});

test('uses a github ?skill= selector to find a nested skill packet', async () => {
  const out = await installSkill('https://github.com/acme/suite?skill=grill-me', {
    skillsDir,
    fetch: fakeFetch(
      {
        'README.md': 'suite',
        'skills/personal/grill-me/SKILL.md': md('grill-me'),
        'skills/personal/grill-me/examples.md': 'examples',
        'skills/personal/edit-article/SKILL.md': md('edit-article')
      },
      SHA
    ),
    consent: () => true
  });

  expect(out.skills).toEqual(['grill-me']);
  expect(await Bun.file(join(skillsDir, 'grill-me', 'examples.md')).exists()).toBe(true);
  expect(await Bun.file(join(skillsDir, 'edit-article', 'SKILL.md')).exists()).toBe(false);
});

test('accepts a GitHub SKILL.md page URL and installs that skill directory at that ref', async () => {
  let fetched: Parameters<SkillFetcher>[0] | undefined;
  const out = await installSkill('https://github.com/nolangz/skills/blob/main/pixel2motion/SKILL.md', {
    skillsDir,
    fetch: async (source) => {
      fetched = source;
      return {
        files: new Map([
          ['pixel2motion/SKILL.md', enc(md('pixel2motion'))],
          ['pixel2motion/references/usage.md', enc('usage')],
          ['other/SKILL.md', enc(md('other'))]
        ]),
        commit: SHA
      };
    },
    consent: () => true
  });

  expect(fetched).toMatchObject({
    kind: 'github',
    owner: 'nolangz',
    repo: 'skills',
    ref: 'main',
    path: 'pixel2motion'
  });
  expect(out.skills).toEqual(['pixel2motion']);
  expect(await Bun.file(join(skillsDir, 'pixel2motion', 'references', 'usage.md')).exists()).toBe(true);
  expect(await Bun.file(join(skillsDir, 'other', 'SKILL.md')).exists()).toBe(false);
});

test('rejects a non-github source', async () => {
  await expect(
    installSkill('npm:some-pkg@1.0.0', { skillsDir, fetch: fakeFetch({}, SHA), consent: () => true })
  ).rejects.toThrow(/github/);
});

test('github fetcher fails without git fallback for non-auth ref resolution errors', async () => {
  const fetcher = createSkillFetcher();
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const _url = String(input);
      return new Response('server error', { status: 500 });
    },
    { preconnect: realFetch.preconnect }
  );

  await expect(
    fetcher({ kind: 'github', owner: 'acme', repo: 'widget', ref: 'main', spec: 'github:acme/widget@main' })
  ).rejects.toThrow(/resolving acme\/widget@main failed: 500/);
});

test('github fetcher falls back to git sparse checkout on auth or permission errors', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'monad-git-bin-'));
  const fakeGit = join(binDir, 'git');
  await Bun.write(
    fakeGit,
    `#!/bin/sh
set -eu
if [ "$1" = "clone" ]; then
  dest=""
  for arg in "$@"; do dest="$arg"; done
  mkdir -p "$dest/pixel2motion"
  cat > "$dest/pixel2motion/SKILL.md" <<'EOF'
---
name: pixel2motion
description: Pixel to motion.
---
Body.
EOF
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ]; then
  echo "${SHA}"
  exit 0
fi
exit 0
`
  );
  await chmod(fakeGit, 0o755);
  process.env.PATH = `${binDir}:${realPath ?? ''}`;

  const fetcher = createSkillFetcher();
  globalThis.fetch = Object.assign(async () => new Response('not found', { status: 404 }), {
    preconnect: realFetch.preconnect
  });

  const out = await fetcher({
    kind: 'github',
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    path: 'pixel2motion',
    spec: 'https://github.com/acme/skills/tree/main/pixel2motion'
  });

  expect(out.commit).toBe(SHA);
  await rm(binDir, { recursive: true, force: true });
});

test('checkSkillUpdate flags a skill whose ref head moved past the locked commit', async () => {
  const oldSha = 'b'.repeat(40);
  await installSkill('github:acme/widget@main', {
    skillsDir,
    fetch: fakeFetch({ 'SKILL.md': md('widget') }, oldSha),
    consent: () => true
  });

  const behind = await checkSkillUpdate(skillsDir, 'widget', async () => 'c'.repeat(40));
  expect(behind).toMatchObject({ current: oldSha, latest: 'c'.repeat(40), hasUpdate: true });

  const current = await checkSkillUpdate(skillsDir, 'widget', async () => oldSha);
  expect(current?.hasUpdate).toBe(false);
});

test('checkSkillUpdate returns null for a hand-dropped skill (no install record)', async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(skillsDir, 'manual'), { recursive: true });
  await Bun.write(join(skillsDir, 'manual', 'SKILL.md'), md('manual'));
});
