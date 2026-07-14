// Trust boundary: a skill body is executable instruction text from disk — treat like a
// provider atom (see docs/engineering/security-guidelines.md).

import type { Dirent } from 'node:fs';

import { cp, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { createLogger } from '@monad/logger';
import { z } from 'zod';

const log = createLogger('skills');
// Soft ceiling on a skill body: it's untrusted instruction text loaded into the model's context.
// Warn rather than block — a long-but-legitimate skill should still load — so an oversized body is
// visible (context squeeze / cost amplification) without breaking a valid skill.
const SKILL_BODY_WARN_BYTES = 64 * 1024;

/** Spec rule: lowercase alphanumeric + single hyphens, no leading/trailing/double hyphen. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_NAME_WORDS = ['anthropic', 'claude'] as const;

const skillRequiresSchema = z.object({
  bins: z.array(z.string()).optional(),
  anyBins: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
  os: z.array(z.enum(['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix'])).optional()
});
export type SkillRequires = z.infer<typeof skillRequiresSchema>;

const skillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(SKILL_NAME_RE, 'lowercase alphanumeric with single hyphens only (no leading/trailing/double hyphen)')
    .refine((n) => !RESERVED_NAME_WORDS.some((w) => n.includes(w)), {
      message: `must not contain a reserved word (${RESERVED_NAME_WORDS.join(', ')})`
    }),
  description: z.string().min(1).max(1024),
  version: z.string().min(1).max(100).optional(),
  icon: z.string().min(1).max(500).optional(),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  /** Arbitrary string→string metadata map (spec). Non-string values are coerced on parse. */
  metadata: z.record(z.string(), z.string()).optional(),
  /** Space-separated pre-approved tools. Parsed + surfaced, NOT auto-granted in v1. */
  allowedTools: z.string().optional(),
  requires: skillRequiresSchema.optional(),
  /** Activation globs (relative to the agent's workspace): the skill only auto-loads into L1
   *  when at least one workspace file matches. `/name` invocation is unaffected. */
  paths: z.array(z.string()).optional(),
  /** `fork` → run this skill as an isolated subagent (fresh context) and return its result. */
  context: z.literal('fork').optional(),
  /**
   * Abstract capability tier for a `context: fork` skill's subagent — the routing layer
   * resolves it to a concrete model from the configured profiles (cheapest in that tier),
   * so the skill stays portable (names a tier, not a vendor model). Ignored without `fork`.
   */
  tier: z.enum(['fast']).optional(),
  /** true → omit from the model-facing L1 listing and the `skill` tool; still /name-invocable. */
  disableModelInvocation: z.boolean().optional(),
  /** false → hide from the `/` menu. The model may still load it. Default true. */
  userInvocable: z.boolean().optional()
});
type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

const skillSchema = skillFrontmatterSchema.extend({
  /** Absolute path to the skill directory. */
  dir: z.string(),
  body: z.string()
});
export type Skill = z.infer<typeof skillSchema>;

/** Leading `---\n…\n---` frontmatter fence, capturing the YAML block and the body. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const KEY_ALIASES: Record<string, string> = {
  'allowed-tools': 'allowedTools',
  'disable-model-invocation': 'disableModelInvocation',
  'user-invocable': 'userInvocable'
};

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

export function parseSkillMd(raw: string): ParsedSkillFile {
  const match = FRONTMATTER_RE.exec(raw.replace(/^﻿/, '').trimStart());
  if (!match) throw new Error('missing YAML frontmatter (expected a leading `---` block)');
  const yamlBlock = match[1] as string;
  const body = match[2] as string;

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yamlBlock);
  } catch (err) {
    throw new Error(`invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter must be a YAML mapping');
  }

  const normalised: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    normalised[KEY_ALIASES[key] ?? key] = value;
  }

  // YAML may have parsed metadata values as numbers/bools; coerce all to strings.
  if (normalised.metadata && typeof normalised.metadata === 'object' && !Array.isArray(normalised.metadata)) {
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(normalised.metadata as Record<string, unknown>)) {
      m[k] = typeof v === 'string' ? v : String(v);
    }
    normalised.metadata = m;
  }

  // Accept a YAML list for allowed-tools in addition to the canonical space-separated string.
  if (Array.isArray(normalised.allowedTools)) {
    normalised.allowedTools = (normalised.allowedTools as unknown[]).map(String).join(' ');
  }

  const validated = skillFrontmatterSchema.safeParse(normalised);
  if (!validated.success) {
    // Concise message instead of raw ZodError JSON — reaches operators via `skills validate` and skill_manage.
    const detail = validated.error.issues.map((i) => `${i.path.join('.') || 'frontmatter'}: ${i.message}`).join('; ');
    throw new Error(`invalid frontmatter: ${detail}`);
  }
  return { frontmatter: validated.data, body: body.trim() };
}

export interface SkillDiscoverResult {
  registered: string[];
  errors: Array<{ skill: string; error: string }>;
}

/** A skill name provided by more than one source dir; `winnerDir` (last in precedence) is active,
 *  `shadowedDirs` are overridden. Surfaced so the UI can show the collision for the user to resolve. */
