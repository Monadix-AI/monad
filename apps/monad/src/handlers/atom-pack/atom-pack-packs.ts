import type { Dirent } from 'node:fs';
import type {
  AtomDescriptor,
  AtomPackUpdateCheck,
  GetAtomPackResponse,
  InstallAtomPackRequest,
  InstallAtomPackResponse,
  InstalledAtomPack,
  ListAtomPacksResponse,
  ListWorkplaceExperiencesResponse,
  OkResponse,
  SetAtomPinRequest,
  UpdateAtomPackRequest
} from '@monad/protocol';
import type { AtomPacksDeps } from '#/handlers/atom-pack/atom-pack-manager.ts';

import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import builtinAtomPack from '@monad/atoms';
import { parseAtomPackManifest } from '@monad/protocol';

import { describeAtomPack } from '#/atoms/describe.ts';
import { createAtomFetcher } from '#/atoms/install/fetch.ts';
import { type AtomPackInstallRecord, atomPackInstallRecordSchema, installAtomPack } from '#/atoms/install/index.ts';
import { parseAtomPackSource, sourceIdentity } from '#/atoms/install/source.ts';
import {
  contentTypeForSkillFile,
  resolveAtomPackAssetPath,
  SAFE_NAME,
  toPublicWorkplaceExperience
} from '#/handlers/atom-pack/atom-pack-content.ts';
import { createWorkplaceExperienceApiContext } from '#/handlers/atom-pack/experience-capabilities.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { parseSkillMd } from '#/store/home/skills.ts';

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

async function describeAtomPackSkills(
  packDir: string,
  skillDirs: readonly string[] = ['skills']
): Promise<AtomDescriptor[]> {
  const descriptors: AtomDescriptor[] = [];
  for (const skillDir of skillDirs) {
    const fullDir = resolve(packDir, skillDir);
    const rel = relative(packDir, fullDir);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(fullDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const { frontmatter } = parseSkillMd(await Bun.file(join(fullDir, entry.name, 'SKILL.md')).text());
        descriptors.push({ kind: 'skill', id: frontmatter.name, description: frontmatter.description });
      } catch {
        // Invalid or missing SKILL.md files are ignored consistently with skill discovery.
      }
    }
  }
  return descriptors.sort((a, b) => a.id.localeCompare(b.id));
}

function mergeAtomDetails(runtime: AtomDescriptor[], fileBased: AtomDescriptor[]): AtomDescriptor[] {
  const merged = new Map(runtime.map((atom) => [`${atom.kind}:${atom.id}`, atom]));
  for (const atom of fileBased) merged.set(`${atom.kind}:${atom.id}`, atom);
  return [...merged.values()];
}

