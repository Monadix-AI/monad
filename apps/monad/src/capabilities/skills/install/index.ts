// Install skill atoms from a `github:owner/repo@<ref>` source into atoms/skills/, git-binary-free
// and version-locked. Pipeline: fetch tarball → stage to temp → discover SKILL.md packets →
// default-deny consent (lists skill names + a mutable-ref warning) → copy each into atoms/skills/
// + write a `.install.json` lock (source + ref + resolved commit) for later update detection. The
// daemon's reload watcher on atoms/skills picks the new skills up hot. fetch + consent are injected
// so the orchestrator is fully testable offline; the real fetcher lives in fetch.ts.

import type { Dirent } from 'node:fs';
import type { GithubSource } from '@monad/utils';

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { githubSourceIdentity, parseGithubSource } from '@monad/utils';
import { z } from 'zod';

import {
  type SkillInstallReviewWarning,
  warningModelRequestFailed,
  warningsToStrings
} from '#/capabilities/skills/install/review.ts';
import { scanSkillFiles } from '#/capabilities/skills/install/scan.ts';
import { findSkillDirs, installSkillFromDir, parseSkillMd } from '#/store/home/skills.ts';

export class SkillInstallError extends Error {}

/** A fetched-but-not-installed skill repo: its files (top-level archive dir stripped) + the full
 *  commit SHA the ref resolved to. */
export interface StagedSkillRepo {
  files: Map<string, Uint8Array>;
  commit: string;
}

export type SkillFetcher = (source: GithubSource) => Promise<StagedSkillRepo>;

interface SkillConsentInfo {
  skills: string[];
  source: string;
  ref: string;
  warnings: string[];
}

export type SkillInstallReviewer = (info: {
  files: Map<string, Uint8Array>;
  skills: string[];
  source: string;
}) => Promise<SkillInstallReviewWarning[]>;

