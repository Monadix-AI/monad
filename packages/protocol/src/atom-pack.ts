// Atom pack manifest wire/validation schema. The manifest is untrusted input read off disk (or
// fetched) before any atom pack code runs, so it is parsed, never cast. The authoring TS interface
// is @monad/sdk-atom's AtomPackManifest; this schema must list the same atom kinds.

import { z } from 'zod';

/** A bundle entry path is joined onto the atom pack dir to write (install) and import (discovery).
 *  It MUST stay inside that dir — an absolute path or a `..` segment would let a crafted manifest
 *  write/execute outside the sandbox (arbitrary file write + code load). Enforced here at the parse
 *  boundary so every reader (install, discovery) gets the same guarantee. */
const safeEntrySchema = z
  .string()
  .min(1)
  .refine((p) => {
    if (p.startsWith('/') || /^[a-z]:[\\/]/i.test(p) || p.includes('\\') || p.includes('\0')) return false;
    return !p.split('/').some((seg) => seg === '..');
  }, 'entry must be a relative path within the atom pack dir (no leading "/", drive, "\\", or ".." segments)');

// 'locale', 'mcp', and 'skill' are file-based and self-declaring: their presence on disk
// (under the pack's locales/ dir, mcp.json, or skills/ dir) is the declaration — they do NOT
// need to appear in atoms[] for discovery to work. Listing them in atoms[] is allowed for
// tooling/documentation purposes but has no runtime effect.
export const atomKindSchema = z.enum([
  'connector',
  'channel',
  'command',
  'message-type',
  'locale',
  'provider',
  'hook',
  'sandbox',
  'workspace-experience',
  'mcp',
  'skill'
]);
export type AtomKind = z.infer<typeof atomKindSchema>;

export const atomPackManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'atom pack name must be a safe slug'),
  version: z.string().min(1),
  sdkVersion: z.string().min(1),
  /** Semver range of supported Monad host versions, e.g. ">=0.1.0 <0.2.0". Absent means no host-version gate. */
  monadVersion: z.string().min(1).optional(),
  atoms: z.array(atomKindSchema),
  entry: safeEntrySchema.optional(),
  source: z.object({ repo: z.string(), commit: z.string() }).optional(),
  integrity: z.string().optional(), // "sha256-…"
  signature: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  /** Relative dirs inside the package containing skill subdirectories. Default: ['skills']. */
  skillDirs: z.array(z.string()).optional(),
  /** Relative path to the mcp.json config file. Default: 'mcp.json'. */
  mcpConfig: z.string().optional(),
  /** Relative dirs inside the package containing locale files (<lng>/<namespace>.json). Default: ['locales']. */
  localeDirs: z.array(z.string()).optional()
});
export type AtomPackManifestWire = z.infer<typeof atomPackManifestSchema>;

export function parseAtomPackManifest(raw: unknown): AtomPackManifestWire {
  return atomPackManifestSchema.parse(raw);
}

export const installedAtomPackSchema = z.object({
  /** The operable identity = install dir (folder) name. Unique across packs (a same-named pack from
   *  a different source installs under a disambiguating suffix). Use this for enable/remove/pin. */
  name: z.string(),
  /** The pack's self-declared manifest name (display label); may collide across packs. */
  displayName: z.string().optional(),
  version: z.string(),
  monadVersion: z.string().optional(),
  atoms: z.array(atomKindSchema),
  enabled: z.boolean(),
  source: z.string().optional(), // the install spec, e.g. "github:owner/repo@sha"
  installedAt: z.string().optional()
});
export type InstalledAtomPack = z.infer<typeof installedAtomPackSchema>;

// Atom kinds that share a namespace and can produce bare-id collisions.
export const namespacedAtomKindSchema = z.enum(['channel', 'connector', 'command', 'skill']);
export type NamespacedAtomKind = z.infer<typeof namespacedAtomKindSchema>;

