import type { Dirent } from 'node:fs';
import type { GetSkillContentResponse, WorkplaceExperienceDefinition } from '@monad/protocol';
import type { RegisteredWorkplaceExperience } from '#/handlers/atom-pack/atom-pack-registry.ts';

import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

import { checkExperienceBrowserChunk } from '#/atoms/browser-chunk.ts';
import { atomPackInstallRecordSchema } from '#/atoms/install/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';

export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

function languageForSkillFile(path: string): string | undefined {
  const lower = path.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const byExt: Record<string, string> = {
    bash: 'bash',
    css: 'css',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsx: 'jsx',
    md: 'markdown',
    mjs: 'javascript',
    py: 'python',
    sh: 'bash',
    ts: 'typescript',
    tsx: 'tsx',
    txt: 'text',
    yaml: 'yaml',
    yml: 'yaml'
  };
  return byExt[ext];
}

export function contentTypeForSkillFile(path: string): string | undefined {
  const lower = path.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const byExt: Record<string, string> = {
    avif: 'image/avif',
    bash: 'text/x-shellscript',
    css: 'text/css',
    gif: 'image/gif',
    html: 'text/html',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    js: 'text/javascript',
    json: 'application/json',
    jsx: 'text/jsx',
    md: 'text/markdown',
    mjs: 'text/javascript',
    png: 'image/png',
    py: 'text/x-python',
    sh: 'text/x-shellscript',
    svg: 'image/svg+xml',
    ts: 'text/typescript',
    tsx: 'text/tsx',
    txt: 'text/plain',
    webp: 'image/webp',
    yaml: 'application/yaml',
    yml: 'application/yaml'
  };
  return byExt[ext];
}

export function previewForSkillFile(path: string): 'image' | 'text' | 'unsupported' {
  const contentType = contentTypeForSkillFile(path);
  if (contentType?.startsWith('image/')) return 'image';
  if (contentType?.startsWith('text/') || contentType === 'application/json' || contentType === 'application/yaml') {
    return 'text';
  }
  return languageForSkillFile(path) ? 'text' : 'unsupported';
}

export function resolveSkillResourcePath(dir: string, file: string): string {
  const normalized = normalize(file);
  if (
    !normalized ||
    normalized === '.' ||
    normalized === 'SKILL.md' ||
    normalized.startsWith('..') ||
    normalized.startsWith('/') ||
    /^[a-z]:[\\/]/i.test(normalized) ||
    file.split(/[\\/]/).includes('..') ||
    normalized.split(/[\\/]/).includes('..')
  ) {
    throw new HandlerError('invalid', `invalid skill file path: ${file}`);
  }
  const fullPath = join(dir, normalized);
  const rel = relative(dir, fullPath);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new HandlerError('invalid', `invalid skill file path: ${file}`);
  }
  return fullPath;
}