export interface SkillCollision {
  name: string;
  winnerDir: string;
  shadowedDirs: string[];
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  private readonly instances: Skill[] = [];

  register(skill: Skill): this {
    this.instances.push(skill);
    this.skills.set(skill.name, skill);
    return this;
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  all(): Skill[] {
    return Array.from(this.skills.values());
  }

  allInstances(): Skill[] {
    return [...this.instances];
  }

  /**
   * Scan `dir` for subdirectory SKILL.md packets. Frontmatter `name` MUST equal the
   * directory name (spec rule). Symlinks are followed. One bad skill never blocks others.
   */
  async discover(dir: string): Promise<SkillDiscoverResult> {
    const registered: string[] = [];
    const errors: Array<{ skill: string; error: string }> = [];

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { registered, errors };
    }

    await Promise.all(
      entries
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map(async (entry) => {
          const skillDir = join(dir, entry.name);
          const mdPath = join(skillDir, 'SKILL.md');
          try {
            const file = Bun.file(mdPath);
            if (!(await file.exists())) return; // plain dir, not a skill — skip silently
            const { frontmatter, body } = parseSkillMd(await file.text());
            if (body.length > SKILL_BODY_WARN_BYTES) {
              log.warn(
                { skill: entry.name, bytes: body.length, limit: SKILL_BODY_WARN_BYTES },
                'skill body exceeds soft limit (loaded anyway)'
              );
            }
            if (frontmatter.name !== entry.name) {
              throw new Error(`frontmatter name "${frontmatter.name}" must equal directory name "${entry.name}"`);
            }
            this.register(skillSchema.parse({ ...frontmatter, dir: skillDir, body }));
            registered.push(frontmatter.name);
          } catch (err) {
            errors.push({ skill: entry.name, error: err instanceof Error ? err.message : String(err) });
          }
        })
    );

    return { registered, errors };
  }

  /**
   * Discover from several directories in precedence order — a skill in a later dir
   * overrides one with the same name from an earlier dir (e.g. workspace shadows home).
   */
  async discoverMany(dirs: string[]): Promise<SkillDiscoverResult & { collisions: SkillCollision[] }> {
    const registered: string[] = [];
    const errors: Array<{ skill: string; error: string }> = [];
    const dirsByName = new Map<string, string[]>(); // skill name → providing dirs, in precedence order
    for (const dir of dirs) {
      const res = await this.discover(dir);
      for (const name of res.registered) dirsByName.set(name, [...(dirsByName.get(name) ?? []), dir]);
      registered.push(...res.registered);
      errors.push(...res.errors);
    }
    // last dir in precedence wins (discover overwrites); earlier providers are shadowed.
    const collisions: SkillCollision[] = [];
    for (const [name, ds] of dirsByName) {
      if (ds.length > 1)
        collisions.push({ name, winnerDir: ds[ds.length - 1] as string, shadowedDirs: ds.slice(0, -1) });
    }
    return { registered: [...new Set(registered)], errors, collisions };
  }
}

// Dependency-injected so eligibility checks are testable without touching the real host.
export interface SkillEligibilityCtx {
  hasBin: (name: string) => boolean; // daemon: Bun.which
  env: Record<string, string | undefined>; // daemon: Bun.env; a var counts as set only if non-empty
  platform: string; // daemon: process.platform
}

