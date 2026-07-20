import type { VmBaselineArtifact } from '../driver/vfkit.ts';

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { sha256OfFile } from '../util.ts';

const FORMAT = 'monad-vm-baseline';
const SCHEMA_VERSION = 1;
const MANIFEST = 'manifest.json';
const OWNER = '.cache-owner.json';
const ownerTokenSchema = z.object({ token: z.unknown().optional() });
const ownerPidSchema = z.object({ pid: z.unknown().optional() });

export interface BaselineManifestInput {
  identity: string;
  reuseDigest: string;
  driver: { kind: string; version: string; toolchain: string; arch: string };
  guest: { agent: string; observer: string; protocol: number; ignition: string; mountPlan: string };
  topology: { cpus: number; memoryMiB: number; digest: string };
  bootEpoch: string;
}

interface BaselineArtifactFile {
  name: string;
  byteSize: number;
  digest: string;
}

export interface BaselineManifest extends BaselineManifestInput {
  format: typeof FORMAT;
  schemaVersion: typeof SCHEMA_VERSION;
  createdAt: number;
  artifacts: BaselineArtifactFile[];
}

export interface CachedBaseline extends VmBaselineArtifact {
  dir: string;
  manifest: BaselineManifest;
}

export interface BaselineCacheLimits {
  maxInactiveArtifacts: number;
  maxBytes: number;
}

export enum BaselineCacheError {
  LEASED = 'LEASED',
  INVALID_MANIFEST = 'INVALID_MANIFEST',
  INVALID_ARTIFACT = 'INVALID_ARTIFACT'
}

class CacheFailure extends Error {
  constructor(readonly code: BaselineCacheError) {
    super(code);
  }
}

export interface BaselineLease {
  release(): Promise<void>;
}

export interface BaselineRestoreLease extends BaselineLease {
  artifact: CachedBaseline;
}

