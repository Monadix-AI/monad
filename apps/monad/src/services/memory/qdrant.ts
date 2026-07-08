// Daemon-managed local qdrant for PERSISTENT mem0 memory. The qdrant binary is downloaded on demand
// (NOT bundled in the install — same model as `bun add mem0ai`) the first time mem0 needs it, launched
// as a loopback-bound child process with an on-disk storage dir, health-checked, and killed on daemon
// exit. mem0's `qdrant` vector-store provider then points at it, so memories survive restarts.
//
// Trust model: downloaded from qdrant's official GitHub release over HTTPS, verified against the
// release's SHA256SUMS when published (same anchor as npm's registry hashes). Everything external is
// injected (fetch / spawn / probe) so the orchestration is testable offline; the real binary
// download + launch flags + health endpoint must be confirmed by a live run (see qdrant docs).

import type { Logger } from '@monad/logger';

import { existsSync } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { untar } from '#/atoms/install/untar.ts';
import { createReleaseAssetFetcher, type ReleaseAssetFetcher } from '#/capabilities/mcp/install/binary.ts';
import { unzip } from '#/capabilities/mcp/install/unzip.ts';
import { daemonChildProcesses, killDaemonProcessTree } from '#/infra/daemon-child-processes.ts';

const REPO = { owner: 'qdrant', repo: 'qdrant' };
// Pinned default; overridable via memory.mem0.qdrant.version. Bump deliberately (the release's
// SHA256SUMS is what's verified, so a bad pin can't silently run tampered bytes).
const DEFAULT_VERSION = 'v1.12.5';
const ARCHIVE_RE = /\.(tar\.gz|tgz)$/i;
const ZIP_RE = /\.zip$/i;

/** A running child process the manager supervises. Abstracted so tests inject a fake. */
export interface QdrantProcess {
  kill(): void;
  readonly exited: Promise<unknown>;
}
type QdrantSpawn = (binPath: string, args: string[], env: Record<string, string>, cwd: string) => QdrantProcess;
/** Health probe: resolve true once qdrant answers on its REST port. */
type QdrantProbe = (url: string) => Promise<boolean>;

export interface QdrantManagerDeps {
  /** Where the downloaded binary is cached (paths.cache/qdrant). Re-downloaded if missing. */
  binDir: string;
  /** Persistent storage dir (paths.memory/qdrant). */
  dataDir: string;
  /** Loopback REST port. gRPC binds port+1. */
  port: number;
  version?: string;
  /** Test seams (default to the real implementations). */
  fetch?: ReleaseAssetFetcher;
  spawn?: QdrantSpawn;
  probe?: QdrantProbe;
  /** Total health-wait budget; the probe is polled until ready or this elapses. */
  startTimeoutMs?: number;
  /** Supervised restarts after an unexpected exit before giving up (default 5). */
  maxRestarts?: number;
  /** Base backoff between restart attempts; doubles per attempt (default 500ms). */
  restartBaseMs?: number;
  log: Logger;
}

const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_BASE_MS = 500;

function binName(): string {
  return process.platform === 'win32' ? 'qdrant.exe' : 'qdrant';
}

function asArrayBuffer(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return (u.buffer instanceof ArrayBuffer ? u : new Uint8Array(u)) as Uint8Array<ArrayBuffer>;
}

const realSpawn: QdrantSpawn = (binPath, args, env, cwd) => {
  const proc = Bun.spawn([binPath, ...args], {
    cwd, // qdrant writes ./.qdrant-initialized + ./snapshots relative to cwd — keep them in dataDir, not the daemon's cwd
    env: { ...Bun.env, ...env },
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe'
  });
  daemonChildProcesses.track(proc.pid, 'qdrant', () => killDaemonProcessTree(proc.pid));
  void proc.exited.then(() => daemonChildProcesses.untrack(proc.pid));
  return {
    kill: () => {
      killDaemonProcessTree(proc.pid);
      daemonChildProcesses.untrack(proc.pid);
    },
    exited: proc.exited
  };
};

const realProbe: QdrantProbe = async (url) => {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
};

export type QdrantPhase = 'idle' | 'downloading' | 'launching' | 'ready' | 'failed';

export interface QdrantStatus {
  phase: QdrantPhase;
  error: string | null;
}