export function createPacksModule(deps: AtomPacksDeps) {
  const dir = deps.paths.packs;

  async function canReuseInstallSource(record: AtomPackInstallRecord): Promise<boolean> {
    if (!record.source) return false;
    try {
      const source = parseAtomPackSource(record.source);
      if (source.kind !== 'local') return true;
      return (await stat(resolve(source.path)).catch(() => null))?.isDirectory() === true;
    } catch {
      return false;
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
    if (!deps.config) throw new Error('Atom Packs: config manager unavailable');
    await deps.config.updateConfig((cfg) => {
      const packSkillIds = new Set(skillIds);
      cfg.skills.disabled = enabled
        ? cfg.skills.disabled.filter((id) => !packSkillIds.has(id))
        : [...new Set([...cfg.skills.disabled, ...skillIds])];
      cfg.skills.autoloadDisabled = cfg.skills.autoloadDisabled.filter((id) => !packSkillIds.has(id));
    });
  }

  const packs = {
    async listAtomPacks(): Promise<ListAtomPacksResponse> {
      const conflicts = deps.getConflicts?.() ?? [];
      // The first-party pack is bundled, not on disk under the install dir, so it is synthesized from
      // its manifest and listed first — read-only (always enabled, not removable).
      const atomPacks: InstalledAtomPack[] = [
        {
          name: builtinAtomPack.manifest.name,
          displayName: builtinAtomPack.manifest.name,
          version: builtinAtomPack.manifest.version,
          monadVersion: builtinAtomPack.manifest.monadVersion,
          atoms: builtinAtomPack.manifest.atoms,
          enabled: true,
          source: 'builtin',
          canUpdate: false,
          installedAt: undefined,
          description: builtinAtomPack.manifest.description,
          author: builtinAtomPack.manifest.author,
          sdkVersion: builtinAtomPack.manifest.sdkVersion,
          builtin: true,
          atomDetails: await describeAtomPack(builtinAtomPack)
        }
      ];
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
          const atomDetails = mergeAtomDetails(
            deps.getAtomDetails?.(e.name) ?? [],
            await describeAtomPackSkills(join(dir, e.name), manifest.skillDirs)
          );
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
            sourceKind: record.sourceKind === 'github' || record.sourceKind === 'local' ? record.sourceKind : undefined,
            revision: record.revision ?? record.commit,
            canUpdate: await canReuseInstallSource(record),
            installedAt: record.installedAt,
            description: manifest.description,
            author: manifest.author,
            sdkVersion: manifest.sdkVersion,
            repository: manifest.source,
            // Runtime-registered atoms plus file-based skill metadata parsed from SKILL.md.
            atomDetails
          });
        } catch {
          /* skip malformed atom pack dirs */
        }
      }
      return { atomPacks, conflicts };
    },

    async getAtomPack({ name }: { name: string }): Promise<GetAtomPackResponse> {
      const { atomPacks } = await packs.listAtomPacks();
      const found = atomPacks.find((pack) => pack.name === name);
      if (!found) throw new HandlerError('not_found', `Atom Pack not found: ${name}`);
      return { atomPack: found };
    },

    async listWorkplaceExperiences(): Promise<ListWorkplaceExperiencesResponse> {
      const snapshot = deps.getWorkplaceExperienceSnapshot?.();
      if (snapshot) return { experiences: snapshot };
      return {
        experiences: (deps.getWorkplaceExperiences?.() ?? []).flatMap((experience) => {
          const publicExperience = toPublicWorkplaceExperience(experience);
          return publicExperience ? [publicExperience] : [];
        })
      };
    },

    getWorkplaceExperienceApiHandler(
      experienceId: string,
      method: string,
      path: string
    ): ((request: Request) => Response | Promise<Response>) | undefined {
      const route = deps.getWorkplaceExperienceApiRoute?.(experienceId, method, path);
      const handler = route?.handler ?? deps.getWorkplaceExperienceApiHandler?.(experienceId, method, path);
      if (!handler) return undefined;
      if (!deps.experienceCapabilities) {
        return () => Promise.reject(new Error('workplace experience capabilities are unavailable'));
      }
      const context = createWorkplaceExperienceApiContext({
        atomPackId: route?.atomPackId ?? 'test-pack',
        experienceId,
        permissions: route?.permissions ?? [],
        deps: deps.experienceCapabilities
      });
      return (request) => handler(request, context);
    },

    async getAtomPackAsset({ name, path }: { name: string; path: string }): Promise<{
      bytes: Uint8Array;
      contentType?: string;
    }> {
      const fullPath = await resolveAtomPackAssetPath(dir, name, path);
      const info = await stat(fullPath).catch(() => null);
      if (!info?.isFile()) throw new HandlerError('not_found', `Atom Pack asset not found: ${name}/${path}`);
      return {
        bytes: new Uint8Array(await Bun.file(fullPath).arrayBuffer()),
        contentType: contentTypeForSkillFile(path)
      };
    },

    async installAtomPack({ source, consent }: InstallAtomPackRequest): Promise<InstallAtomPackResponse> {
      const requestedId = sourceIdentity(parseAtomPackSource(source));
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const record = await readInstallRecord(dir, entry.name);
        let installedId = record.sourceId;
        if (!installedId && record.source) {
          try {
            installedId = sourceIdentity(parseAtomPackSource(record.source));
          } catch {
            installedId = undefined;
          }
        }
        if (installedId === requestedId) {
          throw new HandlerError(
            'invalid',
            `Atom Pack source is already installed as ${entry.name}; check and confirm an update instead`
          );
        }
      }
      return installFromSource(source, consent);
    },

    async checkAtomPackUpdate({ name }: { name: string }): Promise<AtomPackUpdateCheck> {
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid Atom Pack name: ${name}`);
      if (!(await stat(join(dir, name)).catch(() => null))?.isDirectory()) {
        throw new HandlerError('not_found', `Atom Pack not found: ${name}`);
      }
      const record = await readInstallRecord(dir, name);
      if (!(await canReuseInstallSource(record)) || !record.source) {
        throw new HandlerError('invalid', `Atom Pack cannot be updated from its recorded source: ${name}`);
      }
      const source = parseAtomPackSource(record.source);
      const fetch = createFetcher();
      const staged = await fetch(source);
      const latestManifest = parseAtomPackManifest(staged.manifestRaw);
      const currentManifest = parseAtomPackManifest(
        JSON.parse(await Bun.file(join(dir, name, 'atom-pack.json')).text())
      );
      const currentRevision = record.revision ?? record.commit ?? currentManifest.integrity ?? currentManifest.version;
      const latestRevision = staged.revision ?? latestManifest.integrity ?? latestManifest.version;
      return {
        name,
        source: record.source,
        sourceKind: source.kind,
        currentVersion: currentManifest.version,
        latestVersion: latestManifest.version,
        currentRevision,
        latestRevision,
        hasUpdate: currentRevision !== latestRevision
      };
    },

    async updateAtomPack({
      name,
      confirm,
      revision
    }: { name: string } & UpdateAtomPackRequest): Promise<InstallAtomPackResponse> {
      if (!confirm) throw new HandlerError('invalid', 'Atom Pack update requires explicit confirmation');
      const check = await packs.checkAtomPackUpdate({ name });
      if (check.latestRevision !== revision) {
        throw new HandlerError(
          'invalid',
          'Atom Pack source changed after the update check; check again before confirming'
        );
      }
      const record = await readInstallRecord(dir, name);
      if (!record.source) throw new HandlerError('invalid', `Atom Pack has no recorded source: ${name}`);
      await deps.sandboxActivation?.ensurePackCanDeactivate(name);
      return installFromSource(record.source, true, record.enabled !== false, revision);
    },

    async setAtomPackEnabled({ name, enabled }: { name: string; enabled: boolean }): Promise<OkResponse> {
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid Atom Pack name: ${name}`);
      if (!(await stat(join(dir, name)).catch(() => null))?.isDirectory()) {
        throw new HandlerError('not_found', `Atom Pack not found: ${name}`);
      }
      if (!enabled) await deps.sandboxActivation?.ensurePackCanDeactivate(name);
      const recordPath = join(dir, name, '.install.json');
      const record = await readInstallRecord(dir, name);
      await Bun.write(recordPath, `${JSON.stringify({ ...record, enabled }, null, 2)}\n`);
      await setAtomPackSkillsEnabled(name, enabled);
      await deps.onChanged?.(); // re-discover so a disable/enable takes effect on the registry
      return { ok: true };
    },

    async removeAtomPack({ name }: { name: string }): Promise<OkResponse> {
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid Atom Pack name: ${name}`);
      if (!(await stat(join(dir, name)).catch(() => null))?.isDirectory()) {
        throw new HandlerError('not_found', `Atom Pack not found: ${name}`);
      }
      await deps.sandboxActivation?.ensurePackCanDeactivate(name);
      await rm(join(dir, name), { recursive: true, force: true });
      try {
        await deps.onChanged?.();
      } catch {
        // The directory mutation is authoritative; a refresh failure cannot turn it into a failed deletion.
      }
      return { ok: true };
    },

    /** Pin which pack wins a bare id (or clear with packId:null → first-wins). Persists to
     *  config.atomPins and re-discovers so the new winner takes effect without a restart. */
    async setAtomPin({ kind, bareId, packId }: SetAtomPinRequest): Promise<OkResponse> {
      if (!deps.config) throw new HandlerError('invalid', 'config manager unavailable');
      await deps.config.updateConfig((cfg) => {
        const pins = cfg.atomPins[kind] ?? {};
        if (packId === null) delete pins[bareId];
        else pins[bareId] = packId;
        cfg.atomPins[kind] = pins;
      });
      await deps.onChanged?.(); // re-resolve bare winners with the new pin
      return { ok: true };
    }
  };

  async function installFromSource(
    source: string,
    consent: boolean,
    restoreEnabled?: boolean,
    expectedRevision?: string
  ): Promise<InstallAtomPackResponse> {
    const fetchSource = createFetcher();
    const fetch = async (parsed: ReturnType<typeof parseAtomPackSource>) => {
      const staged = await fetchSource(parsed);
      const revision = staged.revision ?? parseAtomPackManifest(staged.manifestRaw).integrity;
      if (expectedRevision && revision !== expectedRevision) {
        throw new HandlerError(
          'invalid',
          'Atom Pack source changed after the update check; check again before confirming'
        );
      }
      return staged;
    };
    const out = await installAtomPack(source, {
      atomPacksDir: dir,
      fetch,
      // Default-deny: only proceed when the caller explicitly asserts consent (after seeing
      // the declared atom kinds — the UI/CLI re-calls with consent:true).
      consent: () => consent === true
    });
    if (out.installed && out.dir && restoreEnabled !== undefined) {
      const record = await readInstallRecord(dir, out.name);
      await Bun.write(
        join(out.dir, '.install.json'),
        `${JSON.stringify({ ...record, enabled: restoreEnabled }, null, 2)}\n`
      );
      await setAtomPackSkillsEnabled(out.name, restoreEnabled);
    }
    if (out.installed) await deps.onChanged?.();
    return {
      name: out.name,
      atoms: out.atoms,
      warnings: out.warnings,
      ...(out.needsConsent ? { needsConsent: true } : {})
    };
  }

  return packs;

  function createFetcher() {
    const registries = deps.config?.get().cfg.atomRegistries;
    return createAtomFetcher({ githubToken: registries?.github?.token });
  }
}