export interface InstallSkillDeps {
  /** atoms/skills — the global-tier skills dir (paths.skills). */
  skillsDir: string;
  fetch: SkillFetcher;
  /** Default-deny: must return true to proceed. Receives the discovered skill names + warnings. */
  consent: (info: SkillConsentInfo) => boolean | Promise<boolean>;
  review?: SkillInstallReviewer;
  /** Replace an already-installed skill of the same name (otherwise that name is skipped + warned). */
  overwrite?: boolean;
  now?: () => string;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** Recorded next to each installed skill so updates can be detected (compare `commit` against the
 *  ref's current head) and the source is auditable. Schema-first: the `.install.json` on disk is an
 *  untrusted boundary, parsed (not cast) on read. */
export const skillInstallRecordSchema = z.object({
  source: z.string(),
  sourceId: z.string(),
  sourceKind: z.literal('github'),
  ref: z.string(),
  commit: z.string(),
  installedAt: z.string()
});
export type SkillInstallRecord = z.infer<typeof skillInstallRecordSchema>;

export interface InstallSkillOutcome {
  skills: string[];
  commit: string;
  warnings: string[];
  installed: boolean;
  needsConsent?: boolean;
}

async function skillNamesIn(dirs: string[]): Promise<string[]> {
  return Promise.all(dirs.map(async (d) => parseSkillMd(await Bun.file(join(d, 'SKILL.md')).text()).frontmatter.name));
}

async function findSkillDirsRecursive(root: string): Promise<string[]> {
  if (await Bun.file(join(root, 'SKILL.md')).exists()) return [root];
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { encoding: 'utf8', withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    dirs.push(...(await findSkillDirsRecursive(join(root, entry.name))));
  }
  return dirs;
}

async function selectSkillDirs(source: GithubSource, dirs: string[]): Promise<{ dirs: string[]; names: string[] }> {
  const names = await skillNamesIn(dirs);
  if (!source.skill) return { dirs, names };
  const selected = dirs
    .map((dir, index) => ({ dir, name: names[index] }))
    .filter((entry): entry is { dir: string; name: string } => entry.name === source.skill);
  if (selected.length === 0) {
    throw new SkillInstallError(`skill "${source.skill}" not found in ${source.spec}`);
  }
  return { dirs: selected.map((entry) => entry.dir), names: selected.map((entry) => entry.name) };
}

function filesForInstall(source: GithubSource, files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (!source.path) return files;
  const prefix = `${source.path.replace(/\/+$/, '')}/`;
  const scoped = new Map<string, Uint8Array>();
  for (const [rel, bytes] of files) {
    if (rel.startsWith(prefix)) scoped.set(rel.slice(prefix.length), bytes);
  }
  return scoped;
}

export async function installSkill(spec: string, deps: InstallSkillDeps): Promise<InstallSkillOutcome> {
  const source = parseGithubSource(spec);

  const staged = await deps.fetch(source);
  const files = filesForInstall(source, staged.files);

  // Stage to a temp dir so the battle-tested findSkillDirs/installSkillFromDir helpers can run.
  const stagingDir = await mkdtemp(join(tmpdir(), 'monad-skill-'));
  try {
    await Promise.all(
      [...files].map(async ([rel, bytes]) => {
        const dest = join(stagingDir, rel);
        await mkdir(dirname(dest), { recursive: true });
        await Bun.write(dest, bytes);
      })
    );

    const discoveredDirs = await findSkillDirs(stagingDir);
    const candidateDirs = source.skill ? await findSkillDirsRecursive(stagingDir) : discoveredDirs;
    if (candidateDirs.length === 0) throw new SkillInstallError(`no SKILL.md found in ${spec}`);
    const { dirs, names } = await selectSkillDirs(source, candidateDirs);

    const warnings: string[] = [];
    if (!/^[0-9a-f]{40}$/i.test(source.ref)) {
      warnings.push(`pinned to mutable ref "${source.ref}" — content can change under you; pin to a commit SHA`);
    }
    // Advisory content scan — a skill instructs the agent and can bundle scripts, so surface
    // escalation/injection signals for the consent decision (default-deny still applies).
    warnings.push(...scanSkillFiles(files));
    if (deps.review) {
      try {
        warnings.push(...warningsToStrings(await deps.review({ files, skills: names, source: spec })));
      } catch (error) {
        warnings.push(...warningsToStrings([warningModelRequestFailed(error)]));
      }
    }
    // Findings-driven consent: prompt only when the scan/review (or a mutable-ref pin) surfaced a warning.
    if (warnings.length > 0) {
      const granted = await deps.consent({ skills: names, source: spec, ref: source.ref, warnings });
      if (!granted) {
        return { skills: names, commit: staged.commit, warnings, installed: false, needsConsent: true };
      }
    }

    const record: Omit<SkillInstallRecord, 'installedAt'> & { installedAt: string } = {
      source: spec,
      sourceId: githubSourceIdentity(source),
      sourceKind: 'github',
      ref: source.ref,
      commit: staged.commit,
      installedAt: (deps.now ?? (() => new Date().toISOString()))()
    };

    const installed: string[] = [];
    for (const d of dirs) {
      try {
        const name = await installSkillFromDir(deps.skillsDir, d, { overwrite: deps.overwrite });
        await Bun.write(join(deps.skillsDir, name, '.install.json'), `${JSON.stringify(record, null, 2)}\n`);
        installed.push(name);
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    }

    deps.log?.(
      'info',
      `installed skill(s) ${installed.join(', ') || 'none'} from ${spec} @ ${staged.commit.slice(0, 7)}`
    );
    return { skills: installed, commit: staged.commit, warnings, installed: installed.length > 0 };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export interface SkillUpdateStatus {
  name: string;
  ref: string;
  current: string; // installed commit
  latest: string; // the ref's head right now
  hasUpdate: boolean;
}

/** Compare an installed skill's locked commit against its ref's current head. Returns null for a
 *  hand-dropped skill (no `.install.json`) or a non-github source — there is nothing to update.
 *  `resolveLatest` is injected (the real one is fetch.ts#resolveGithubCommit) so this stays offline-
 *  testable. */
export async function checkSkillUpdate(
  skillsDir: string,
  name: string,
  resolveLatest: (source: GithubSource) => Promise<string>
): Promise<SkillUpdateStatus | null> {
  let rec: SkillInstallRecord;
  try {
    rec = skillInstallRecordSchema.parse(JSON.parse(await Bun.file(join(skillsDir, name, '.install.json')).text()));
  } catch {
    return null;
  }
  if (rec.sourceKind !== 'github') return null;
  const source = parseGithubSource(rec.source);
  const latest = await resolveLatest(source);
  return { name, ref: rec.ref, current: rec.commit, latest, hasUpdate: latest !== rec.commit };
}
