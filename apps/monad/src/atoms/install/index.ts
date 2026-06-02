// Install pipeline: resolve+fetch → validate manifest → verify integrity → sdkVersion check →
// static scan → consent (default-deny) → write to ~/.monad/atoms/<name>/. The fetch + consent
// steps are injected so the orchestrator is fully testable offline; real fetchers live in fetch.ts.

import type { Dirent } from 'node:fs';
import type { AtomKind, AtomPackManifestWire } from '@monad/protocol';
import type { AtomPackSource } from '@/atoms/install/source.ts';

import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseAtomPackManifest } from '@monad/protocol';
import { SDK_VERSION } from '@monad/sdk-atom';
import { z } from 'zod';

import { assertAtomPackMonadCompatibility } from '@/atoms/compat.ts';
import { scanBundle } from '@/atoms/install/scan.ts';
import { parseAtomPackSource, sourceIdentity } from '@/atoms/install/source.ts';

/** The `.install.json` written next to each installed atom pack. Every field is optional: drop-in
 *  packs have no record, and `enabled`/`sourceId` were added over time. Schema-first because the
 *  file is an untrusted disk boundary — parsed (not cast) on read, and it drives load/enable/dedup
 *  decisions. */
export const atomPackInstallRecordSchema = z.object({
  source: z.string().optional(),
  sourceId: z.string().optional(),
  sourceKind: z.string().optional(),
  commit: z.string().optional(),
  integrity: z.string().optional(),
  grantedAtoms: z.array(z.string()).optional(),
  installedAt: z.string().optional(),
  enabled: z.boolean().optional()
});
export type AtomPackInstallRecord = z.infer<typeof atomPackInstallRecordSchema>;

/** Derive a source identity from a recorded install (new `sourceId`, or the legacy `source` spec). */
function recordedSourceId(rec: { sourceId?: string; source?: string }): string | undefined {
  if (rec.sourceId) return rec.sourceId;
  if (!rec.source) return undefined;
  try {
    return sourceIdentity(parseAtomPackSource(rec.source));
  } catch {
    return undefined;
  }
}

/** A short, stable suffix derived from the source identity — disambiguates two packs that share a
 *  manifest name but come from different sources (so both coexist under distinct dirs). */
function sourceSuffix(sourceId: string): string {
  return new Bun.CryptoHasher('sha256').update(sourceId).digest('hex').slice(0, 8);
}

/** Pick the install dir: reuse the dir already holding this source identity (update in place, even
 *  across a version bump or a manifest-name change); otherwise the `name` dir if free. If `name` is
 *  occupied by a DIFFERENT source (or a drop-in), the pack coexists under `<name>-<sourceHash>`
 *  rather than clobbering — same-named packs from different developers both install. */
async function resolveInstallDir(atomPacksDir: string, name: string, sourceId: string): Promise<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(atomPacksDir, { withFileTypes: true });
  } catch {
    return join(atomPacksDir, name); // dir absent → first install
  }
  const taken = new Set<string>();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    taken.add(e.name);
    try {
      const parsed = atomPackInstallRecordSchema.safeParse(
        JSON.parse(await Bun.file(join(atomPacksDir, e.name, '.install.json')).text())
      );
      if (parsed.success && recordedSourceId(parsed.data) === sourceId) return join(atomPacksDir, e.name); // same source → update
    } catch {
      /* no/invalid record (e.g. a drop-in) — not a source match */
    }
  }
  if (!taken.has(name)) return join(atomPacksDir, name);
  // Name taken by a different source/drop-in → coexist under a disambiguated dir.
  const suffixed = `${name}-${sourceSuffix(sourceId)}`;
  return join(atomPacksDir, suffixed);
}

export class InstallError extends Error {}

/** File-based atoms discovered in the package before install. */
export interface FileAtoms {
  skills: string[];
  mcpServers: string[];
  locales: string[];
}

/** A fetched, not-yet-installed atom pack: its manifest + the entry bundle bytes + file-based atoms. */
export interface StagedAtomPack {
  manifestRaw: unknown;
  bundle: Uint8Array;
  /** File-based atoms discovered at fetch time (skill dirs, MCP server names, locale tags). */
  fileAtoms?: FileAtoms;
}

export type AtomPackFetcher = (source: AtomPackSource) => Promise<StagedAtomPack>;