// A surfaced bare-name collision: two+ packs claimed the same id for a namespace-coexist kind. The
// winner owns the bare name (pin ?? first-wins); shadowed packs stay reachable via `<packId>__<id>`.
// The UI lists these so the user can pin a different winner (config.atomPins) or remove a pack.
export const atomConflictSchema = z.object({
  kind: namespacedAtomKindSchema,
  bareId: z.string(),
  winner: z.string(),
  shadowed: z.array(z.string())
});
export type AtomConflict = z.infer<typeof atomConflictSchema>;

// Set (or clear) the user pin that decides which pack wins a bare id for a namespace-coexist kind.
// `packId: null` clears the pin → back to first-wins. Persisted to config.atomPins and re-resolved.
export const setAtomPinRequestSchema = z.object({
  kind: namespacedAtomKindSchema,
  bareId: z.string().min(1),
  packId: z.string().min(1).nullable()
});
export type SetAtomPinRequest = z.infer<typeof setAtomPinRequestSchema>;

export const listAtomPacksResponseSchema = z.object({
  atomPacks: z.array(installedAtomPackSchema),
  /** Bare-name collisions from the last load sweep — empty when nothing collided. */
  conflicts: z.array(atomConflictSchema).default([])
});
export type ListAtomPacksResponse = z.infer<typeof listAtomPacksResponseSchema>;

export const workspaceExperienceEntrySchema = z.object({
  type: z.literal('web-component'),
  module: z.string().min(1),
  tagName: z.string().min(1)
});
export type WorkspaceExperienceEntry = z.infer<typeof workspaceExperienceEntrySchema>;

export const workspaceExperienceDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  icon: z.string().optional(),
  entry: workspaceExperienceEntrySchema
});
export type WorkspaceExperienceDefinition = z.infer<typeof workspaceExperienceDefinitionSchema>;

export const listWorkspaceExperiencesResponseSchema = z.object({
  experiences: z.array(workspaceExperienceDefinitionSchema)
});
export type ListWorkspaceExperiencesResponse = z.infer<typeof listWorkspaceExperiencesResponseSchema>;

export const installAtomPackRequestSchema = z.object({
  source: z.string().min(1), // "github:owner/repo@sha" | "npm:@scope/name@ver" | "local:/abs/path"
  /** Caller asserts consent to the atom pack's declared atoms (default-deny without it). */
  consent: z.boolean().default(false)
});
export type InstallAtomPackRequest = z.infer<typeof installAtomPackRequestSchema>;

export const installAtomPackResponseSchema = z.object({
  name: z.string(),
  atoms: z.array(atomKindSchema),
  /** Set when consent was required but not given — the caller should re-call with consent:true. */
  needsConsent: z.boolean().optional(),
  /** Advisory static-scan findings surfaced for the consent decision. */
  warnings: z.array(z.string()).default([])
});
export type InstallAtomPackResponse = z.infer<typeof installAtomPackResponseSchema>;

// A skill installed from github: is version-locked via its `.install.json`; a hand-dropped skill
// has no record (source/ref/commit absent). Distinct from atom packs: a skill is a single SKILL.md
// packet, not a bundle.

export const installedSkillSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  icon: z.string().optional(),
  source: z.string().optional(),
  ref: z.string().optional(),
  commit: z.string().optional(),
  installedAt: z.string().optional()
});
export type InstalledSkill = z.infer<typeof installedSkillSchema>;

export const listInstalledSkillsResponseSchema = z.object({ skills: z.array(installedSkillSchema) });
export type ListInstalledSkillsResponse = z.infer<typeof listInstalledSkillsResponseSchema>;

export const installSkillRequestSchema = z.object({
  source: z.string().min(1), // "github:owner/repo@<ref>"
  /** Caller asserts consent after seeing the discovered skill names (default-deny without it). */
  consent: z.boolean().default(false),
  /** Replace an already-installed skill of the same name. */
  overwrite: z.boolean().default(false)
});
export type InstallSkillRequest = z.infer<typeof installSkillRequestSchema>;

