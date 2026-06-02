import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';

import { checkSkillCompatibility, parseSkillMd } from '#/store/home/skills.ts';

/**
 * Read SKILL.md from a staging dir and enforce the `compatibility` field at install time.
 * Throws if the running monad version does not satisfy a declared semver range.
 * Returns an array of warnings (non-empty only in dev builds where the version is 0.0.0).
 */
export async function assertStagingCompatibility(stagingDir: string): Promise<string[]> {
  const warnings: string[] = [];
  const text = await Bun.file(join(stagingDir, 'SKILL.md'))
    .text()
    .catch(() => '');
  if (!text) return warnings;
  let parsed: ReturnType<typeof parseSkillMd> | undefined;
  try {
    parsed = parseSkillMd(text);
  } catch {
    return warnings;
  }
  if (!parsed.frontmatter.compatibility) return warnings;
  const compat = checkSkillCompatibility(parsed.frontmatter.compatibility, MONAD_VERSION);
  if (!compat || compat.compatible) return warnings;
  // Dev build (0.0.0) — warn but don't block, so local development works without a release.
  if (MONAD_VERSION === '0.0.0') {
    warnings.push(`compatibility not verified (dev build): skill wants monad ${compat.requirement}`);
    return warnings;
  }
  throw new Error(`skill requires monad ${compat.requirement} but running ${MONAD_VERSION}`);
}