/**
 * Lifecycle for a single local qdrant. `ensureUrl()` is idempotent: downloads the binary if absent,
 * starts the process if not running, waits for health, and returns the REST URL. `stop()` kills it.
 */
export class QdrantManager {
  private proc: QdrantProcess | null = null;
  private starting: Promise<string> | null = null;
  private stopped = false;
  private restarts = 0;
  private supervising = false;
  private readonly url: string;
  private _status: QdrantStatus = { phase: 'idle', error: null };

  constructor(private readonly deps: QdrantManagerDeps) {
    this.url = `http://127.0.0.1:${deps.port}`;
  }

  getStatus(): QdrantStatus {
    return { ...this._status };
  }

  /** The REST URL iff qdrant is already running (never launches it) — for read-only callers like the
   *  mem0 explorer that must not trigger a download/boot just to peek at vectors. */
  urlIfReady(): string | null {
    return this._status.phase === 'ready' ? this.url : null;
  }

  private setPhase(phase: QdrantPhase, error: string | null = null): void {
    this._status = { phase, error };
  }

  /** Idempotent: ensure qdrant is downloaded + running + healthy, return its REST URL. The URL is
   *  stable, so once this resolves a later crash is recovered in the background (supervised restart
   *  on the same port) — mem0's cached client keeps working without a rebuild. */
  ensureUrl(): Promise<string> {
    this.starting ??= this.boot().catch((err) => {
      this.starting = null; // first boot failed — allow a later retry
      this.setPhase('failed', String(err));
      throw err;
    });
    return this.starting;
  }

  private async boot(): Promise<string> {
    this.setPhase('downloading');
    const bin = await this.ensureBinary();
    this.setPhase('launching');
    await this.launch(bin, true);
    this.setPhase('ready');
    return this.url;
  }

  private buildEnv(): Record<string, string> {
    return {
      QDRANT__SERVICE__HOST: '127.0.0.1', // loopback only — never expose the vector store
      QDRANT__SERVICE__HTTP_PORT: String(this.deps.port),
      QDRANT__SERVICE__GRPC_PORT: String(this.deps.port + 1),
      QDRANT__STORAGE__STORAGE_PATH: this.deps.dataDir,
      QDRANT__STORAGE__SNAPSHOTS_PATH: join(this.deps.dataDir, 'snapshots'),
      QDRANT__TELEMETRY_DISABLED: 'true'
    };
  }

  /** Spawn one qdrant process and wait until it's healthy. Throws if it dies during startup or never
   *  answers. Supervision (auto-restart on later crash) is attached only after it's confirmed healthy. */
  private async launch(bin: string, initial: boolean): Promise<void> {
    await mkdir(this.deps.dataDir, { recursive: true });
    const proc = (this.deps.spawn ?? realSpawn)(bin, [], this.buildEnv(), this.deps.dataDir);
    this.proc = proc;
    let exitedEarly = false;
    void proc.exited.then(() => {
      exitedEarly = true;
    });
    try {
      await this.waitHealthy(() => exitedEarly);
    } catch (err) {
      if (this.proc === proc) {
        proc.kill();
        this.proc = null;
      }
      // Died during startup on the very first boot → the cached binary is likely bad/incompatible.
      // Drop it so the next attempt re-downloads instead of looping forever on the same broken bytes.
      if (initial && exitedEarly) await this.discardBinary(bin);
      throw err;
    }
    this.restarts = 0; // a healthy run replenishes the restart budget
    void proc.exited.then(() => this.onExit(proc, bin));
    this.deps.log.info(`memory: local qdrant ready at ${this.url} (data: ${this.deps.dataDir})`);
  }

  private onExit(proc: QdrantProcess, bin: string): void {
    if (this.proc !== proc) return; // superseded by a newer launch/stop
    this.proc = null;
    if (this.stopped) return; // intentional shutdown
    void this.supervise(bin);
  }

