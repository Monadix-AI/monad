// Discover third-party atom packs from ~/.monad/atoms. Each atom pack dir has an `atom-pack.json`
// manifest (cheap metadata: name/atoms/sdkVersion/entry) + a self-contained `entry` bundle
// whose default export is a defineAtomPack() result. Atom packs load through the SAME atom-kind-
// gated path as built-ins (loadChannelAtomPacks → loadManifestAtomPack): an atom pack that uses
// an undeclared atom kind throws, and sdkVersion is checked. Scan collects per-item errors, never
// throws.
//
// A discovered channel type is only REGISTERED here — nothing runs until an operator adds a
// channels[] config entry (default-deny) and enables it. So atom pack discovery is harmless on its
// own.

import type { Dirent } from 'node:fs';
import type {
  AtomDescriptor,
  AtomKind,
  ChannelType,
  InteractionRequest,
  InteractionResult,
  WorkplaceExperiencePermission
} from '@monad/protocol';
import type {
  AtomPackLog,
  ChannelAdapterFactory,
  ExperienceWorker,
  HookDefinition,
  ManifestAtomPack,
  MeshAgentProviderAdapter,
  ModelProvider,
  SandboxLauncher,
  WorkplaceExperienceApi,
  WorkplaceExperienceDefinition
} from '@monad/sdk-atom';
import type { AtomConflict } from '#/atoms/resolve.ts';

import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { parseAtomPackManifest } from '@monad/protocol';

import { assertAtomPackMonadCompatibility, assertAtomPackSdkCompatibility } from '#/atoms/compat.ts';
import { loadAtomPackEntry } from '#/atoms/entry-loader.ts';
import { type AtomPackInstallRecord, atomPackInstallRecordSchema } from '#/atoms/install/index.ts';
import {
  type AtomPackExperienceReview,
  type AtomPackTrustDecision,
  resolveAtomPackExperienceTrust
} from '#/atoms/trust.ts';
import { loadChannelAtomPacks } from '#/channels/atom-pack-host.ts';

export interface DiscoverChannelsResult {
  factories: Map<ChannelType, ChannelAdapterFactory>;
  errors: { atom: string; error: string }[];
}

