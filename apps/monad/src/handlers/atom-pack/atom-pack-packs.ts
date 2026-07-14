import type { Dirent } from 'node:fs';
import type {
  GetAtomPackResponse,
  InstallAtomPackRequest,
  InstallAtomPackResponse,
  InstalledAtomPack,
  ListAtomPacksResponse,
  ListWorkspaceExperiencesResponse,
  OkResponse,
  SetAtomPinRequest
} from '@monad/protocol';
import type { WorkspaceExperienceApiHandler } from '@monad/sdk-atom';
import type { AtomPackSource } from '#/atoms/install/source.ts';
import type { AtomPacksDeps } from '#/handlers/atom-pack/atom-pack-manager.ts';

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import builtinAtomPack from '@monad/atoms';
import { loadAll, loadAuth, saveProfile } from '@monad/home';
import { parseAtomPackManifest } from '@monad/protocol';

import { describeAtomPack } from '#/atoms/describe.ts';
import { createAtomFetcher } from '#/atoms/install/fetch.ts';
import {
  type AtomPackInstallRecord,
  atomPackInstallRecordSchema,
  installAtomPack,
  type StagedAtomPack
} from '#/atoms/install/index.ts';
import {
  contentTypeForSkillFile,
  resolveAtomPackAssetPath,
  SAFE_NAME,
  toPublicWorkspaceExperience
} from '#/handlers/atom-pack/atom-pack-content.ts';
import { resolveToken } from '#/handlers/atom-pack/atom-pack-shared.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { createWorkspaceExperienceApiContext } from '#/handlers/atom-pack/experience-capabilities.ts';
import { type DecodedUpload, decodeRawUpload, unpackZipUpload } from '#/services/upload.ts';

const ATOM_PACK_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const MONAD_POWER_PACK_DEBUG_SOURCE = 'debug:monad-power-pack';
const MONAD_POWER_PACK_GITHUB_SOURCE = 'github:monadix-labs/monad-power-pack@debug';

