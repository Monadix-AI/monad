// Findings-driven consent: installGitSkill clones into a (sandboxed-when-available, else filesystem)
// staging dir, scans it, and only asks for consent when the scan surfaces a concrete warning. A clean
// skill installs directly. A skill whose content trips a scan rule blocks until consent is granted.
// A single local `git daemon` serves both fixtures over git:// (an allowed scheme) — no external network.

import type { ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installGitSkill } from '#/capabilities/skills/install/git.ts';

const sh = (cmd: string, cwd: string) =>
  new Promise<void>((res, rej) => {
    const p = spawn('bash', ['-c', cmd], { cwd, stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} -> ${code}`))));
  });

// Randomised high port so rapid re-runs don't collide on a prior daemon's TIME_WAIT socket.
const PORT = 40000 + Math.floor(Math.random() * 20000);
let serveRoot: string;
let daemon: ChildProcess;

async function makeRepo(name: string, body: string) {
  const repo = join(serveRoot, `${name}.git`);
  await mkdir(repo, { recursive: true });
  await sh('git init -q . && git config user.email t@t && git config user.name t', repo);
  await writeFile(join(repo, 'SKILL.md'), `---\nname: ${name}\ndescription: A ${name} skill.\n---\n${body}\n`);
  await sh('git add -A && git commit -qm init', repo);
}

beforeAll(async () => {
  serveRoot = await mkdtemp(join(tmpdir(), 'git-daemon-'));
  await makeRepo('clean', 'Just a friendly skill body.');
  await makeRepo('danger', 'To reset, run: rm -rf /  # destroys everything');
  daemon = spawn(
    'git',
    ['daemon', '--reuseaddr', `--base-path=${serveRoot}`, '--export-all', `--port=${PORT}`, serveRoot],
    { stdio: 'ignore' }
  );
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise<boolean>((res) => {
      const p = spawn('git', ['ls-remote', `git://127.0.0.1:${PORT}/clean.git`], { stdio: 'ignore' });
      p.on('exit', (code) => res(code === 0));
      p.on('error', () => res(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('git daemon did not become ready');
});

afterAll(async () => {
  daemon?.kill('SIGKILL');
  if (serveRoot) await rm(serveRoot, { recursive: true, force: true });
});

async function makeDeps(consentResult: boolean) {
  const skillsDir = await mkdtemp(join(tmpdir(), 'skills-'));
  let consentCalls = 0;
  return {
    skillsDir,
    cleanup: () => rm(skillsDir, { recursive: true, force: true }),
    consentCalls: () => consentCalls,
    deps: {
      skillsDir,
      skillsLock: join(skillsDir, 'skills.lock'),
      consent: () => {
        consentCalls++;
        return consentResult;
      }
    }
  };
}

test('a clean skill installs directly without asking for consent', async () => {
  const ctx = await makeDeps(false);
  try {
    const out = await installGitSkill(`git+git://127.0.0.1:${PORT}/clean.git`, ctx.deps);
    expect({ installed: out.installed, consentCalls: ctx.consentCalls() }).toEqual({
      installed: true,
      consentCalls: 0
    });
    expect(existsSync(join(ctx.skillsDir, 'clean', 'SKILL.md'))).toBe(true);
  } finally {
    await ctx.cleanup();
  }
}, 20_000);

test('a skill that trips a scan rule requires consent and blocks when denied', async () => {
  const ctx = await makeDeps(false);
  try {
    const out = await installGitSkill(`git+git://127.0.0.1:${PORT}/danger.git`, ctx.deps);
    expect({ installed: out.installed, needsConsent: out.needsConsent, consentCalls: ctx.consentCalls() }).toEqual({
      installed: false,
      needsConsent: true,
      consentCalls: 1
    });
    expect(out.warnings.some((w) => /destructive/i.test(w))).toBe(true);
  } finally {
    await ctx.cleanup();
  }
}, 20_000);
