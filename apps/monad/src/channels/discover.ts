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
import type { AtomDescriptor, AtomKind, ChannelType } from '@monad/protocol';
import type {
  ChannelAdapterFactory,
  Connector,
  HookDefinition,
  ManifestAtomPack,
  ModelProvider,
  NativeCliProviderAdapter,
  SandboxLauncher,
  WorkspaceExperienceApi,
  WorkspaceExperienceDefinition
} from '@monad/sdk-atom';
import type { AtomConflict } from '@/atoms/resolve.ts';

import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAtomPackManifest } from '@monad/protocol';

import { assertAtomPackMonadCompatibility } from '@/atoms/compat.ts';
import { atomPackInstallRecordSchema } from '@/atoms/install/index.ts';
import { loadChannelAtomPacks } from '@/channels/atom-pack-host.ts';

export interface DiscoverChannelsResult {
  factories: Map<ChannelType, ChannelAdapterFactory>;
  errors: { atom: string; error: string }[];
}

function isManifestAtomPack(v: unknown): v is ManifestAtomPack {
  return (
    typeof v === 'object' &&
    v !== null &&
    'manifest' in v &&
    typeof (v as ManifestAtomPack).register === 'function' &&
    Array.isArray((v as ManifestAtomPack).manifest?.atoms)
  );
}

export async function discoverChannelAdapters(
  dir: string,
  sinks: {
    onConnector?: (connector: Connector) => void;
    onCommand?: (atomName: string, command: unknown) => void;
    onProvider?: (provider: ModelProvider) => void;
    onHook?: (hook: HookDefinition) => void;
    onAgentAdapter?: (adapter: NativeCliProviderAdapter) => void;
    /** Receives each sandbox launcher a discovered pack registers (e.g. a cloud e2b/Vercel
     *  launcher) — routed to the daemon's sandbox registry, preferred over built-ins on select. */
    onSandbox?: (launcher: SandboxLauncher) => void;
    /** Receives each workspace experience descriptor a discovered pack registers. */
    onWorkspaceExperience?: (experience: WorkspaceExperienceDefinition, atomPackName: string) => void;
    /** Receives each workspace experience API route set a discovered pack registers. */
    onWorkspaceExperienceApi?: (api: WorkspaceExperienceApi, atomPackName: string) => void;
    /** Receives each loaded pack's individual atoms for the per-atom detail view. */
    onAtoms?: (atomPackName: string, atoms: AtomDescriptor[]) => void;
    /** Provider types owned by the built-in pass — a discovered `provider` claiming one is a hard
     *  error (globally-unique providers; prevents shadowing a built-in like `openai`). */
    reservedProviderTypes?: ReadonlySet<string>;
    /** User pins for the `channel` kind (bare type → packId) — resolves the bare name on collision. */
    channelPins?: Readonly<Record<string, string>>;
    /** User pins for the `connector` kind (bare name → packId). */
    connectorPins?: Readonly<Record<string, string>>;
    /** Structured bare-name collision report for the conflict UI. */
    onCollision?: (conflict: AtomConflict) => void;
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
  const granted = new Map<ManifestAtomPack, readonly AtomKind[]>();
  // The pack's stable identity = its folder name (unique even when two packs share a manifest name),
  // used for qualified names / pins / conflict reporting — consistent with listAtomPacks's operable id.
  const packFolder = new Map<ManifestAtomPack, string>();
  // Stable, filesystem-independent load order so cross-pack first-wins conflict resolution is
  // reproducible across machines (readdir order is not guaranteed). Identity is the folder name.
  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const atomPacks: ManifestAtomPack[] = [];
  for (const e of dirs) {
    const atomPackDir = join(dir, e.name);
    try {
      // Skip disabled atom packs (an install record with enabled:false). Drop-ins have no record.
      let recordedIntegrity: string | undefined;
      try {
        const record = atomPackInstallRecordSchema.safeParse(
          JSON.parse(await readFile(join(atomPackDir, '.install.json'), 'utf8'))
        );
        if (record.success && record.data.enabled === false) continue;
        if (record.success) recordedIntegrity = record.data.integrity;
      } catch {
        /* no install record → treat as enabled (drop-in pack, no recorded integrity) */
      }
      const manifest = parseAtomPackManifest(JSON.parse(await readFile(join(atomPackDir, 'atom-pack.json'), 'utf8')));
      assertAtomPackMonadCompatibility(manifest.name, manifest.monadVersion);
      const grantedAtoms = manifest.atoms ?? [];
      const entryRel = manifest.entry ?? 'dist/atom-pack.js';
      const entryPath = join(atomPackDir, entryRel);
      // Defense in depth: even though the manifest schema constrains `entry`, this reader takes it
      // raw off disk — refuse an entry that escapes the pack dir (arbitrary code import).
      const rel = relative(atomPackDir, entryPath);
      if (isAbsolute(rel) || rel.startsWith('..')) {
        throw new Error(`entry "${entryRel}" escapes the atom pack dir`);
      }
      // Re-verify the bundle against the integrity hash recorded at install time before importing it
      // (the import runs the pack's code in-process). Install-time verification is a TOCTOU window:
      // anything that rewrites dist/atom-pack.js afterwards would otherwise get persistent code
      // execution on the next daemon start. No recorded hash (drop-in / publisher without one) → skip.
      if (recordedIntegrity) {
        const bytes = await readFile(entryPath);
        const got = `sha256-${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
        if (got !== recordedIntegrity) {
          throw new Error(`integrity mismatch — bundle changed since install (${got} ≠ ${recordedIntegrity})`);
        }
      }
      const mod = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
      const atomPack = mod.default;
      if (!isManifestAtomPack(atomPack)) throw new Error('entry must default-export a defineAtomPack() result');
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
      granted.set(atomPack, grantedAtoms);
      packFolder.set(atomPack, e.name);
      atomPacks.push(atomPack);
    } catch (err) {
      errors.push({ atom: e.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Load through the atom-kind-gated path (gates on the consented atoms + checks sdkVersion).
  // Connectors an atom pack declares + registers are routed to the daemon's sinks.
  const factories = await loadChannelAtomPacks(atomPacks, {
    onConnector: sinks.onConnector,
    onCommand: sinks.onCommand,
    onProvider: sinks.onProvider,
    onHook: sinks.onHook,
    onAgentAdapter: sinks.onAgentAdapter,
    onSandbox: sinks.onSandbox,
    onWorkspaceExperience: sinks.onWorkspaceExperience,
    onWorkspaceExperienceApi: sinks.onWorkspaceExperienceApi,
    onAtoms: sinks.onAtoms,
    reservedProviderTypes: sinks.reservedProviderTypes,
    channelPins: sinks.channelPins,
    connectorPins: sinks.connectorPins,
    onCollision: sinks.onCollision,
    grantedAtomsFor: (atomPack) => granted.get(atomPack),
    packIdFor: (atomPack) => packFolder.get(atomPack),
    onError: (atomPack, error) =>
      errors.push({ atom: atomPack, error: error instanceof Error ? error.message : String(error) })
  });
  return { factories, errors };
}