export async function resolveAtomPackAssetPath(dir: string, name: string, file: string): Promise<string> {
  if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid Atom Pack name: ${name}`);
  const normalized = normalize(file);
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('..') ||
    normalized.startsWith('/') ||
    /^[a-z]:[\\/]/i.test(normalized) ||
    file.split(/[\\/]/).includes('..') ||
    normalized.split(/[\\/]/).includes('..')
  ) {
    throw new HandlerError('invalid', `invalid Atom Pack asset path: ${file}`);
  }
  const packDir = join(dir, name);
  const fullPath = join(packDir, normalized);
  const rel = relative(packDir, fullPath);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) {
    throw new HandlerError('invalid', `invalid Atom Pack asset path: ${file}`);
  }
  let realPackDir: string;
  let realAssetPath: string;
  let linkInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    [realPackDir, realAssetPath, linkInfo] = await Promise.all([
      realpath(packDir),
      realpath(fullPath),
      lstat(fullPath)
    ]);
  } catch {
    throw new HandlerError('not_found', `Atom Pack asset not found: ${name}/${file}`);
  }
  if (linkInfo.isSymbolicLink()) throw new HandlerError('not_found', `Atom Pack asset not found: ${name}/${file}`);
  const realRel = relative(realPackDir, realAssetPath);
  if (!realRel || realRel.startsWith('..') || realRel.includes(`..${sep}`) || isAbsolute(realRel)) {
    throw new HandlerError('invalid', `invalid Atom Pack asset path: ${file}`);
  }
  return realAssetPath;
}

function isPackRelativeModule(module: string): boolean {
  try {
    const url = new URL(module);
    return url.protocol !== 'http:' && url.protocol !== 'https:';
  } catch {
    return !module.startsWith('/');
  }
}

function normalizePackRelativeModule(module: string): string | null {
  const normalized = normalize(module);
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('..') ||
    normalized.startsWith('/') ||
    /^[a-z]:[\\/]/i.test(normalized) ||
    module.split(/[\\/]/).includes('..') ||
    normalized.split(/[\\/]/).includes('..')
  ) {
    return null;
  }
  return normalized.replaceAll('\\', '/');
}

function atomPackAssetUrl(atomPackId: string, module: string, revision?: string): string | null {
  const normalized = normalizePackRelativeModule(module);
  if (!normalized) return null;
  const path = normalized.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = `/v1/atoms/${encodeURIComponent(atomPackId)}/assets/${path}`;
  // Reinstalling a pack keeps the same asset path, and the browser caches an ES module by URL — so
  // without a revision the previous bundle survives the reload. The install-recorded bundle hash is
  // the revision: it changes exactly when the served bytes do.
  return revision ? `${url}?v=${encodeURIComponent(revision)}` : url;
}

export function toPublicWorkplaceExperience(
  experience: RegisteredWorkplaceExperience,
  revision?: string
): WorkplaceExperienceDefinition | null {
  const { atomPackId: _atomPackId, ...publicExperience } = experience;
  if (experience.entry.type !== 'web-component') return publicExperience;
  if (!experience.atomPackId || !isPackRelativeModule(experience.entry.module)) return publicExperience;
  const module = atomPackAssetUrl(experience.atomPackId, experience.entry.module, revision);
  if (!module) return null;
  return {
    ...publicExperience,
    entry: {
      ...experience.entry,
      module
    }
  };
}

/** The install-recorded bundle hash, shortened for a URL. Absent for a pack with no record. */
async function readAtomPackRevision(dir: string, atomPackId: string): Promise<string | undefined> {
  if (!SAFE_NAME.test(atomPackId)) return undefined;
  try {
    const parsed = atomPackInstallRecordSchema.safeParse(
      JSON.parse(await Bun.file(join(dir, atomPackId, '.install.json')).text())
    );
    const integrity = parsed.success ? parsed.data.integrity : undefined;
    return integrity?.replace(/^sha256-/, '').slice(0, 12);
  } catch {
    return undefined;
  }
}

export interface WorkplaceExperienceSnapshot {
  experiences: WorkplaceExperienceDefinition[];
  warnings: Array<{ experienceId: string; error: string }>;
}

export async function createWorkplaceExperienceSnapshot(
  dir: string,
  experiences: readonly RegisteredWorkplaceExperience[]
): Promise<WorkplaceExperienceSnapshot> {
  const snapshot: WorkplaceExperienceSnapshot = { experiences: [], warnings: [] };
  const revisions = new Map<string, string | undefined>();
  const revisionFor = async (atomPackId: string): Promise<string | undefined> => {
    if (revisions.has(atomPackId)) return revisions.get(atomPackId);
    const revision = await readAtomPackRevision(dir, atomPackId);
    revisions.set(atomPackId, revision);
    return revision;
  };
  for (const experience of experiences) {
    try {
      const revision = experience.atomPackId ? await revisionFor(experience.atomPackId) : undefined;
      const publicExperience = toPublicWorkplaceExperience(experience, revision);
      if (!publicExperience) throw new Error('invalid web-component module path');
      if (experience.entry.type === 'web-component' && experience.atomPackId) {
        const module = experience.entry.module;
        const publicModule = publicExperience.entry.type === 'web-component' ? publicExperience.entry.module : module;
        if (publicModule !== module) {
          const assetPath = await resolveAtomPackAssetPath(dir, experience.atomPackId, module);
          const violations = checkExperienceBrowserChunk(await Bun.file(assetPath).text());
          if (violations.length > 0) throw new Error(violations.join('; '));
        }
      }
      snapshot.experiences.push(publicExperience);
    } catch (err) {
      snapshot.warnings.push({
        experienceId: experience.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return snapshot;
}

export async function listSkillContentFiles(dir: string): Promise<GetSkillContentResponse['files']> {
  const files: GetSkillContentResponse['files'] = [];
  async function walk(currentDir: string, prefix = ''): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }
      if (!entry.isFile() || relPath === 'SKILL.md') continue;
      const info = await stat(fullPath).catch(() => null);
      if (!info?.isFile()) continue;
      const language = languageForSkillFile(relPath);
      const contentType = contentTypeForSkillFile(relPath);
      files.push({
        ...(contentType ? { contentType } : {}),
        path: relPath,
        preview: previewForSkillFile(relPath),
        size: info.size,
        ...(language ? { language } : {})
      });
    }
  }
  await walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