export const installSkillResponseSchema = z.object({
  skills: z.array(z.string()),
  commit: z.string().default(''),
  needsConsent: z.boolean().optional(),
  warnings: z.array(z.string()).default([])
});
export type InstallSkillResponse = z.infer<typeof installSkillResponseSchema>;

// Re-install a github-tracked skill from its recorded source (the name travels in the path). Reuses
// the install response (it IS an install with overwrite).
export const updateSkillRequestSchema = z.object({ consent: z.boolean().default(false) });
export type UpdateSkillRequest = z.infer<typeof updateSkillRequestSchema>;

// Create/scaffold a personal-scope skill from raw SKILL.md content. The daemon validates the
// frontmatter + name (parseSkillMd) and hot-reloads; the human running the CLI is the approver, so
// no oversight gate (unlike the agent's skill_manage tool).
export const createSkillRequestSchema = z.object({
  name: z.string().min(1),
  content: z.string().min(1)
});
export type CreateSkillRequest = z.infer<typeof createSkillRequestSchema>;

export const createSkillResponseSchema = z.object({
  name: z.string(),
  dir: z.string(),
  warnings: z.array(z.string()).default([])
});
export type CreateSkillResponse = z.infer<typeof createSkillResponseSchema>;

export const skillContentFileSchema = z.object({
  contentType: z.string().optional(),
  language: z.string().optional(),
  path: z.string(),
  preview: z.enum(['text', 'image', 'unsupported']).default('unsupported'),
  size: z.number().int().nonnegative()
});
export type SkillContentFile = z.infer<typeof skillContentFileSchema>;

export const getSkillContentResponseSchema = z.object({
  name: z.string(),
  content: z.string(),
  contentType: z.string().optional(),
  encoding: z.enum(['utf8', 'base64', 'none']).default('utf8'),
  file: z.string().optional(),
  files: z.array(skillContentFileSchema).default([]),
  preview: z.enum(['text', 'image', 'unsupported']).default('text')
});
export type GetSkillContentResponse = z.infer<typeof getSkillContentResponseSchema>;

export const updateSkillContentRequestSchema = z.object({
  content: z.string().min(1)
});
export type UpdateSkillContentRequest = z.infer<typeof updateSkillContentRequestSchema>;

// Install every skill found under a LOCAL filesystem path the daemon can read (the CLI resolves the
// path, and clones git sources to a tmp dir first). Reuses the install response. Trusted operator
// channel only (loopback + auth) — the daemon reads the caller-supplied path directly.
export const installLocalSkillRequestSchema = z.object({
  path: z.string().min(1),
  overwrite: z.boolean().default(false)
});
export type InstallLocalSkillRequest = z.infer<typeof installLocalSkillRequestSchema>;

// Lint every SKILL.md under a local path (parse + dir-name match) without installing.
export const validateSkillsRequestSchema = z.object({ path: z.string().min(1) });
export type ValidateSkillsRequest = z.infer<typeof validateSkillsRequestSchema>;

export const skillValidationResultSchema = z.object({
  name: z.string(),
  dir: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  warnings: z.array(z.string()).default([])
});
export const validateSkillsResponseSchema = z.object({ results: z.array(skillValidationResultSchema) });
export type ValidateSkillsResponse = z.infer<typeof validateSkillsResponseSchema>;

export const skillUpdateSchema = z.object({
  name: z.string(),
  ref: z.string(),
  current: z.string(),
  latest: z.string(),
  hasUpdate: z.boolean()
});
export type SkillUpdate = z.infer<typeof skillUpdateSchema>;

export const checkSkillUpdatesResponseSchema = z.object({ updates: z.array(skillUpdateSchema) });
export type CheckSkillUpdatesResponse = z.infer<typeof checkSkillUpdatesResponseSchema>;
