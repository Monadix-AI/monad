import type { SkillInstallReviewer } from '#/capabilities/skills/install/index.ts';

import { lstat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxPolicy, sandboxedSpawn, sandboxLauncher } from '@monad/sandbox';
import { z } from 'zod';

import { upsertSkillsLock } from '#/capabilities/skills/install/clawhub.ts';
import { assertStagingCompatibility } from '#/capabilities/skills/install/compat.ts';
import { warningModelRequestFailed, warningsToStrings } from '#/capabilities/skills/install/review.ts';
import { scanSkillDir } from '#/capabilities/skills/install/scan.ts';
import { findSkillDirs, installSkillFromDir, parseSkillMd } from '#/store/home/skills.ts';

const gitSkillRecordSchema = z
  .object({
    source: z.string(),
    sourceKind: z.literal('git'),
    commit: z.string(),
    installedAt: z.string()
  })
  .loose();
type GitSkillRecord = z.infer<typeof gitSkillRecordSchema>;

const MAX_REVIEW_CHARS = 48_000;
const MAX_REVIEW_BYTES_PER_FILE = 64 * 1024;

async function collectReviewFiles(stagingDir: string, maxChars: number): Promise<Map<string, Uint8Array>> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  let remaining = maxChars;

  for await (const rel of new Bun.Glob('**/*').scan({ cwd: stagingDir, onlyFiles: true })) {
    if (remaining <= 0) break;

    const abs = join(stagingDir, rel);
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) continue;

    const maxBytes = Math.min(remaining * 4, MAX_REVIEW_BYTES_PER_FILE);
    if (maxBytes <= 0) break;

    const bytes = new Uint8Array(await Bun.file(abs).slice(0, maxBytes).arrayBuffer());
    if (bytes.includes(0)) continue;

    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      continue;
    }

    const trimmed = text.trim();
    if (!trimmed) continue;

    const slice = trimmed.slice(0, remaining);
    if (!slice) continue;

    files.set(rel, encoder.encode(slice));
    remaining -= slice.length;
  }

  return files;
}

export interface GitSkillInstallDeps {
  skillsDir: string;
  skillsLock: string;
  consent: (info: { skills: string[]; source: string; warnings: string[] }) => boolean | Promise<boolean>;
  review?: SkillInstallReviewer;
  overwrite?: boolean;
  now?: () => string;
}

export interface GitSkillInstallOutcome {
  skills: string[];
  warnings: string[];
  installed: boolean;
  needsConsent?: boolean;
  commit: string;
}

// `source` is fully attacker-controlled (POST /atoms/skills/install body, z.string().min(1)) and the
// git clone runs before any consent/scan gate. git's remote-helper transports execute code at clone
// time — `ext::sh -c "..."` spawns a shell, `fd::`/`file:` touch the host — so an unrestricted URL is
// remote code execution on the daemon host. Constrain the URL to network transports both at parse
// time (clear error) and via GIT_ALLOW_PROTOCOL, git's own backstop that also covers transports it
// resolves internally (submodule URLs, http redirects).
const GIT_ALLOWED_PROTOCOLS = 'https:http:git:ssh';
const gitSpawnEnv = (): Record<string, string | undefined> => ({
  ...Bun.env,
  GIT_ALLOW_PROTOCOL: GIT_ALLOWED_PROTOCOLS
});

// Graceful degradation: the clone runs in the OS sandbox when a launcher is active and available;
// otherwise it falls back to a plain filesystem clone rather than blocking the install. The boot-time
// selector only installs a non-'none' launcher after its isAvailable() probe passed, so the kind check
// is the reliable "sandbox usable on this host" signal.
function sandboxAvailable(): boolean {
  const launcher = sandboxLauncher();
  return launcher.kind !== 'none' && (launcher.isAvailable?.() ?? true);
}

// Run git through the OS sandbox seam (Seatbelt / Landlock+seccomp / Low-IL) instead of bare Bun.$.
// Even if a malicious source slips past assertSafeGitRef, the clone executes confined to the disposable
// staging dir, with the daemon's credential read-deny applied — so it cannot write outside staging,
// read ~/.ssh etc., or persist on the host. Network stays enabled (daemon net policy) so fetches work;
// the filesystem confinement is what neutralises the remaining host-damage surface. Required by
// docs/engineering/security-guidelines.md §8 ("use sandboxedSpawn, not bare Bun.spawn").
async function runGit(
  args: string[],
  opts: { writableRoots: string[]; confine?: boolean }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = sandboxedSpawn(
    ['git', ...args],
    { stdout: 'pipe', stderr: 'pipe', env: gitSpawnEnv() },
    buildSandboxPolicy(opts.writableRoots),
    // confine:false escapes the launcher entirely (default-mode install) — bare spawn, no overlay.
    { confine: opts.confine ?? true }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { stdout, stderr, exitCode };
}

/** Reject git refs that could execute code (ext::), read local files (file:/fd::), or inject CLI options. */
export function assertSafeGitRef(url: string, branch?: string): void {
  if (url.startsWith('-')) throw new Error(`Refusing git source that looks like a CLI option: ${url}`);
  if (branch?.startsWith('-')) throw new Error(`Refusing git branch that looks like a CLI option: ${branch}`);
  // Remote-helper transports take the form "<helper>::<address>" (e.g. ext::, fd::) and can run commands.
  if (/^[a-z][a-z0-9+.-]*::/i.test(url)) throw new Error(`Refusing git remote-helper transport: ${url}`);
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (schemeMatch) {
    const scheme = `${schemeMatch[1]?.toLowerCase()}:`;
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(scheme)) {
      throw new Error(`Refusing git source with disallowed scheme "${scheme}": ${url}`);
    }
    return;
  }
  // No explicit scheme: only scp-like syntax (user@host:path) is legitimate (ssh shorthand).
  if (!/^[^/@]+@[^/:]+:/.test(url)) throw new Error(`Refusing git source with unrecognized form: ${url}`);
}