interface ConsentInfo {
  name: string;
  version: string;
  atoms: string[];
  source: string;
  warnings: string[];
  /** File-based atoms found in the package (shown in consent dialog). */
  fileAtoms?: FileAtoms;
}

export interface InstallAtomPackDeps {
  atomPacksDir: string;
  sdkVersion?: string;
  fetch: AtomPackFetcher;
  /** Default-deny: must return true to proceed. Receives declared atom kinds + scan warnings. */
  consent: (info: ConsentInfo) => boolean | Promise<boolean>;
  /** ISO timestamp to stamp .install.json (injectable for determinism). */
  now?: () => string;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface InstallOutcome {
  name: string;
  atoms: AtomKind[];
  warnings: string[];
  installed: boolean;
  needsConsent?: boolean;
  dir?: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

export async function installAtomPack(spec: string, deps: InstallAtomPackDeps): Promise<InstallOutcome> {
  const source = parseAtomPackSource(spec);
  const staged = await deps.fetch(source);
  const manifest: AtomPackManifestWire = parseAtomPackManifest(staged.manifestRaw);

  // Integrity: a pinned bundle hash must match (rug-pull / tamper guard).
  if (manifest.integrity) {
    const got = `sha256-${sha256Hex(staged.bundle)}`;
    if (got !== manifest.integrity) {
      throw new InstallError(`integrity mismatch for "${manifest.name}": ${got} ≠ ${manifest.integrity}`);
    }
  }

  // Contract-shape compatibility.
  const sdkVersion = deps.sdkVersion ?? SDK_VERSION;
  if (manifest.sdkVersion !== sdkVersion) {
    throw new InstallError(`"${manifest.name}" needs SDK ${manifest.sdkVersion}, host has ${sdkVersion}`);
  }
  assertAtomPackMonadCompatibility(manifest.name, manifest.monadVersion);

  const warnings = scanBundle(new TextDecoder().decode(staged.bundle));

  // Source-level trust warnings, surfaced for the consent decision (advisory, not a hard block — a
  // legit publisher may not have computed integrity, and the user may knowingly track a branch).
  if ((source.kind === 'github' || source.kind === 'npm') && !manifest.integrity) {
    warnings.push('no integrity hash — the bundle cannot be verified against tampering in transit');
  }
  if (source.kind === 'github' && !/^[0-9a-f]{40}$/i.test(source.ref)) {
    warnings.push(`pinned to mutable ref "${source.ref}" — content can change under you; pin to a commit SHA`);
  }

  // Consent — default-deny. Surfaces declared atom kinds + scan flags + source.
  const granted = await deps.consent({
    name: manifest.name,
    version: manifest.version,
    atoms: manifest.atoms,
    source: spec,
    warnings,
    fileAtoms: staged.fileAtoms
  });
  if (!granted) {
    return { name: manifest.name, atoms: manifest.atoms, warnings, installed: false, needsConsent: true };
  }

  // Write the atom pack tree + an install record. Dedup by source identity (same source → update the
  // existing dir, even across a version bump); a different source may not silently take a taken name.
  const entry = manifest.entry ?? 'dist/atom-pack.js';
  const sourceId = sourceIdentity(source);
  const dir = await resolveInstallDir(deps.atomPacksDir, manifest.name, sourceId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, dirname(entry)), { recursive: true });
  await Bun.write(join(dir, entry), staged.bundle);
  await Bun.write(join(dir, 'atom-pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await Bun.write(
    join(dir, '.install.json'),
    `${JSON.stringify(
      {
        source: spec,
        sourceId,
        sourceKind: source.kind,
        commit: source.kind === 'github' ? source.ref : undefined,
        integrity: manifest.integrity,
        grantedAtoms: manifest.atoms,
        installedAt: (deps.now ?? (() => new Date().toISOString()))()
      },
      null,
      2
    )}\n`
  );

  // The operable identity is the install dir (folder) name — may be suffixed when a same-named pack
  // from another source already exists. manifest.name remains the display label.
  const installedName = basename(dir);
  deps.log?.('info', `installed atom pack "${installedName}" (${manifest.atoms.join(', ') || 'no atoms'})`);
  return { name: installedName, atoms: manifest.atoms, warnings, installed: true, dir };
}

export { parseAtomPackSource } from '@/atoms/install/source.ts';