  /** Bounded, backing-off restart loop after an unexpected exit. Caps at maxRestarts so a binary that
   *  can never stay up doesn't spin forever — after that mem0 calls fail until the daemon restarts. */
  private async supervise(bin: string): Promise<void> {
    if (this.supervising) return;
    this.supervising = true;
    try {
      const max = this.deps.maxRestarts ?? DEFAULT_MAX_RESTARTS;
      const base = this.deps.restartBaseMs ?? DEFAULT_RESTART_BASE_MS;
      while (!this.stopped && !this.proc) {
        if (this.restarts >= max) {
          this.deps.log.error(
            `memory: local qdrant exited and exceeded ${max} restarts — mem0 calls will fail until daemon restart`
          );
          this.starting = null; // allow a future ensureUrl() to re-attempt boot from scratch
          return;
        }
        const attempt = ++this.restarts;
        const delay = base * 2 ** (attempt - 1);
        this.deps.log.warn(
          `memory: local qdrant exited unexpectedly — restarting (attempt ${attempt}/${max}) in ${delay}ms`
        );
        await Bun.sleep(delay);
        if (this.stopped) return;
        try {
          await this.launch(bin, false);
          return; // back up; launch() re-armed onExit for the next crash and reset the counter
        } catch (err) {
          this.deps.log.warn(`memory: local qdrant restart attempt ${attempt} failed: ${String(err)}`);
        }
      }
    } finally {
      this.supervising = false;
    }
  }

  private async discardBinary(bin: string): Promise<void> {
    try {
      await rm(bin, { force: true });
      this.deps.log.warn(`memory: removed unhealthy qdrant binary ${bin} — it will be re-downloaded next time`);
    } catch {
      // best-effort; a stale binary just means the next boot retries it
    }
  }

  private async waitHealthy(hasExited: () => boolean): Promise<void> {
    const probe = this.deps.probe ?? realProbe;
    const deadline = Date.now() + (this.deps.startTimeoutMs ?? 30_000);
    for (;;) {
      if (hasExited()) throw new Error(`qdrant process exited during startup at ${this.url}`);
      if (await probe(this.url)) return;
      if (Date.now() > deadline) throw new Error(`qdrant did not become healthy at ${this.url} in time`);
      await Bun.sleep(250);
    }
  }

  /** Resolve the cached binary, downloading + extracting the platform asset if absent. */
  private async ensureBinary(): Promise<string> {
    const binPath = join(this.deps.binDir, binName());
    if (existsSync(binPath)) return binPath;

    const version = this.deps.version ?? DEFAULT_VERSION;
    const fetcher = this.deps.fetch ?? createReleaseAssetFetcher();
    this.deps.log.info(`memory: downloading qdrant ${version} (first mem0 persistence use)…`);
    const asset = await fetcher({ ...REPO, tag: version }, process.platform, process.arch);

    // Verify against the release's published checksums when available (HTTPS + official repo is the
    // base trust anchor; the hash adds tamper-detection — same as npm registry integrity).
    const expected = asset.checksums?.get(asset.name)?.toLowerCase();
    if (expected) {
      const got = new Bun.CryptoHasher('sha256').update(asset.bytes).digest('hex');
      if (got !== expected) throw new Error(`qdrant SHA-256 mismatch for ${asset.name}: ${got} ≠ ${expected}`);
    } else {
      this.deps.log.warn(`memory: qdrant release ${version} published no checksums — proceeding on HTTPS trust`);
    }

    const bytes = extractBinary(asset.name, asset.bytes);
    await mkdir(this.deps.binDir, { recursive: true });
    await Bun.write(binPath, bytes);
    if (process.platform !== 'win32') await chmod(binPath, 0o755);
    return binPath;
  }

  async stop(): Promise<void> {
    this.stopped = true; // signal supervise() to give up; onExit() ignores the resulting exit
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    p.kill();
    await p.exited.catch(() => {});
  }
}

/** Pull the `qdrant` executable out of a release archive (or treat a bare asset as the binary). */
function extractBinary(assetName: string, bytes: Uint8Array): Uint8Array {
  const want = binName();
  let entries: [string, Uint8Array][] | null = null;
  if (ZIP_RE.test(assetName)) entries = [...unzip(bytes)].filter(([p]) => !p.endsWith('/'));
  else if (ARCHIVE_RE.test(assetName))
    entries = [...untar(Bun.gunzipSync(asArrayBuffer(bytes)))].filter(([p]) => !p.endsWith('/'));
  if (!entries) return bytes; // raw binary asset
  const hit = entries.find(([p]) => p.split('/').pop() === want) ?? (entries.length === 1 ? entries[0] : undefined);
  if (!hit)
    throw new Error(
      `cannot find ${want} in qdrant asset ${assetName} (entries: ${entries.map(([p]) => p).join(', ')})`
    );
  return hit[1];
} // re-export for the manager's tests
