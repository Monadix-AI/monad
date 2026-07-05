import type { Dirent } from 'node:fs';
import type {
  CheckSkillUpdatesResponse,
  CreateSkillRequest,
  CreateSkillResponse,
  GetSkillContentResponse,
  InstalledSkill,
  InstallLocalSkillRequest,
  InstallSkillResponse,
  ListInstalledSkillsResponse,
  OkResponse,
  SkillUpdate,
  UpdateSkillContentRequest,
  ValidateSkillsRequest,
  ValidateSkillsResponse
} from '@monad/protocol';
import type { SkillInstallReviewer } from '@/capabilities/skills/install/index.ts';
import type { AtomPacksDeps } from '@/handlers/atom-pack/atom-pack-manager.ts';

import { Buffer } from 'node:buffer';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadAll, loadAuth } from '@monad/home';

import { checkClawHubSkillUpdate, removeFromSkillsLock } from '@/capabilities/skills/install/clawhub.ts';
import { resolveGithubCommit } from '@/capabilities/skills/install/fetch.ts';
import { checkGitSkillUpdate } from '@/capabilities/skills/install/git.ts';
import { checkSkillUpdate } from '@/capabilities/skills/install/index.ts';
import { reviewSkillInstall } from '@/capabilities/skills/install/review.ts';
import { scanSkillDir, scanSkillFiles } from '@/capabilities/skills/install/scan.ts';
import {
  contentTypeForSkillFile,
  listSkillContentFiles,
  previewForSkillFile,
  resolveSkillResourcePath,
  SAFE_NAME
} from '@/handlers/atom-pack/atom-pack-content.ts';
import { resolveToken } from '@/handlers/atom-pack/atom-pack-shared.ts';
import { createSkillInstallers } from '@/handlers/atom-pack/atom-pack-skill-install.ts';
import { readSkillRecord, resolveUsableInstallReviewModel } from '@/handlers/atom-pack/atom-pack-skill-source.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
import { type DecodedUpload, decodeRawUpload, unpackZipUpload } from '@/services/upload.ts';
import { findSkillDirs, installSkillFromDir, parseSkillMd, writeSkill } from '@/store/home/skills.ts';

const SKILL_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

export function createSkillsModule(deps: AtomPacksDeps) {
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

  const { installSkill, updateSkill } = createSkillInstallers(deps, { reviewInstall, reloadAfterSkillCommit });

  const skills = {
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

    installSkill,

    updateSkill,

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
    }
  };

  return skills;
}