export interface SkillEligibility {
  ok: boolean;
  /** Unmet gate tags, e.g. `bin:git`, `anyBin:rg|grep`, `env:API_KEY`, `os:linux`. */
  missing: string[];
}

export function skillEligibility(requires: SkillRequires | undefined, ctx: SkillEligibilityCtx): SkillEligibility {
  const missing: string[] = [];
  if (requires) {
    for (const bin of requires.bins ?? []) if (!ctx.hasBin(bin)) missing.push(`bin:${bin}`);
    if (requires.anyBins?.length && !requires.anyBins.some((b) => ctx.hasBin(b))) {
      missing.push(`anyBin:${requires.anyBins.join('|')}`);
    }
    for (const key of requires.env ?? []) {
      const val = ctx.env[key];
      if (val === undefined || val === '') missing.push(`env:${key}`);
    }
    if (requires.os?.length && !requires.os.includes(ctx.platform as (typeof requires.os)[number])) {
      missing.push(`os:${requires.os.join('|')}`);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Does any file under `root` match one of the skill's `paths` activation globs? Used to gate L1
 * auto-load on workspace content (a "pdf" skill only surfaces when the workspace has a PDF). The
 * first match short-circuits. A missing/unreadable root is treated as "no match" (never throws).
 */
export async function skillPathsMatch(patterns: string[], root: string): Promise<boolean> {
  for (const pattern of patterns) {
    try {
      for await (const _ of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true, dot: false })) {
        return true;
      }
    } catch {
      // unreadable root / bad glob — treat as no match
    }
  }
  return false;
}

/** Advisory compatibility check. `compatibility` is a free-form string (spec); when it reads as a
 *  semver range we evaluate it against the running monad version. NON-blocking by design — an
 *  unmet requirement is surfaced as a warning the operator can override, never a hard gate. */
export interface SkillCompatibility {
  /** false only when `compatibility` is a semver range the running version does not satisfy. */
  compatible: boolean;
  /** The declared requirement string, surfaced to the user as-is. */
  requirement: string;
}

/** Looks like a semver range (starts with a comparator or digit) rather than free-form prose. */
const SEMVER_RANGE_RE = /^\s*[v\d<>=~^*]/;

export function checkSkillCompatibility(
  compatibility: string | undefined,
  monadVersion: string
): SkillCompatibility | null {
  if (!compatibility) return null;
  const requirement = compatibility.trim();
  if (!SEMVER_RANGE_RE.test(requirement)) return { compatible: true, requirement }; // free-form → advisory only
  // Bun.semver.satisfies returns false for an unparseable range too; the regex gate keeps prose out.
  return { compatible: Bun.semver.satisfies(monadVersion, requirement), requirement };
}

/** Global + per-agent skill switches (from config: `skills` block + per-agent override). */
export interface SkillSwitches {
  /** Global master, fully-disabled skills, and auto-load-only denylist. */
  global: { autoload: boolean; disabled: string[]; autoloadDisabled?: string[] };
  /** Active agent's override: `autoload` overrides the global master; `disabled` instance ids are additive. */
  agent?: { autoload?: boolean; disabled?: string[] };
}

export interface ResolvedSkillState {
  enabled: boolean;
  autoload: boolean;
}

export interface SkillStateRef {
  id: string;
  name: string;
}

/**
 * Resolve effective per-skill state for the active agent. The global `disabled` list is a hard
 * off switch; the auto-load denylist and per-agent disabled list only affect automatic context.
 */
export function resolveSkillState(switches: SkillSwitches): (skill: SkillStateRef) => ResolvedSkillState {
  const master = switches.agent?.autoload ?? switches.global.autoload;
  const disabled = new Set(switches.global.disabled);
  const autoloadDenied = new Set([...(switches.global.autoloadDisabled ?? []), ...(switches.agent?.disabled ?? [])]);
  return (skill: SkillStateRef) => {
    const enabled = !disabled.has(skill.id);
    return { enabled, autoload: enabled && master && !autoloadDenied.has(skill.id) };
  };
}

/** Validates the name and prevents path traversal (no slashes). */
export function assertValidSkillName(name: string): void {
  const parsed = skillFrontmatterSchema.shape.name.safeParse(name);
  if (!parsed.success) throw new Error(`invalid skill name "${name}": ${parsed.error.issues[0]?.message ?? 'invalid'}`);
}

/** Resolve `rel` within `base`, rejecting absolute paths and `..` escapes. */
function resolveWithin(base: string, rel: string): string {
  const normalized = normalize(rel);
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`path "${rel}" escapes the skill directory`);
  }
  return join(base, normalized);
}