function safeIdentity(identity: string): string {
  return new Bun.CryptoHasher('sha256').update(identity).digest('hex');
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function safeArtifactName(root: string, name: string): boolean {
  if (!string(name) || isAbsolute(name)) return false;
  const path = resolve(root, name);
  const fromRoot = relative(resolve(root), path);
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}

const baselineManifestSchema: z.ZodType<BaselineManifest> = z
  .object({
    format: z.literal(FORMAT),
    schemaVersion: z.literal(SCHEMA_VERSION),
    identity: z.string(),
    reuseDigest: z.string(),
    driver: z.object({ kind: z.string(), version: z.string(), toolchain: z.string(), arch: z.string() }).strict(),
    guest: z
      .object({
        agent: z.string(),
        observer: z.string(),
        protocol: z.number().int(),
        ignition: z.string(),
        mountPlan: z.string()
      })
      .strict(),
    topology: z.object({ cpus: z.number().int(), memoryMiB: z.number().int(), digest: z.string() }).strict(),
    bootEpoch: z.string(),
    createdAt: z.number().int(),
    artifacts: z
      .array(
        z
          .object({
            name: z.string().refine((name) => safeArtifactName('/baseline', name)),
            byteSize: z.number().int().nonnegative(),
            digest: z.string()
          })
          .strict()
      )
      .min(1)
      .max(16)
  })
  .strict();

function parseManifest(value: unknown): BaselineManifest | undefined {
  const root = object(value);
  if (
    !root ||
    !exactKeys(root, [
      'format',
      'schemaVersion',
      'identity',
      'reuseDigest',
      'driver',
      'guest',
      'topology',
      'bootEpoch',
      'createdAt',
      'artifacts'
    ]) ||
    root.format !== FORMAT ||
    root.schemaVersion !== SCHEMA_VERSION ||
    !string(root.identity) ||
    !string(root.reuseDigest) ||
    !string(root.bootEpoch) ||
    !Number.isSafeInteger(root.createdAt) ||
    !Array.isArray(root.artifacts) ||
    root.artifacts.length === 0 ||
    root.artifacts.length > 16
  ) {
    return undefined;
  }
  const driver = object(root.driver);
  const guest = object(root.guest);
  const topology = object(root.topology);
  if (
    !driver ||
    !exactKeys(driver, ['kind', 'version', 'toolchain', 'arch']) ||
    ![driver.kind, driver.version, driver.toolchain, driver.arch].every(string) ||
    !guest ||
    !exactKeys(guest, ['agent', 'observer', 'protocol', 'ignition', 'mountPlan']) ||
    ![guest.agent, guest.observer, guest.ignition, guest.mountPlan].every(string) ||
    !Number.isSafeInteger(guest.protocol) ||
    !topology ||
    !exactKeys(topology, ['cpus', 'memoryMiB', 'digest']) ||
    !Number.isSafeInteger(topology.cpus) ||
    !Number.isSafeInteger(topology.memoryMiB) ||
    !string(topology.digest)
  ) {
    return undefined;
  }
  for (const entry of root.artifacts) {
    const artifact = object(entry);
    if (
      !artifact ||
      !exactKeys(artifact, ['name', 'byteSize', 'digest']) ||
      !string(artifact.name) ||
      !safeArtifactName('/baseline', artifact.name) ||
      !Number.isSafeInteger(artifact.byteSize) ||
      (artifact.byteSize as number) < 0 ||
      !string(artifact.digest)
    ) {
      return undefined;
    }
  }
  return baselineManifestSchema.parse(root);
}

export class BaselineCache {
  private readonly restoreLeases = new Map<string, number>();

  constructor(
    readonly root: string,
    private readonly limits: BaselineCacheLimits
  ) {
    if (!Number.isSafeInteger(limits.maxInactiveArtifacts) || limits.maxInactiveArtifacts < 0) {
      throw new Error('baseline cache: invalid artifact limit');
    }
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0)
      throw new Error('baseline cache: invalid byte limit');
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
  }

  private dir(identity: string): string {
    return join(this.root, safeIdentity(identity));
  }

  async acquireCaptureLease(identity: string): Promise<BaselineLease> {
    await this.ensureRoot();
    const path = join(this.root, `.capture-${safeIdentity(identity)}.lock`);
    const token = randomUUID();
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    } catch {
      if (existsSync(path) && !existsSync(join(path, 'owner.json'))) await rm(path, { recursive: true, force: true });
      throw new CacheFailure(BaselineCacheError.LEASED);
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          const owner = ownerTokenSchema.parse(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')));
          if (owner.token === token) await rm(path, { recursive: true, force: true });
        } catch {
          // A missing or replaced lease is not ours to remove.
        }
      }
    };
  }

  async publish(
    input: BaselineManifestInput,
    writeArtifacts: (temporaryDir: string) => Promise<string[]>
  ): Promise<CachedBaseline> {
    await this.ensureRoot();
    const target = this.dir(input.identity);
    const temporary = join(this.root, `.tmp-${safeIdentity(input.identity)}-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    await writeFile(join(temporary, OWNER), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    try {
      const names = (await writeArtifacts(temporary)).filter((name) => name !== OWNER);
      if (names.length === 0 || names.length > 16 || new Set(names).size !== names.length) {
        throw new CacheFailure(BaselineCacheError.INVALID_ARTIFACT);
      }
      const artifacts: BaselineArtifactFile[] = [];
      for (const name of names) {
        if (!safeArtifactName(temporary, name)) throw new CacheFailure(BaselineCacheError.INVALID_ARTIFACT);
        const path = resolve(temporary, name);
        const info = await lstat(path);
        if (!info.isFile()) throw new CacheFailure(BaselineCacheError.INVALID_ARTIFACT);
        artifacts.push({ name, byteSize: info.size, digest: await sha256OfFile(path) });
      }
      if (artifacts.length === 0) throw new CacheFailure(BaselineCacheError.INVALID_ARTIFACT);
      const manifest: BaselineManifest = {
        format: FORMAT,
        schemaVersion: SCHEMA_VERSION,
        ...input,
        createdAt: Date.now(),
        artifacts
      };
      await rm(join(temporary, OWNER), { force: true });
      await writeFile(join(temporary, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
      await rm(target, { recursive: true, force: true });
      await rename(temporary, target);
      const cached = this.cached(target, manifest);
      await this.evict();
      return cached;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private cached(dir: string, manifest: BaselineManifest): CachedBaseline {
    return {
      dir,
      manifestPath: join(dir, MANIFEST),
      identity: manifest.identity,
      byteSize: manifest.artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0),
      manifest
    };
  }

  async get(identity: string): Promise<CachedBaseline | undefined> {
    const dir = this.dir(identity);
    if (!existsSync(dir)) return undefined;
    let manifest: BaselineManifest | undefined;
    try {
      manifest = parseManifest(JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')));
      if (!manifest || manifest.identity !== identity) throw new CacheFailure(BaselineCacheError.INVALID_MANIFEST);
      for (const artifact of manifest.artifacts) {
        const path = join(dir, artifact.name);
        const info = await stat(path);
        if (!info.isFile() || info.size !== artifact.byteSize || (await sha256OfFile(path)) !== artifact.digest) {
          throw new CacheFailure(BaselineCacheError.INVALID_ARTIFACT);
        }
      }
      return this.cached(dir, manifest);
    } catch {
      if (!this.restoreLeases.has(identity) && !existsSync(this.restoreLock(identity))) {
        await rm(dir, { recursive: true, force: true });
      }
      return undefined;
    }
  }

  async acquireRestoreLease(identity: string): Promise<BaselineRestoreLease | undefined> {
    if (this.restoreLeases.has(identity)) throw new CacheFailure(BaselineCacheError.LEASED);
    await this.ensureRoot();
    const lock = this.restoreLock(identity);
    const token = randomUUID();
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    } catch {
      if (existsSync(lock) && !existsSync(join(lock, 'owner.json'))) await rm(lock, { recursive: true, force: true });
      throw new CacheFailure(BaselineCacheError.LEASED);
    }
    const artifact = await this.get(identity);
    if (!artifact) {
      await rm(lock, { recursive: true, force: true });
      await rm(this.dir(identity), { recursive: true, force: true });
      return undefined;
    }
    this.restoreLeases.set(identity, 1);
    let released = false;
    return {
      artifact,
      release: async () => {
        if (released) return;
        released = true;
        this.restoreLeases.delete(identity);
        try {
          const owner = ownerTokenSchema.parse(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')));
          if (owner.token === token) await rm(lock, { recursive: true, force: true });
        } catch {
          // A missing or replaced lease is not ours to remove.
        }
      }
    };
  }

  async invalidate(identity: string): Promise<void> {
    if (this.restoreLeases.has(identity) || existsSync(this.restoreLock(identity))) return;
    await rm(this.dir(identity), { recursive: true, force: true });
  }

  async cleanupTemporary(): Promise<void> {
    await this.ensureRoot();
    for (const entry of await readdir(this.root)) {
      const path = join(this.root, entry);
      if (entry.startsWith('.tmp-')) {
        if (await staleOwnedPath(path, OWNER)) await rm(path, { recursive: true, force: true });
      } else if (entry.startsWith('.capture-') || entry.startsWith('.restore-')) {
        if (await staleOwnedPath(path, 'owner.json')) await rm(path, { recursive: true, force: true });
      }
    }
  }

  private async evict(): Promise<void> {
    const candidates: CachedBaseline[] = [];
    for (const entry of await readdir(this.root)) {
      if (entry.startsWith('.') || existsSync(join(this.root, `.restore-${entry}.lock`))) continue;
      const dir = join(this.root, entry);
      try {
        const manifest = parseManifest(JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')));
        if (manifest && !this.restoreLeases.has(manifest.identity)) candidates.push(this.cached(dir, manifest));
      } catch {
        await rm(dir, { recursive: true, force: true });
      }
    }
    candidates.sort((a, b) => a.manifest.createdAt - b.manifest.createdAt);
    let bytes = candidates.reduce((sum, artifact) => sum + artifact.byteSize, 0);
    while (candidates.length > this.limits.maxInactiveArtifacts || bytes > this.limits.maxBytes) {
      const victim = candidates.shift();
      if (!victim) break;
      await rm(victim.dir, { recursive: true, force: true });
      bytes -= victim.byteSize;
    }
  }

  private restoreLock(identity: string): string {
    return join(this.root, `.restore-${safeIdentity(identity)}.lock`);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function staleOwnedPath(path: string, ownerName: string): Promise<boolean> {
  try {
    const owner = ownerPidSchema.parse(JSON.parse(await readFile(join(path, ownerName), 'utf8')));
    return typeof owner.pid !== 'number' || !pidAlive(owner.pid);
  } catch {
    try {
      return Date.now() - (await stat(path)).mtimeMs > 30_000;
    } catch {
      return false;
    }
  }
}