async function loadDebugMonadPowerPack(source: AtomPackSource): Promise<StagedAtomPack | null> {
  if (Bun.env.NODE_ENV === 'production') return null;
  if (
    source.kind !== 'github' ||
    source.owner !== 'monadix-labs' ||
    source.repo !== 'monad-power-pack' ||
    source.ref !== 'debug'
  ) {
    return null;
  }

  const powerPackPackage = ['@monad', 'monad-power-pack'].join('/');
  const { stagedMonadPowerPack } = (await import(powerPackPackage)) as {
    stagedMonadPowerPack: () => StagedAtomPack | Promise<StagedAtomPack>;
  };
  return stagedMonadPowerPack();
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

export function createPacksModule(deps: AtomPacksDeps) {
  const dir = deps.paths.packs;

  function normalizeAtomPackSource(source: string): string {
    return source.trim() === MONAD_POWER_PACK_DEBUG_SOURCE ? MONAD_POWER_PACK_GITHUB_SOURCE : source;
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
    await deps.configReloader?.publish({ cfg, auth: await loadAuth(deps.paths.auth) });
  }

  async function installAtomPackUpload(upload: DecodedUpload, consent: boolean): Promise<InstallAtomPackResponse> {
    if (upload.extension !== '.zip') {
      throw new Error('atom pack upload must be a .zip file');
    }
    const unpacked = await unpackZipUpload(upload, { prefix: 'monad-atom-pack-upload-' });
    try {
      return await packs.installAtomPack({ source: `local:${unpacked.dir}`, consent });
    } finally {
      await unpacked.cleanup();
    }
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
            installedAt: record.installedAt,
            description: manifest.description,
            author: manifest.author,
            sdkVersion: manifest.sdkVersion,
            repository: manifest.source,
            // Individual atoms captured by the last discovery sweep (keyed by folder name); empty
            // until the pack has loaded, in which case the UI falls back to the kind summary.
            atomDetails: deps.getAtomDetails?.(e.name) ?? []
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
      if (!found) throw new HandlerError('not_found', `atom pack not found: ${name}`);
      return { atomPack: found };
    },

    async listWorkspaceExperiences(): Promise<ListWorkspaceExperiencesResponse> {
      const snapshot = deps.getWorkspaceExperienceSnapshot?.();
      if (snapshot) return { experiences: snapshot };
      return {
        experiences: (deps.getWorkspaceExperiences?.() ?? []).flatMap((experience) => {
          const publicExperience = toPublicWorkspaceExperience(experience);
          return publicExperience ? [publicExperience] : [];
        })
      };
    },

    getWorkspaceExperienceApiHandler(
      experienceId: string,
      method: string,
      path: string
    ): ((request: Request) => Response | Promise<Response>) | undefined {
      const route = deps.getWorkspaceExperienceApiRoute?.(experienceId, method, path);
      const handler = route?.handler ?? deps.getWorkspaceExperienceApiHandler?.(experienceId, method, path);
      if (!handler) return undefined;
      if (!deps.ownerPrincipalId || !deps.experienceCapabilities) {
        return () => Promise.reject(new Error('workspace Experience capabilities are unavailable'));
      }
      const context = createWorkspaceExperienceApiContext({
        atomPackId: route?.atomPackId ?? 'test-pack',
        principalId: deps.ownerPrincipalId,
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
      if (!info?.isFile()) throw new HandlerError('not_found', `atom pack asset not found: ${name}/${path}`);
      return {
        bytes: new Uint8Array(await Bun.file(fullPath).arrayBuffer()),
        contentType: contentTypeForSkillFile(path)
      };
    },

    async installAtomPack({ source, consent }: InstallAtomPackRequest): Promise<InstallAtomPackResponse> {
      const auth = await loadAuth(deps.paths.auth);
      const normalizedSource = normalizeAtomPackSource(source);
      const fetch = createAtomFetcher({
        githubToken: resolveToken(auth?.atomRegistries?.github?.token),
        npmToken: resolveToken(auth?.atomRegistries?.npm?.token),
        npmRegistry: auth?.atomRegistries?.npm?.registry
      });
      const out = await installAtomPack(normalizedSource, {
        atomPacksDir: dir,
        fetch: async (parsedSource) => {
          const debugPowerPack = await loadDebugMonadPowerPack(parsedSource);
          if (debugPowerPack) return debugPowerPack;
          return fetch(parsedSource);
        },
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

    async uploadAtomPack({
      filename,
      bytes,
      consent
    }: {
      filename: string;
      bytes: Uint8Array;
      consent?: boolean;
    }): Promise<InstallAtomPackResponse> {
      if (bytes.byteLength > ATOM_PACK_UPLOAD_MAX_BYTES) {
        throw new HandlerError('invalid', `atom pack upload exceeds ${ATOM_PACK_UPLOAD_MAX_BYTES} bytes`);
      }
      try {
        return await installAtomPackUpload(decodeRawUpload({ filename, bytes }), consent === true);
      } catch (err) {
        throw new HandlerError('invalid', err instanceof Error ? err.message : String(err));
      }
    },

    async setAtomPackEnabled({ name, enabled }: { name: string; enabled: boolean }): Promise<OkResponse> {
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid atom pack name: ${name}`);
      if (!(await stat(join(dir, name)).catch(() => null))?.isDirectory()) {
        throw new HandlerError('not_found', `atom pack not found: ${name}`);
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
      if (!SAFE_NAME.test(name)) throw new HandlerError('invalid', `invalid atom pack name: ${name}`);
      if (!(await stat(join(dir, name)).catch(() => null))?.isDirectory()) {
        throw new HandlerError('not_found', `atom pack not found: ${name}`);
      }
      await deps.sandboxActivation?.ensurePackCanDeactivate(name);
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
    }
  };

  return packs;
}
