// Trust boundary: an AGENT.md body is executable instruction text from disk — treat like a
// skill body / provider atom (see docs/security-guidelines.md and skills.ts).
//
// An agent's structured config (model, atoms, sandbox, visibility) lives in profile.json and is
// authoritative for the live system. AGENT.md owns the *system-prompt body*; its YAML frontmatter
// is a Claude-Code-subagent superset kept only so a subagent `.md` imports cleanly.

import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';

/** Slug rule (matches agentConfigSchema.dir): lowercase alphanumeric + single hyphens. */
const AGENT_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const AGENT_MD_FILENAME = 'AGENT.md';

/** AGENT.md YAML frontmatter — a Claude Code subagent superset (`name`, `description`, `tools`,
 *  `disallowedTools`, `model`) so an external subagent file imports cleanly. Only the body is
 *  load-bearing at runtime; the config row in profile.json wins for structured fields. */
const agentFrontmatterSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1024).optional(),
  /** alias | tier(fast/smart/power) | 'inherit' */
  model: z.string().optional(),
  /** Claude `tools` allowlist — space/comma-separated or a YAML list (normalised to a string). */
  tools: z.string().optional(),
  /** Claude `disallowedTools` denylist — same shape as `tools`. */
  disallowedTools: z.string().optional()
});
type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

/** Leading `---\n…\n---` frontmatter fence, capturing the YAML block and the body. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const KEY_ALIASES: Record<string, string> = {
  'disallowed-tools': 'disallowedTools'
};

export interface ParsedAgentFile {
  /** Present only when the file carries a `---` frontmatter fence. */
  frontmatter?: AgentFrontmatter;
  /** The system-prompt body (frontmatter stripped, trimmed). */
  body: string;
}

/**
 * Parse an AGENT.md. Frontmatter is OPTIONAL: a body-only file (no `---` fence) is valid and yields
 * `{ body }` with no frontmatter — monad authors prompts body-first, the fence is for import/export.
 */
export function parseAgentMd(raw: string): ParsedAgentFile {
  const cleaned = raw.replace(/^﻿/, '').trimStart();
  const match = FRONTMATTER_RE.exec(cleaned);
  if (!match) return { body: cleaned.trim() };

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
  // Accept YAML lists for tools/disallowedTools in addition to a space/comma string.
  for (const k of ['tools', 'disallowedTools'] as const) {
    if (Array.isArray(normalised[k])) normalised[k] = (normalised[k] as unknown[]).map(String).join(', ');
  }

  const validated = agentFrontmatterSchema.safeParse(normalised);
  if (!validated.success) {
    const detail = validated.error.issues.map((i) => `${i.path.join('.') || 'frontmatter'}: ${i.message}`).join('; ');
    throw new Error(`invalid AGENT.md frontmatter: ${detail}`);
  }
  return { frontmatter: validated.data, body: body.trim() };
}

/** Compose an AGENT.md from a config row + body: a `name`/`description` frontmatter fence then the body. */
export function composeAgentMd(meta: { name: string; description?: string }, body: string): string {
  const lines = [`name: ${JSON.stringify(meta.name)}`];
  if (meta.description) lines.push(`description: ${JSON.stringify(meta.description)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

/** Validates a `dir` slug and prevents path traversal (no slashes, no `..`). */
export function assertValidAgentDir(dir: string): void {
  if (!AGENT_NAME_RE.test(dir)) {
    throw new Error(`invalid agent dir "${dir}": lowercase alphanumeric with single hyphens only`);
  }
}

/** Resolve `<agentsDir>/<dir>`, rejecting traversal. Mirrors skills.ts resolveWithin discipline. */
function agentDir(agentsDir: string, dir: string): string {
  assertValidAgentDir(dir);
  const normalized = normalize(dir);
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.includes(sep)) {
    throw new Error(`agent dir "${dir}" escapes the agents directory`);
  }
  return join(agentsDir, normalized);
}

/** Derive a traversal-safe `dir` slug from a free-text agent name. Falls back to `agent` when empty. */
export function toAgentDir(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

/**
 * Load an agent's system-prompt body from `<agentsDir>/<dir>/AGENT.md`. Returns `undefined` when the
 * file is absent (→ runtime falls back to DEFAULT_SYSTEM_PROMPT) — a config row without a committed
 * `.md` is still a valid agent.
 */
export async function loadAgentBody(agentsDir: string, dir: string): Promise<string | undefined> {
  const file = Bun.file(join(agentDir(agentsDir, dir), AGENT_MD_FILENAME));
  if (!(await file.exists())) return undefined;
  return parseAgentMd(await file.text()).body || undefined;
}

/** Write `<agentsDir>/<dir>/AGENT.md` from a config row + body (creating the dir). Returns the dir path. */
export async function writeAgentBody(
  agentsDir: string,
  dir: string,
  meta: { name: string; description?: string },
  body: string
): Promise<string> {
  const target = agentDir(agentsDir, dir);
  await mkdir(target, { recursive: true });
  await Bun.write(join(target, AGENT_MD_FILENAME), composeAgentMd(meta, body));
  return target;
}

/** Remove an agent's whole directory (prompt + per-agent workspace). Idempotent. */
export async function deleteAgentDir(agentsDir: string, dir: string): Promise<void> {
  await rm(agentDir(agentsDir, dir), { recursive: true, force: true });
}
