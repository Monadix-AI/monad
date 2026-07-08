import type { SkillRef } from '#/capabilities/skills/index.ts';
import type { SkillInstallReviewer } from '#/capabilities/skills/install/index.ts';

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SKILL_MARKETPLACE_SOURCE, type SkillUpdate, skillMarketplaceSourceMeta } from '@monad/protocol';

import { ClawHubSkillSource, parseSkillRef } from '#/capabilities/skills/index.ts';
import { assertStagingCompatibility } from '#/capabilities/skills/install/compat.ts';
import { warningModelRequestFailed, warningsToStrings } from '#/capabilities/skills/install/review.ts';
import { scanSkillFiles } from '#/capabilities/skills/install/scan.ts';
import { installSkillFromDir } from '#/store/home/skills.ts';

interface ClawHubSkillRecord {
  [key: string]: unknown;
  source: string;
  sourceKind: 'clawhub';
  slug: string;
  version?: string;
  installedAt: string;
}

const DEFAULT_SKILL_INSTALL_SOURCE_PREFIX =
  skillMarketplaceSourceMeta(DEFAULT_SKILL_MARKETPLACE_SOURCE).installSourcePrefix ?? 'clawhub:';
const CLONE_PREFIX = `monad-skill-${DEFAULT_SKILL_MARKETPLACE_SOURCE}`;

export interface ClawHubInstallDeps {
  skillsDir: string;
  skillsLock: string;
  consent: (info: { skills: string[]; source: string; warnings: string[] }) => boolean | Promise<boolean>;
  review?: SkillInstallReviewer;
  overwrite?: boolean;
  now?: () => string;
}

export interface ClawHubInstallOutcome {
  skills: string[];
  warnings: string[];
  installed: boolean;
  needsConsent?: boolean;
}

export async function installClawHubSkill(spec: string, deps: ClawHubInstallDeps): Promise<ClawHubInstallOutcome> {
  const ref: SkillRef = parseSkillRef(spec);
  if (ref.scheme !== 'clawhub' && ref.scheme !== 'name') {
    throw new Error(
      `installClawHubSkill: expected ${DEFAULT_SKILL_INSTALL_SOURCE_PREFIX}ref, got scheme="${ref.scheme}"`
    );
  }

  const source = new ClawHubSkillSource();
  const resolved = await source.resolve(ref);

  const enc = new TextEncoder();
  const files = new Map([[`${resolved.name}/SKILL.md`, enc.encode(resolved.content)]]);
  const warnings = scanSkillFiles(files);
  if (deps.review) {
    try {
      warnings.push(...warningsToStrings(await deps.review({ files, skills: [resolved.name], source: spec })));
    } catch (error) {
      warnings.push(...warningsToStrings([warningModelRequestFailed(error)]));
    }
  }
  // Findings-driven consent: prompt only when the scan/review surfaced a concrete warning.
  if (warnings.length > 0) {
    const granted = await deps.consent({ skills: [resolved.name], source: spec, warnings });
    if (!granted) {
      return { skills: [resolved.name], warnings, installed: false, needsConsent: true };
    }
  }

  const stagingDir = join(tmpdir(), `${CLONE_PREFIX}-${Date.now()}`);
  await mkdir(stagingDir, { recursive: true });
  try {
    await Bun.write(join(stagingDir, 'SKILL.md'), resolved.content);
    warnings.push(...(await assertStagingCompatibility(stagingDir)));
    const name = await installSkillFromDir(deps.skillsDir, stagingDir, { overwrite: deps.overwrite });

    const now = (deps.now ?? (() => new Date().toISOString()))();
    const record: ClawHubSkillRecord = {
      source: spec,
      sourceKind: 'clawhub',
      slug: ref.name ?? ref.raw,
      ...(ref.version ? { version: ref.version } : {}),
      installedAt: now
    };

    await Bun.write(join(deps.skillsDir, name, '.install.json'), `${JSON.stringify(record, null, 2)}\n`);
    await upsertSkillsLock(deps.skillsLock, name, record);

    return { skills: [name], warnings, installed: true };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/** Merge one entry into skills.lock, creating the file if needed. Atomic: write to .tmp then rename. */
export async function upsertSkillsLock(lockPath: string, name: string, entry: Record<string, unknown>): Promise<void> {
  let lock: Record<string, unknown> = {};
  try {
    lock = JSON.parse(await Bun.file(lockPath).text()) as Record<string, unknown>;
  } catch {
    // file doesn't exist yet — start fresh
  }
  lock[name] = entry;
  const tmp = `${lockPath}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  const { rename } = await import('node:fs/promises');
  await rename(tmp, lockPath);
}

/** Check whether a ClawHub-tracked skill has a newer version available. */
export async function checkClawHubSkillUpdate(skillsDir: string, name: string): Promise<SkillUpdate | null> {
  let rec: ClawHubSkillRecord;
  try {
    const raw = JSON.parse(await Bun.file(join(skillsDir, name, '.install.json')).text());
    if (raw.sourceKind !== 'clawhub') return null;
    rec = raw as ClawHubSkillRecord;
  } catch {
    return null;
  }
  if (!rec.version) return null;
  const source = new ClawHubSkillSource();
  const latest = await source.latestVersion(rec.slug);
  if (!latest) return null;
  const ref = `${DEFAULT_SKILL_INSTALL_SOURCE_PREFIX}${rec.slug}`;
  return { name, ref, current: rec.version, latest, hasUpdate: latest !== rec.version };
}

/** Remove a skill entry from skills.lock if present. */
export async function removeFromSkillsLock(lockPath: string, name: string): Promise<void> {
  let lock: Record<string, unknown>;
  try {
    lock = JSON.parse(await Bun.file(lockPath).text()) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!(name in lock)) return;
  delete lock[name];
  const tmp = `${lockPath}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  const { rename } = await import('node:fs/promises');
  await rename(tmp, lockPath);
}
