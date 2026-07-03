import type { Dirent } from 'node:fs';
import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type {
  CheckSkillUpdatesResponse,
  CreateSkillRequest,
  CreateSkillResponse,
  GetSkillContentResponse,
  InstallAtomPackRequest,
  InstallAtomPackResponse,
  InstalledAtomPack,
  InstalledSkill,
  InstallLocalSkillRequest,
  InstallMcpAtomRequest,
  InstallMcpAtomResponse,
  InstallMcpBinaryRequest,
  InstallSkillRequest,
  InstallSkillResponse,
  ListAtomPacksResponse,
  ListInstalledMcpAtomsResponse,
  ListInstalledSkillsResponse,
  ListWorkspaceExperiencesResponse,
  OkResponse,
  SetAtomPinRequest,
  SkillUpdate,
  UpdateSkillContentRequest,
  ValidateSkillsRequest,
  ValidateSkillsResponse,
  WorkspaceExperienceDefinition
} from '@monad/protocol';
import type { AtomConflict } from '@/atoms/resolve.ts';
import type { RegisteredWorkspaceExperience } from '@/handlers/atom-pack/atom-pack-registry.ts';
import type { ConfigBus } from '@/services/config-bus.ts';
import type { ModelService } from '@/services/model.ts';

import { Buffer } from 'node:buffer';
import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { DEFAULT_SAMPLE_PROVIDER_ID, loadAll, loadAuth, saveProfile } from '@monad/home';
import { DEFAULT_SKILL_MARKETPLACE_SOURCE, parseAtomPackManifest, skillMarketplaceSourceMeta } from '@monad/protocol';

import { createAtomFetcher } from '@/atoms/install/fetch.ts';
import { type AtomPackInstallRecord, atomPackInstallRecordSchema, installAtomPack } from '@/atoms/install/index.ts';
import {
  createReleaseAssetFetcher,
  installMcpBinary as installMcpBinaryService
} from '@/capabilities/mcp/install/binary.ts';
import {
  installMcpAtom as installMcpAtomService,
  listInstalledMcpAtoms,
  removeMcpAtom,
  setMcpAtomEnabled
} from '@/capabilities/mcp/install/index.ts';
import {
  checkClawHubSkillUpdate,
  installClawHubSkill,
  removeFromSkillsLock
} from '@/capabilities/skills/install/clawhub.ts';
import { createSkillFetcher, resolveGithubCommit } from '@/capabilities/skills/install/fetch.ts';
import { checkGitSkillUpdate, installGitSkill } from '@/capabilities/skills/install/git.ts';
import {
  checkSkillUpdate,
  installSkill as installSkillFromGithub,
  type SkillInstallRecord,
  type SkillInstallReviewer,
  skillInstallRecordSchema
} from '@/capabilities/skills/install/index.ts';
import { reviewSkillInstall } from '@/capabilities/skills/install/review.ts';
import { scanSkillDir, scanSkillFiles } from '@/capabilities/skills/install/scan.ts';
import { installHttpSkill } from '@/capabilities/skills/install/tarball.ts';
import { resolveSecretRef } from '@/config/secrets.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
import { type DecodedUpload, decodeRawUpload, unpackZipUpload } from '@/services/upload.ts';
import { findSkillDirs, installSkillFromDir, parseSkillMd, writeSkill } from '@/store/home/skills.ts';

export interface AtomPacksDeps {
  paths: MonadPaths;
  /** Called after a successful install/remove so the daemon can re-discover atom packs (refresh
   *  the channel registry) without a restart. */
  onChanged?: () => Promise<void>;
  /** Bare-name collisions from the last load sweep — surfaced read-only for the conflict UI. */
  getConflicts?: () => AtomConflict[];
  /** Runtime-registered workspace experiences from loaded atom packs. */
  getWorkspaceExperiences?: () => RegisteredWorkspaceExperience[];
  configBus?: ConfigBus;
  modelService?: ModelService;
}

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const SKILL_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SKILL_INSTALL_SOURCE_PREFIX = skillMarketplaceSourceMeta(
  DEFAULT_SKILL_MARKETPLACE_SOURCE
).installSourcePrefix;

