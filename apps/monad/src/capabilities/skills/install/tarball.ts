import type { SkillInstallReviewer } from '#/capabilities/skills/install/index.ts';
import type { DownloadProgress } from '#/services/download.ts';

import { lstat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

import { untar } from '#/atoms/install/untar.ts';
import { upsertSkillsLock } from '#/capabilities/skills/install/clawhub.ts';
import { assertStagingCompatibility } from '#/capabilities/skills/install/compat.ts';
import { warningModelRequestFailed, warningsToStrings } from '#/capabilities/skills/install/review.ts';
import { scanSkillDir } from '#/capabilities/skills/install/scan.ts';
import { downloadBytes } from '#/services/download.ts';
import { findSkillDirs, installSkillFromDir, parseSkillMd } from '#/store/home/skills.ts';

const MAX_ENTRY_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB extracted total
const MAX_REVIEW_CHARS = 48_000;
const MAX_REVIEW_BYTES_PER_FILE = 64 * 1024;
type HttpSkillDownloadProgress = DownloadProgress & { source: string };

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

/** Download a .tar.gz from a URL, harden-check every entry, and write the contents to destDir. */
async function downloadSkillTarball(
  url: string,
  destDir: string,
  onDownloadProgress?: (progress: HttpSkillDownloadProgress) => void
): Promise<void> {
  const { bytes: compressed } = await downloadBytes(url, {
    headers: { 'User-Agent': 'monad-skill-installer/1' },
    accept: 'application/gzip, application/x-gzip, application/octet-stream',
    allowedContentTypes: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    onProgress: (progress) => onDownloadProgress?.({ ...progress, source: url })
  });
  const buf = Bun.gunzipSync(compressed as Uint8Array<ArrayBuffer>);
  const files = untar(buf);

  let totalBytes = 0;
  for (const [rawPath, bytes] of files) {
    // Strip one leading directory component (e.g. "archive-main/SKILL.md" → "SKILL.md")
    const stripped = rawPath.replace(/^[^/]+\//, '');
    if (!stripped) continue;

    const safe = normalize(stripped);
    if (safe.startsWith('..') || safe.startsWith('/') || isAbsolute(safe)) {
      throw new Error(`tarball path escape: ${rawPath}`);
    }
    if (bytes.length > MAX_ENTRY_BYTES) {
      throw new Error(`tarball entry too large (${bytes.length} bytes): ${rawPath}`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('tarball exceeds maximum extracted size (50 MB)');
    }

    const dest = join(destDir, safe);
    const rel = relative(destDir, dest);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`tarball path escape: ${rawPath}`);
    }
    const dir = dirname(dest);
    if (dir !== destDir) await mkdir(dir, { recursive: true });
    await Bun.write(dest, bytes);
  }
}

export interface HttpSkillInstallDeps {
  skillsDir: string;
  skillsLock: string;
  consent: (info: { skills: string[]; source: string; warnings: string[] }) => boolean | Promise<boolean>;
  review?: SkillInstallReviewer;
  overwrite?: boolean;
  now?: () => string;
  onDownloadProgress?: (progress: HttpSkillDownloadProgress) => void;
}

export interface HttpSkillInstallOutcome {
  skills: string[];
  warnings: string[];
  installed: boolean;
  needsConsent?: boolean;
}

export async function installHttpSkill(url: string, deps: HttpSkillInstallDeps): Promise<HttpSkillInstallOutcome> {
  const warnings: string[] = [];

  const stagingDir = join(tmpdir(), `monad-skill-http-${Date.now()}`);
  await mkdir(stagingDir, { recursive: true });
  try {
    await downloadSkillTarball(url, stagingDir, deps.onDownloadProgress);
    const dirs = await findSkillDirs(stagingDir);
    const skills = await Promise.all(
      dirs.map(async (dir) => parseSkillMd(await Bun.file(join(dir, 'SKILL.md')).text()).frontmatter.name)
    );
    const [compatWarnings, scanWarnings] = await Promise.all([
      assertStagingCompatibility(stagingDir),
      scanSkillDir(stagingDir)
    ]);
    warnings.push(...compatWarnings, ...scanWarnings);
    if (deps.review) {
      try {
        const files = await collectReviewFiles(stagingDir, MAX_REVIEW_CHARS);
        warnings.push(...warningsToStrings(await deps.review({ files, skills, source: url })));
      } catch (error) {
        warnings.push(...warningsToStrings([warningModelRequestFailed(error)]));
      }
    }
    // Findings-driven consent: prompt only when the scan/review surfaced a concrete warning.
    if (warnings.length > 0) {
      const granted = await deps.consent({ skills: skills.length ? skills : [url], source: url, warnings });
      if (!granted) return { skills: skills.length ? skills : [url], warnings, installed: false, needsConsent: true };
    }
    const now = (deps.now ?? (() => new Date().toISOString()))();
    const record = { source: url, sourceKind: 'http', installedAt: now };
    const installed = await Promise.all(
      dirs.map(async (dir) => {
        const name = await installSkillFromDir(deps.skillsDir, dir, { overwrite: deps.overwrite });
        await Bun.write(join(deps.skillsDir, name, '.install.json'), `${JSON.stringify(record, null, 2)}\n`);
        await upsertSkillsLock(deps.skillsLock, name, record);
        return name;
      })
    );

    return { skills: installed, warnings, installed: true };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