export async function writeSkill(skillsDir: string, name: string, content: string): Promise<string> {
  assertValidSkillName(name);
  const { frontmatter } = parseSkillMd(content);
  if (frontmatter.name !== name) {
    throw new Error(`frontmatter name "${frontmatter.name}" must equal the skill name "${name}"`);
  }
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'SKILL.md'), content);
  return dir;
}

/** Patch SKILL.md via unique find/replace. `oldString` must occur exactly once; name cannot change. */
export async function patchSkill(skillsDir: string, name: string, oldString: string, newString: string): Promise<void> {
  assertValidSkillName(name);
  const path = join(skillsDir, name, 'SKILL.md');
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`skill "${name}" not found`);
  const current = await file.text();
  const occurrences = current.split(oldString).length - 1;
  if (occurrences === 0) throw new Error(`old_string not found in skill "${name}"`);
  if (occurrences > 1) throw new Error(`old_string is not unique in skill "${name}" (${occurrences} matches)`);
  const next = current.replace(oldString, newString);
  const { frontmatter } = parseSkillMd(next);
  if (frontmatter.name !== name) throw new Error(`a patch may not change the skill name (got "${frontmatter.name}")`);
  await Bun.write(path, next);
}

export async function deleteSkill(skillsDir: string, name: string): Promise<void> {
  assertValidSkillName(name);
  await rm(join(skillsDir, name), { recursive: true, force: true });
}

export async function writeSkillResource(
  skillsDir: string,
  name: string,
  file: string,
  content: string
): Promise<void> {
  assertValidSkillName(name);
  const dir = join(skillsDir, name);
  if (!(await Bun.file(join(dir, 'SKILL.md')).exists())) throw new Error(`skill "${name}" not found`);
  const target = resolveWithin(dir, file);
  if (basename(target) === 'SKILL.md') throw new Error('use writeSkill to change SKILL.md');
  // Resolve symlinks on the parent dir chain to prevent writing outside the skill root via a
  // symlink planted inside it. realpath on the target itself is skipped (it doesn't exist yet);
  // checking the nearest existing ancestor is sufficient.
  const parentDir = dirname(target);
  await mkdir(parentDir, { recursive: true });
  const realParent = await realpath(parentDir);
  const realSkillDir = await realpath(dir);
  if (!realParent.startsWith(realSkillDir + sep) && realParent !== realSkillDir) {
    throw new Error(`path "${file}" escapes the skill directory via a symlink`);
  }
  await Bun.write(target, content);
}

export async function removeSkillResource(skillsDir: string, name: string, file: string): Promise<void> {
  assertValidSkillName(name);
  const target = resolveWithin(join(skillsDir, name), file);
  if (basename(target) === 'SKILL.md') throw new Error('cannot remove SKILL.md via resource removal');
  await rm(target, { force: true });
}

/** Accept either a single-skill folder or a flat repo of skills. */
export async function findSkillDirs(root: string): Promise<string[]> {
  if (await Bun.file(join(root, 'SKILL.md')).exists()) return [root];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const sub = join(root, entry.name);
    if (await Bun.file(join(sub, 'SKILL.md')).exists()) dirs.push(sub);
  }
  return dirs;
}

export async function installSkillFromDir(
  skillsDir: string,
  srcDir: string,
  opts: { overwrite?: boolean } = {}
): Promise<string> {
  const mdPath = join(srcDir, 'SKILL.md');
  if (!(await Bun.file(mdPath).exists())) throw new Error(`no SKILL.md found in "${srcDir}"`);
  const { frontmatter } = parseSkillMd(await Bun.file(mdPath).text());
  assertValidSkillName(frontmatter.name);
  const dest = join(skillsDir, frontmatter.name);
  if (!opts.overwrite && (await Bun.file(join(dest, 'SKILL.md')).exists())) {
    throw new Error(`skill "${frontmatter.name}" already exists (pass overwrite to replace)`);
  }
  await rm(dest, { recursive: true, force: true });
  await cp(srcDir, dest, { recursive: true });
  return frontmatter.name;
}