/** Resolve the current HEAD commit of a remote git ref without cloning. */
async function resolveGitRemoteCommit(url: string, ref = 'HEAD'): Promise<string | null> {
  try {
    assertSafeGitRef(url);
    // ls-remote writes nothing; confine it to a throwaway writable surface (tmp only).
    const { stdout, exitCode } = await runGit(['ls-remote', url, ref], { writableRoots: [] });
    if (exitCode !== 0) return null;
    const line = stdout.split('\n').find((l) => l.trim());
    if (!line) return null;
    const hash = line.split('\t')[0];
    return hash?.trim() || null;
  } catch {
    return null;
  }
}

/** Parse a git+ ref into its URL and optional branch/tag. */
function parseGitRef(raw: string): { url: string; branch?: string } {
  // strip git+ prefix
  const loc = raw.startsWith('git+') ? raw.slice(4) : raw;
  // Find the last @ that's not inside the scheme (e.g. not https://)
  const schemeEnd = loc.indexOf('//') + 2;
  const atIdx = loc.lastIndexOf('@');
  if (atIdx > schemeEnd) {
    return { url: loc.slice(0, atIdx), branch: loc.slice(atIdx + 1) };
  }
  return { url: loc };
}

export async function installGitSkill(source: string, deps: GitSkillInstallDeps): Promise<GitSkillInstallOutcome> {
  const { url, branch } = parseGitRef(source);
  assertSafeGitRef(url, branch);
  const warnings: string[] = [];

  // Always stage the clone in a disposable temp dir and scan it there; the dir is destroyed in the
  // finally block. The clone is OS-sandboxed when a launcher is available and degrades to a plain
  // filesystem clone otherwise (never blocks). Consent is only required when the scan/review surfaces
  // a warning — installing is itself the user's intent, so a finding-free install proceeds directly.
  const confine = sandboxAvailable();
  const cloneDir = join(tmpdir(), `monad-skill-git-${Date.now()}`);
  await mkdir(cloneDir, { recursive: true });
  try {
    const branchArgs = branch ? ['--branch', branch] : [];
    const cloneResult = await runGit(['clone', '--depth', '1', ...branchArgs, url, cloneDir], {
      writableRoots: [cloneDir],
      confine
    });
    if (cloneResult.exitCode !== 0) {
      throw new Error(`git clone failed (${cloneResult.exitCode}): ${cloneResult.stderr.trim() || 'unknown error'}`);
    }
    const commit = (
      await runGit(['-C', cloneDir, 'rev-parse', 'HEAD'], { writableRoots: [cloneDir], confine })
    ).stdout.trim();
    const dirs = await findSkillDirs(cloneDir);
    const skills = await Promise.all(
      dirs.map(async (dir) => parseSkillMd(await Bun.file(join(dir, 'SKILL.md')).text()).frontmatter.name)
    );
    const [compatWarnings, scanWarnings] = await Promise.all([
      assertStagingCompatibility(cloneDir),
      scanSkillDir(cloneDir)
    ]);
    warnings.push(...compatWarnings, ...scanWarnings);
    if (deps.review) {
      try {
        const files = await collectReviewFiles(cloneDir, MAX_REVIEW_CHARS);
        warnings.push(...warningsToStrings(await deps.review({ files, skills, source })));
      } catch (error) {
        warnings.push(...warningsToStrings([warningModelRequestFailed(error)]));
      }
    }
    // Findings-driven consent: prompt only when the scan/review found something concrete. A clean
    // skill carries no incremental signal beyond "the user clicked install", so it installs directly.
    if (warnings.length > 0) {
      const granted = await deps.consent({ skills: skills.length ? skills : [url], source, warnings });
      if (!granted) {
        return { skills: skills.length ? skills : [url], warnings, installed: false, needsConsent: true, commit };
      }
    }
    const now = (deps.now ?? (() => new Date().toISOString()))();
    const record: GitSkillRecord = { source, sourceKind: 'git', commit, installedAt: now };
    const installed = await Promise.all(
      dirs.map(async (dir) => {
        const name = await installSkillFromDir(deps.skillsDir, dir, { overwrite: deps.overwrite });
        await Bun.write(join(deps.skillsDir, name, '.install.json'), `${JSON.stringify(record, null, 2)}\n`);
        await upsertSkillsLock(deps.skillsLock, name, record);
        return name;
      })
    );

    return { skills: installed, warnings, installed: true, commit };
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
  }
}

/** Check whether a git-tracked skill has a newer commit on its remote. */
export async function checkGitSkillUpdate(
  skillsDir: string,
  name: string
): Promise<{ name: string; ref: string; current: string; latest: string; hasUpdate: boolean } | null> {
  let rec: GitSkillRecord;
  try {
    const parsed = gitSkillRecordSchema.safeParse(
      JSON.parse(await Bun.file(join(skillsDir, name, '.install.json')).text())
    );
    if (!parsed.success) return null; // not a git record (other source / hand-dropped / malformed)
    rec = parsed.data;
  } catch {
    return null;
  }
  const { url, branch } = parseGitRef(rec.source);
  const latest = await resolveGitRemoteCommit(url, branch ?? 'HEAD');
  if (!latest) return null;
  return { name, ref: rec.source, current: rec.commit, latest, hasUpdate: latest !== rec.commit };
}