export async function discoverChannelAdapters(
  dir: string,
  sinks: {
    onCommand?: (atomName: string, command: unknown) => void;
    onProvider?: (provider: ModelProvider) => void;
    onHook?: (hook: HookDefinition) => void;
    onAgentAdapter?: (adapter: MeshAgentProviderAdapter) => void;
    /** Receives each sandbox launcher a discovered pack registers (e.g. a cloud e2b
     *  launcher) — routed to the daemon's sandbox registry, preferred over built-ins on select. */
    onSandbox?: (launcher: SandboxLauncher, atomPackId: string) => void;
    /** Receives each workplace experience descriptor a discovered pack registers. */
    onWorkplaceExperience?: (
      experience: WorkplaceExperienceDefinition,
      atomPackName: string,
      permissions: readonly WorkplaceExperiencePermission[]
    ) => void;
    /** Receives each workplace experience API route set a discovered pack registers. */
    onWorkplaceExperienceApi?: (
      api: WorkplaceExperienceApi,
      atomPackName: string,
      permissions: readonly WorkplaceExperiencePermission[]
    ) => void;
    onExperienceWorker?: (
      worker: ExperienceWorker,
      atomPackName: string,
      permissions: readonly WorkplaceExperiencePermission[]
    ) => void;
    onRequestInteraction?: (atomPackId: string, request: InteractionRequest) => Promise<InteractionResult>;
    /** Receives each loaded pack's individual atoms for the per-atom detail view. */
    onAtoms?: (atomPackName: string, atoms: AtomDescriptor[]) => void;
    /** Provider types owned by the built-in pass — a discovered `provider` claiming one is a hard
     *  error (globally-unique providers; prevents shadowing a built-in like `openai`). */
    reservedProviderTypes?: ReadonlySet<string>;
    /** User pins for the `channel` kind (bare type → packId) — resolves the bare name on collision. */
    channelPins?: Readonly<Record<string, string>>;
    /** Structured bare-name collision report for the conflict UI. */
    onCollision?: (conflict: AtomConflict) => void;
    /** Loader diagnostics, including atoms refused because the pack is not accepted for their kind. */
    log?: AtomPackLog;
    /** Receives each pack that finished loading, so the caller can deactivate dropped packs later. */
    onPackLoaded?: (atomPackId: string, atomPack: ManifestAtomPack) => void;
    /** Operator policy for which packs may contribute a workplace experience. */
    experienceReview?: AtomPackExperienceReview;
  } = {}
): Promise<DiscoverChannelsResult> {
  const errors: { atom: string; error: string }[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { factories: new Map(), errors }; // dir absent → nothing to discover
  }

  // The atom kinds gating each pack are the on-disk `atom-pack.json` atoms — the artifact the user
  // audited + consented to at install (the install pipeline writes it from the consented manifest).
  // The bundle's own embedded `manifest.atoms` is NEVER trusted for gating: a bundle can self-declare
  // any set, so trusting it would let an installed pack register atoms the user never consented to.
  const metadata = new Map<
    ManifestAtomPack,
    {
      grantedAtoms: readonly AtomKind[];
      permissions: readonly WorkplaceExperiencePermission[];
      trust: AtomPackTrustDecision;
      folder: string;
    }
  >();
  // Stable, filesystem-independent load order so cross-pack first-wins conflict resolution is
  // reproducible across machines (readdir order is not guaranteed). Identity is the folder name.
  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const atomPacks: ManifestAtomPack[] = [];
  for (const e of dirs) {
    const atomPackDir = join(dir, e.name);
    try {
      // Skip disabled atom packs (an install record with enabled:false). Drop-ins have no record.
      let recordedIntegrity: string | undefined;
      let installRecord: AtomPackInstallRecord | undefined;
      try {
        const record = atomPackInstallRecordSchema.safeParse(
          JSON.parse(await readFile(join(atomPackDir, '.install.json'), 'utf8'))
        );
        if (record.success && record.data.enabled === false) continue;
        if (record.success) {
          installRecord = record.data;
          recordedIntegrity = record.data.integrity;
        }
      } catch {
        /* no install record → treat as enabled (drop-in pack, no recorded integrity) */
      }
      const manifest = parseAtomPackManifest(JSON.parse(await readFile(join(atomPackDir, 'atom-pack.json'), 'utf8')));
      assertAtomPackSdkCompatibility(manifest.name, manifest.sdkVersion);
      assertAtomPackMonadCompatibility(manifest.name, manifest.monadVersion);
      const grantedAtoms = manifest.atoms ?? [];
      const entryRel = manifest.entry ?? 'dist/atom-pack.js';
      const entryPath = join(atomPackDir, entryRel);
      // Defense in depth: even though the manifest schema constrains `entry`, this reader takes it
      // raw off disk — refuse an entry that escapes the pack dir (arbitrary code import).
      const rel = relative(atomPackDir, entryPath);
      if (isAbsolute(rel) || rel.startsWith('..')) {
        throw new Error(`entry "${entryRel}" escapes the Atom Pack directory`);
      }
      const atomPack = await loadAtomPackEntry(entryPath, recordedIntegrity);
      // Defense in depth: the bundle must not self-declare atoms beyond the consented set. A superset
      // signals the published bundle drifted from the audited manifest — refuse the whole pack rather
      // than silently load the consented subset. (Gating below also denies, but rejecting upfront is
      // a clearer signal and avoids a half-loaded pack.)
      const grant = new Set<AtomKind>(grantedAtoms);
      const overreach = atomPack.manifest.atoms.filter((a) => !grant.has(a));
      if (overreach.length > 0) {
        throw new Error(
          `bundle declares atoms [${atomPack.manifest.atoms.join(', ')}] beyond consented [${grantedAtoms.join(', ')}] (extra: ${overreach.join(', ')}); refusing — reinstall to re-consent`
        );
      }
      metadata.set(atomPack, {
        grantedAtoms,
        permissions: manifest.permissions ?? [],
        trust: resolveAtomPackExperienceTrust({
          atomPackId: e.name,
          record: installRecord,
          review: sinks.experienceReview
        }),
        folder: e.name
      });
      atomPacks.push(atomPack);
    } catch (err) {
      errors.push({ atom: e.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Load through the atom-kind-gated path (gates on the consented atoms + checks sdkVersion).
  const factories = await loadChannelAtomPacks(atomPacks, {
    onCommand: sinks.onCommand,
    onProvider: sinks.onProvider,
    onHook: sinks.onHook,
    onAgentAdapter: sinks.onAgentAdapter,
    onSandbox: sinks.onSandbox,
    onWorkplaceExperience: sinks.onWorkplaceExperience,
    onWorkplaceExperienceApi: sinks.onWorkplaceExperienceApi,
    onExperienceWorker: sinks.onExperienceWorker,
    onRequestInteraction: sinks.onRequestInteraction,
    onAtoms: sinks.onAtoms,
    reservedProviderTypes: sinks.reservedProviderTypes,
    channelPins: sinks.channelPins,
    onCollision: sinks.onCollision,
    grantedAtomsFor: (atomPack) => metadata.get(atomPack)?.grantedAtoms,
    grantedPermissionsFor: (atomPack) => metadata.get(atomPack)?.permissions,
    experienceTrustFor: (atomPack) => metadata.get(atomPack)?.trust,
    log: sinks.log,
    onPackLoaded: sinks.onPackLoaded,
    packIdFor: (atomPack) => metadata.get(atomPack)?.folder,
    onError: (atomPack, error) =>
      errors.push({ atom: atomPack, error: error instanceof Error ? error.message : String(error) })
  });
  return { factories, errors };
}