function resolveToken(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    return resolveSecretRef(ref);
  } catch {
    return undefined;
  }
}

function isGithubHttpSource(source: string): boolean {
  try {
    const url = new URL(source);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

function isDefaultMarketplaceSourceSpec(source: string): boolean {
  if (DEFAULT_SKILL_INSTALL_SOURCE_PREFIX && source.startsWith(DEFAULT_SKILL_INSTALL_SOURCE_PREFIX)) {
    return true;
  }
  return !source.includes(':');
}

function resolveUsableInstallReviewModel(cfg: MonadConfig, auth: MonadAuth | null): string | null {
  if (!auth) return null;
  const profiles = [
    ...cfg.model.profiles.filter((p) => p.alias === 'default'),
    ...cfg.model.profiles.filter((p) => p.alias !== 'default')
  ];
  for (const profile of profiles) {
    const provider = cfg.model.providers.find((p) => p.id === profile.routes.chat.provider);
    if (!provider || provider.id === DEFAULT_SAMPLE_PROVIDER_ID) continue;
    if ((auth.credentialPool[provider.id] ?? []).some((credential) => credential.authType !== 'admin_api_key')) {
      return profile.alias;
    }
  }
  return null;
}

export function createAtomPacksModule(deps: AtomPacksDeps) {
  const dir = deps.paths.packs;

  const reviewInstall: SkillInstallReviewer = async ({ files, skills, source }) => {
    const cfg = await loadAll(deps.paths.config, deps.paths.profile);
    if (!cfg?.skills.installReview) return [];
    const auth = await loadAuth(deps.paths.auth);
    const modelSpec = resolveUsableInstallReviewModel(cfg, auth);
    if (!modelSpec || !deps.modelService) {
      return [{ code: 'failure:no-usable-model' }];
    }
    return reviewSkillInstall({
      files,
      model: deps.modelService.router,
      modelSpec,
      skills,
      source
    });
  };

  async function reloadAfterSkillCommit<T extends InstallSkillResponse>(out: T): Promise<T> {
    if (!out.needsConsent && out.skills.length > 0) await deps.onChanged?.();
    return out;
  }

  async function createSkillFromContent({ name, content }: CreateSkillRequest): Promise<CreateSkillResponse> {
    try {
      const skillDir = await writeSkill(deps.paths.skills, name, content);
      const enc = new TextEncoder();
      const warnings = scanSkillFiles(new Map([[`${name}/SKILL.md`, enc.encode(content)]]));
      return { name, dir: skillDir, warnings };
    } catch (err) {
      throw new HandlerError('invalid', err instanceof Error ? err.message : String(err));
    }
  }

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

  function contentTypeForSkillFile(path: string): string | undefined {
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

  function previewForSkillFile(path: string): 'image' | 'text' | 'unsupported' {
    const contentType = contentTypeForSkillFile(path);
    if (contentType?.startsWith('image/')) return 'image';
    if (contentType?.startsWith('text/') || contentType === 'application/json' || contentType === 'application/yaml') {
      return 'text';
    }
    return languageForSkillFile(path) ? 'text' : 'unsupported';
  }

  function resolveSkillResourcePath(dir: string, file: string): string {
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

  async function resolveAtomPackAssetPath(name: string, file: string): Promise<string> {
    if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid atom pack name: ${name}`);
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
      throw new HandlerError('invalid', `invalid atom pack asset path: ${file}`);
    }
    const packDir = join(dir, name);
    const fullPath = join(packDir, normalized);
    const rel = relative(packDir, fullPath);
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) {
      throw new HandlerError('invalid', `invalid atom pack asset path: ${file}`);
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
      throw new HandlerError('not_found', `atom pack asset not found: ${name}/${file}`);
    }
    if (linkInfo.isSymbolicLink()) throw new HandlerError('not_found', `atom pack asset not found: ${name}/${file}`);
    const realRel = relative(realPackDir, realAssetPath);
    if (!realRel || realRel.startsWith('..') || realRel.includes(`..${sep}`) || isAbsolute(realRel)) {
      throw new HandlerError('invalid', `invalid atom pack asset path: ${file}`);
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

  function atomPackAssetUrl(atomPackId: string, module: string): string | null {
    const normalized = normalizePackRelativeModule(module);
    if (!normalized) return null;
    return `/v1/atoms/${encodeURIComponent(atomPackId)}/assets/${normalized
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')}`;
  }

  function toPublicWorkspaceExperience(
    experience: RegisteredWorkspaceExperience
  ): WorkspaceExperienceDefinition | null {
    const { atomPackId: _atomPackId, ...publicExperience } = experience;
    if (!experience.atomPackId || !isPackRelativeModule(experience.entry.module)) return publicExperience;
    const module = atomPackAssetUrl(experience.atomPackId, experience.entry.module);
    if (!module) return null;
    return {
      ...publicExperience,
      entry: {
        ...publicExperience.entry,
        module
      }
    };
  }

  async function listSkillContentFiles(dir: string): Promise<GetSkillContentResponse['files']> {
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

  function resolveSkillContentTarget({ name, id }: { name: string; id?: string }): {
    id: string;
    name: string;
    dir: string;
  } {
    if (id) {
      const parts = id.split(':');
      if (parts.length === 2 && parts[0] === 'global') {
        const skillName = parts[1] as string;
        if (!SAFE_NAME.test(skillName)) throw new HandlerError('invalid', `invalid skill id: ${id}`);
        return { id, name: skillName, dir: join(deps.paths.skills, skillName) };
      }
      if (parts.length === 3 && parts[0] === 'atom-pack') {
        const packName = parts[1] as string;
        const skillName = parts[2] as string;
        if (!SAFE_NAME.test(packName) || !SAFE_NAME.test(skillName)) {
          throw new HandlerError('invalid', `invalid skill id: ${id}`);
        }
        return { id, name: skillName, dir: join(deps.paths.packs, packName, 'skills', skillName) };
      }
      if (parts.length === 3 && parts[0] === 'agent') {
        const agentName = parts[1] as string;
        const skillName = parts[2] as string;
        if (!SAFE_NAME.test(agentName) || !SAFE_NAME.test(skillName)) {
          throw new HandlerError('invalid', `invalid skill id: ${id}`);
        }
        return { id, name: skillName, dir: join(deps.paths.agents, agentName, 'skills', skillName) };
      }
      throw new HandlerError('invalid', `invalid skill id: ${id}`);
    }
    if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid skill name: ${name}`);
    return { id: `global:${name}`, name, dir: join(deps.paths.skills, name) };
  }

  async function installSkillsFromLocalPath({
    path,
    overwrite
  }: InstallLocalSkillRequest): Promise<InstallSkillResponse> {
    const dirs = await findSkillDirs(path);
    const skills: string[] = [];
    const warnings: string[] = [];
    for (const d of dirs) {
      try {
        warnings.push(...(await scanSkillDir(d)));
      } catch (err) {
        warnings.push(
          `Could not inspect ${basename(d)} before install: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        skills.push(await installSkillFromDir(deps.paths.skills, d, { overwrite }));
      } catch (err) {
        warnings.push(`Could not install ${basename(d)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { skills, commit: '', warnings };
  }

  async function installSkillUpload(upload: DecodedUpload, overwrite: boolean): Promise<InstallSkillResponse> {
    if (upload.extension === '.md') {
      const content = upload.text();
      const { frontmatter } = parseSkillMd(content);
      if (!overwrite && (await Bun.file(join(deps.paths.skills, frontmatter.name, 'SKILL.md')).exists())) {
        throw new Error(`skill "${frontmatter.name}" already exists`);
      }
      const created = await createSkillFromContent({ name: frontmatter.name, content });
      return { skills: [created.name], commit: '', warnings: created.warnings };
    }

    if (upload.extension !== '.zip' && upload.extension !== '.skill') {
      throw new Error('skill upload must be a .md, .zip, or .skill file');
    }

    const unpacked = await unpackZipUpload(upload, { prefix: 'monad-skill-upload-' });
    try {
      return await installSkillsFromLocalPath({ path: unpacked.dir, overwrite });
    } finally {
      await unpacked.cleanup();
    }
  }

  async function atomPackSkillIds(name: string): Promise<string[]> {
    const skillsDir = join(dir, name, 'skills');
    let entries: Dirent[];
    try {
      entries = await readdir(skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids: string[] = [];
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          if (await Bun.file(join(skillsDir, entry.name, 'SKILL.md')).exists()) {
            ids.push(`atom-pack:${name}:${entry.name}`);
          }
        })
    );
    return ids.sort();
  }

  async function setAtomPackSkillsEnabled(name: string, enabled: boolean): Promise<void> {
    const skillIds = await atomPackSkillIds(name);
    if (skillIds.length === 0) return;
    const cfg = await loadAll(deps.paths.config, deps.paths.profile);
    if (!cfg) return;

    const packSkillIds = new Set(skillIds);
    cfg.skills.disabled = enabled
      ? cfg.skills.disabled.filter((id) => !packSkillIds.has(id))
      : [...new Set([...cfg.skills.disabled, ...skillIds])];
    cfg.skills.autoloadDisabled = cfg.skills.autoloadDisabled.filter((id) => !packSkillIds.has(id));

    await saveProfile(deps.paths.profile, cfg);
    await deps.configBus?.publish({ cfg, auth: await loadAuth(deps.paths.auth) });
  }

  return {
    async listAtomPacks(): Promise<ListAtomPacksResponse> {
      const conflicts = deps.getConflicts?.() ?? [];
      const atomPacks: InstalledAtomPack[] = [];
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return { atomPacks, conflicts };
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        try {
          const manifest = parseAtomPackManifest(
            JSON.parse(await Bun.file(join(dir, e.name, 'atom-pack.json')).text())
          );
          const record = await readInstallRecord(dir, e.name);
          atomPacks.push({
            // Operable identity = folder name (unique; may be `<manifest>-<hash>` for a same-named
            // pack from another source). manifest.name is the display label.
            name: e.name,
            displayName: manifest.name,
            version: manifest.version,
            monadVersion: manifest.monadVersion,
            atoms: manifest.atoms,
            enabled: record.enabled !== false, // drop-in (no record) → enabled
            source: record.source,
            installedAt: record.installedAt
          });
        } catch {
          /* skip malformed atom pack dirs */
        }
      }
      return { atomPacks, conflicts };
    },

    async listWorkspaceExperiences(): Promise<ListWorkspaceExperiencesResponse> {
      return {
        experiences: (deps.getWorkspaceExperiences?.() ?? []).flatMap((experience) => {
          const publicExperience = toPublicWorkspaceExperience(experience);
          return publicExperience ? [publicExperience] : [];
        })
      };
    },

    async getAtomPackAsset({ name, path }: { name: string; path: string }): Promise<{
      bytes: Uint8Array;
      contentType?: string;
    }> {
      const fullPath = await resolveAtomPackAssetPath(name, path);
      const info = await stat(fullPath).catch(() => null);
      if (!info?.isFile()) throw new HandlerError('not_found', `atom pack asset not found: ${name}/${path}`);
      return {
        bytes: new Uint8Array(await Bun.file(fullPath).arrayBuffer()),
        contentType: contentTypeForSkillFile(path)
      };
    },

    async installAtomPack({ source, consent }: InstallAtomPackRequest): Promise<InstallAtomPackResponse> {
      const auth = await loadAuth(deps.paths.auth);
      const out = await installAtomPack(source, {
        atomPacksDir: dir,
        fetch: createAtomFetcher({
          githubToken: resolveToken(auth?.atomRegistries?.github?.token),
          npmToken: resolveToken(auth?.atomRegistries?.npm?.token),
          npmRegistry: auth?.atomRegistries?.npm?.registry
        }),
        // Default-deny: only proceed when the caller explicitly asserts consent (after seeing
        // the declared atom kinds — the UI/CLI re-calls with consent:true).
        consent: () => consent === true
      });
      if (out.installed) await deps.onChanged?.();
      return {
        name: out.name,
        atoms: out.atoms,
        warnings: out.warnings,
        ...(out.needsConsent ? { needsConsent: true } : {})
      };
    },

    async setAtomPackEnabled({ name, enabled }: { name: string; enabled: boolean }): Promise<OkResponse> {
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid atom pack name: ${name}`);
      const recordPath = join(dir, name, '.install.json');
      const record = await readInstallRecord(dir, name);
      await Bun.write(recordPath, `${JSON.stringify({ ...record, enabled }, null, 2)}\n`);
      await setAtomPackSkillsEnabled(name, enabled);
      await deps.onChanged?.(); // re-discover so a disable/enable takes effect on the registry
      return { ok: true };
    },

    async removeAtomPack({ name }: { name: string }): Promise<OkResponse> {
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid atom pack name: ${name}`);
      await rm(join(dir, name), { recursive: true, force: true });
      await deps.onChanged?.();
      return { ok: true };
    },

    /** Pin which pack wins a bare id (or clear with packId:null → first-wins). Persists to
     *  config.atomPins and re-discovers so the new winner takes effect without a restart. */
    async setAtomPin({ kind, bareId, packId }: SetAtomPinRequest): Promise<OkResponse> {
      const cfg = await loadAll(deps.paths.config, deps.paths.profile);
      if (!cfg) throw new HandlerError('invalid', 'config.json missing');
      const pins = cfg.atomPins[kind] ?? {};
      if (packId === null) delete pins[bareId];
      else pins[bareId] = packId;
      cfg.atomPins[kind] = pins;
      await saveProfile(deps.paths.profile, cfg);
      await deps.onChanged?.(); // re-resolve bare winners with the new pin
      return { ok: true };
    },

    // ── standalone skill atoms (atoms/skills/) ──────────────────────────────────
    // Installed skills hot-reload via the daemon's file watcher on paths.skills — no onChanged needed.

    async listInstalledSkills(): Promise<ListInstalledSkillsResponse> {
      const skillsDir = deps.paths.skills;
      const skills: InstalledSkill[] = [];
      let entries: Dirent[];
      try {
        entries = await readdir(skillsDir, { withFileTypes: true });
      } catch {
        return { skills };
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const skillFile = Bun.file(join(skillsDir, e.name, 'SKILL.md'));
        if (!(await skillFile.exists())) continue;
        let parsed: ReturnType<typeof parseSkillMd>;
        try {
          parsed = parseSkillMd(await skillFile.text());
        } catch {
          continue;
        }
        const rec = await readSkillRecord(skillsDir, e.name);
        skills.push({
          name: e.name,
          version: parsed.frontmatter.version,
          icon: parsed.frontmatter.icon,
          source: rec?.source,
          ref: rec?.ref,
          commit: rec?.commit,
          installedAt: rec?.installedAt
        });
      }
      return { skills };
    },

    async installSkill({ source, consent, overwrite }: InstallSkillRequest): Promise<InstallSkillResponse> {
      if (source.startsWith('git+')) {
        const out = await installGitSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: out.commit,
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      if ((source.startsWith('https://') || source.startsWith('http://')) && !isGithubHttpSource(source)) {
        const out = await installHttpSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: '',
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      if (isDefaultMarketplaceSourceSpec(source)) {
        const out = await installClawHubSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: '',
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      const auth = await loadAuth(deps.paths.auth);
      const out = await installSkillFromGithub(source, {
        skillsDir: deps.paths.skills,
        fetch: createSkillFetcher({ githubToken: resolveToken(auth?.atomRegistries?.github?.token) }),
        consent: () => consent === true,
        review: reviewInstall,
        overwrite
      });
      return reloadAfterSkillCommit({
        skills: out.skills,
        commit: out.commit,
        warnings: out.warnings,
        ...(out.needsConsent ? { needsConsent: true } : {})
      });
    },

    // Re-install a skill from its recorded source (overwrite) — i.e. pull the ref's current head.
    // A hand-dropped skill (no install record) has nothing to update from.
    async updateSkill({ name, consent }: { name: string; consent?: boolean }): Promise<InstallSkillResponse> {
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid skill name: ${name}`);
      const rec = await readSkillRecord(deps.paths.skills, name);
      if (!rec?.source) throw new HandlerError('invalid', `skill "${name}" has no recorded source to update from`);
      const source = rec.source;
      if (source.startsWith('git+')) {
        const out = await installGitSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite: true
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: out.commit,
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      if (source.startsWith('https://') || source.startsWith('http://')) {
        const out = await installHttpSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite: true
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: '',
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      if (isDefaultMarketplaceSourceSpec(source)) {
        const out = await installClawHubSkill(source, {
          skillsDir: deps.paths.skills,
          skillsLock: deps.paths.skillsLock,
          consent: () => consent === true,
          review: reviewInstall,
          overwrite: true
        });
        return reloadAfterSkillCommit({
          skills: out.skills,
          commit: '',
          warnings: out.warnings,
          ...(out.needsConsent ? { needsConsent: true } : {})
        });
      }
      const auth = await loadAuth(deps.paths.auth);
      const out = await installSkillFromGithub(source, {
        skillsDir: deps.paths.skills,
        fetch: createSkillFetcher({ githubToken: resolveToken(auth?.atomRegistries?.github?.token) }),
        consent: () => consent === true,
        review: reviewInstall,
        overwrite: true
      });
      return reloadAfterSkillCommit({
        skills: out.skills,
        commit: out.commit,
        warnings: out.warnings,
        ...(out.needsConsent ? { needsConsent: true } : {})
      });
    },

    async removeSkill({ name }: { name: string }): Promise<OkResponse> {
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid skill name: ${name}`);
      await Promise.all([
        rm(join(deps.paths.skills, name), { recursive: true, force: true }),
        removeFromSkillsLock(deps.paths.skillsLock, name)
      ]);
      await deps.onChanged?.();
      return { ok: true };
    },

    // Scaffold/create a personal skill from raw SKILL.md content. writeSkill validates the
    // frontmatter + name and throws on a mismatch.
    async createSkill({ name, content }: CreateSkillRequest): Promise<CreateSkillResponse> {
      const created = await createSkillFromContent({ name, content });
      await deps.onChanged?.();
      return created;
    },

    async getSkillContent({
      name,
      file: resourceFile,
      id
    }: {
      file?: string;
      id?: string;
      name: string;
    }): Promise<GetSkillContentResponse> {
      const target = resolveSkillContentTarget({ name, id });
      const contentPath = resourceFile
        ? resolveSkillResourcePath(target.dir, resourceFile)
        : join(target.dir, 'SKILL.md');
      const bunFile = Bun.file(contentPath);
      if (!(await bunFile.exists())) throw new HandlerError('not_found', `skill "${target.id}" not found`);
      const preview = resourceFile ? previewForSkillFile(resourceFile) : 'text';
      const contentType = resourceFile ? contentTypeForSkillFile(resourceFile) : 'text/markdown';
      const content =
        preview === 'image'
          ? Buffer.from(await bunFile.arrayBuffer()).toString('base64')
          : preview === 'text'
            ? await bunFile.text()
            : '';
      return {
        name: target.name,
        content,
        ...(contentType ? { contentType } : {}),
        encoding: preview === 'image' ? 'base64' : preview === 'text' ? 'utf8' : 'none',
        ...(resourceFile ? { file: resourceFile } : {}),
        files: await listSkillContentFiles(target.dir),
        preview
      };
    },

    async updateSkillContent({
      name,
      id,
      content
    }: { name: string; id?: string } & UpdateSkillContentRequest): Promise<CreateSkillResponse> {
      const target = resolveSkillContentTarget({ name, id });
      try {
        const { frontmatter } = parseSkillMd(content);
        if (frontmatter.name !== target.name) {
          throw new Error(`frontmatter name "${frontmatter.name}" must equal the skill name "${target.name}"`);
        }
        await mkdir(target.dir, { recursive: true });
        await Bun.write(join(target.dir, 'SKILL.md'), content);
        const enc = new TextEncoder();
        const warnings = scanSkillFiles(new Map([[`${target.name}/SKILL.md`, enc.encode(content)]]));
        await deps.onChanged?.();
        return { name: target.name, dir: target.dir, warnings };
      } catch (err) {
        throw new HandlerError('invalid', err instanceof Error ? err.message : String(err));
      }
    },

    async uploadSkill({
      filename,
      bytes,
      overwrite
    }: {
      filename: string;
      bytes: Uint8Array;
      overwrite?: boolean;
    }): Promise<InstallSkillResponse> {
      try {
        if (bytes.byteLength > SKILL_UPLOAD_MAX_BYTES) {
          throw new Error(`skill upload exceeds ${SKILL_UPLOAD_MAX_BYTES} bytes`);
        }
        const upload = decodeRawUpload({ filename, bytes });
        return await reloadAfterSkillCommit(await installSkillUpload(upload, overwrite ?? false));
      } catch (err) {
        throw new HandlerError('invalid', err instanceof Error ? err.message : String(err));
      }
    },

    // Install every skill found under a local path the daemon can read (CLI clones git sources to a
    // tmp dir first, then hands us the path). Per-skill failure is collected as a warning, not fatal.
    async installLocalSkill({ path, overwrite }: InstallLocalSkillRequest): Promise<InstallSkillResponse> {
      return reloadAfterSkillCommit(await installSkillsFromLocalPath({ path, overwrite }));
    },

    // Lint every SKILL.md under a local path (parse + dir-name match + security scan) without installing.
    async validateSkills({ path }: ValidateSkillsRequest): Promise<ValidateSkillsResponse> {
      const dirs = await findSkillDirs(path);
      const results = await Promise.all(
        dirs.map(async (d) => {
          const dirName = basename(d);
          try {
            const content = await Bun.file(join(d, 'SKILL.md')).text();
            const { frontmatter } = parseSkillMd(content);
            if (frontmatter.name !== dirName) {
              throw new Error(`frontmatter name "${frontmatter.name}" must equal directory name "${dirName}"`);
            }
            const warnings = await scanSkillDir(d);
            return { name: frontmatter.name, dir: d, ok: true, warnings };
          } catch (err) {
            return {
              name: dirName,
              dir: d,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              warnings: []
            };
          }
        })
      );
      return { results };
    },

    async checkSkillUpdates(): Promise<CheckSkillUpdatesResponse> {
      const skillsDir = deps.paths.skills;
      const auth = await loadAuth(deps.paths.auth);
      const token = resolveToken(auth?.atomRegistries?.github?.token);
      let entries: Dirent[];
      try {
        entries = await readdir(skillsDir, { withFileTypes: true });
      } catch {
        return { updates: [] };
      }
      // One remote check per skill, in PARALLEL — a single skill's failure (or an untracked skill,
      // which resolves to null) must not sink the others. Sequential awaits would be N round-trips
      // back-to-back; Promise.all collapses them to ~one round-trip of wall time.
      const results = await Promise.all(
        entries
          .filter((e) => e.isDirectory())
          .map((e) => {
            const name = e.name;
            return checkGitSkillUpdate(skillsDir, name)
              .catch(() => null)
              .then((r) => r ?? checkClawHubSkillUpdate(skillsDir, name).catch(() => null))
              .then(
                (r) => r ?? checkSkillUpdate(skillsDir, name, (s) => resolveGithubCommit(s, token)).catch(() => null)
              );
          })
      );
      return { updates: results.filter((s): s is SkillUpdate => s !== null) };
    },

    // ── registry-style MCP atoms (atoms/mcp/) ───────────────────────────────────
    // onChanged → rediscovery reconnects file MCP, so an install/remove connects/drops it hot.

    async listMcpAtoms(): Promise<ListInstalledMcpAtomsResponse> {
      return { servers: await listInstalledMcpAtoms(deps.paths.mcp) };
    },

    async installMcpAtom({ server, consent }: InstallMcpAtomRequest): Promise<InstallMcpAtomResponse> {
      const out = await installMcpAtomService(server, {
        mcpDir: deps.paths.mcp,
        consent: () => consent === true
      });
      if (!out.needsConsent) await deps.onChanged?.();
      return { name: out.name, warnings: out.warnings, ...(out.needsConsent ? { needsConsent: true } : {}) };
    },

    async installMcpBinary(req: InstallMcpBinaryRequest): Promise<InstallMcpAtomResponse> {
      const auth = await loadAuth(deps.paths.auth);
      const out = await installMcpBinaryService(
        req.name,
        { owner: req.owner, repo: req.repo, tag: req.tag },
        {
          mcpDir: deps.paths.mcp,
          fetch: createReleaseAssetFetcher({ githubToken: resolveToken(auth?.atomRegistries?.github?.token) }),
          expectedSha256: req.sha256,
          consent: () => req.consent === true,
          args: req.args,
          binName: req.binName,
          autoApproveTools: req.autoApproveTools
        }
      );
      if (!out.needsConsent) await deps.onChanged?.();
      return { name: out.name, warnings: out.warnings, ...(out.needsConsent ? { needsConsent: true } : {}) };
    },

    async setMcpAtomEnabled({ name, enabled }: { name: string; enabled: boolean }): Promise<OkResponse> {
      await setMcpAtomEnabled(deps.paths.mcp, name, enabled);
      await deps.onChanged?.(); // rediscover reconnects file MCP → the toggle takes effect hot
      return { ok: true };
    },

    async removeMcpAtom({ name }: { name: string }): Promise<OkResponse> {
      await removeMcpAtom(deps.paths.mcp, name);
      await deps.onChanged?.();
      return { ok: true };
    }
  };
}

async function readSkillRecord(skillsDir: string, name: string): Promise<SkillInstallRecord | undefined> {
  try {
    const parsed = skillInstallRecordSchema.safeParse(
      JSON.parse(await Bun.file(join(skillsDir, name, '.install.json')).text())
    );
    return parsed.success ? parsed.data : undefined; // hand-dropped / other-source / malformed
  } catch {
    return undefined; // hand-dropped skill — no install record
  }
}

async function readInstallRecord(dir: string, name: string): Promise<AtomPackInstallRecord> {
  try {
    const parsed = atomPackInstallRecordSchema.safeParse(
      JSON.parse(await Bun.file(join(dir, name, '.install.json')).text())
    );
    return parsed.success ? parsed.data : {}; // drop-in / malformed → treated as no record
  } catch {
    return {}; // drop-in atom packs have no install record
  }
}
