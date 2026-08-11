import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { LogAutoCleanup } from '@monad/environment';
import type { LogCleanupPreview, LogCleanupResult } from '@monad/protocol';

import { constants, renameSync, statSync } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { debugLogDir, debugLogPath, isDebugLogFileName, isDeveloperLogFileName } from '@monad/logger/log-files';

import { isMeshFixtureCaptureFileName, isMeshFixtureCaptureTempFileName } from '#/services/mesh-agent/fixture-tap.ts';

export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DAEMON_LOG_KEEP = 5;
export const STALE_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const PREVIEW_WINDOW_MS = 2_000;

export type { LogCleanupPreview, LogCleanupResult } from '@monad/protocol';

export interface LogMaintenanceFileSystem {
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<Pick<FileHandle, 'close' | 'stat' | 'truncate'>>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
}

export interface LogMaintenanceServiceOptions {
  logsDir: string;
  captureDir: string;
  liveEventDir?: string;
  debugDir?: string;
  debugPath?: string;
  noFollowFlag?: number;
  now?: () => number;
  fileSystem?: Partial<LogMaintenanceFileSystem>;
}

export class LogCleanupPreviewBusyError extends Error {
  readonly retryAfterSeconds = PREVIEW_WINDOW_MS / 1_000;

  constructor() {
    super('Log cleanup preview is temporarily unavailable');
    this.name = 'LogCleanupPreviewBusyError';
  }
}

type CandidateKind = 'fixed' | 'rotation' | 'debug' | 'developer' | 'capture' | 'live-event';
type Candidate = {
  kind: CandidateKind;
  path: string;
  parent: string;
  root: string;
  parentStat: Stats;
  rootStat: Stats;
  stat?: Stats;
};
type Inventory = { candidates: Candidate[]; errors: unknown[] };
type Mutation = 'truncate' | 'unlink';

const defaultFileSystem: LogMaintenanceFileSystem = { lstat, open, readdir, unlink };

export function rotateLogFile(path: string, opts: { maxBytes: number; keep: number }): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size < opts.maxBytes) return false;
  try {
    for (let i = opts.keep - 1; i >= 1; i--) {
      try {
        renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      } catch {}
    }
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

export function rotateDaemonLog(logPath: string): boolean {
  return rotateLogFile(logPath, { maxBytes: DAEMON_LOG_MAX_BYTES, keep: DAEMON_LOG_KEEP });
}

export class LogMaintenanceService {
  private readonly fileSystem: LogMaintenanceFileSystem;
  private readonly logsDir: string;
  private readonly captureDir: string;
  private readonly liveEventDir: string;
  private readonly debugDir: string;
  private readonly debugPath: string;
  private readonly noFollowFlag: number;
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();
  private activeMutation?: AbortController;
  private stopped = false;
  private previewActive = false;
  private previewLastStartedAt?: number;
  private previewCache?: { key: string; completedAt: number; result: LogCleanupPreview };

  constructor(options: LogMaintenanceServiceOptions) {
    this.logsDir = resolve(options.logsDir);
    this.captureDir = resolve(options.captureDir);
    this.liveEventDir = resolve(options.liveEventDir ?? join(options.logsDir, 'live-events'));
    this.debugDir = resolve(options.debugDir ?? debugLogDir);
    this.debugPath = resolve(options.debugPath ?? debugLogPath);
    this.noFollowFlag =
      options.noFollowFlag === undefined
        ? process.platform === 'win32'
          ? 0
          : constants.O_NOFOLLOW
        : options.noFollowFlag;
    this.now = options.now ?? Date.now;
    this.fileSystem = { ...defaultFileSystem, ...options.fileSystem };
  }

  clearAll(): Promise<LogCleanupResult> {
    return this.enqueueMutation((signal) => this.mutate('clear', undefined, signal));
  }

  sweep(policy: LogAutoCleanup): Promise<LogCleanupResult> {
    if (this.stopped) return Promise.reject(new Error('Log maintenance service has stopped'));
    if (!policy.enabled) return Promise.resolve(emptyResult());
    return this.enqueueMutation((signal) => this.mutate('sweep', policy, signal));
  }

  async preview(policy: LogAutoCleanup): Promise<LogCleanupPreview> {
    this.assertRunning();
    if (!policy.enabled) return { files: 0, bytes: 0 };
    const key = `${policy.enabled}:${policy.retentionDays}`;
    const now = this.now();
    if (this.previewCache?.key === key && now - this.previewCache.completedAt <= PREVIEW_WINDOW_MS) {
      return this.previewCache.result;
    }
    if (
      this.previewActive ||
      (this.previewLastStartedAt !== undefined && now - this.previewLastStartedAt < PREVIEW_WINDOW_MS)
    ) {
      throw new LogCleanupPreviewBusyError();
    }
    this.previewActive = true;
    this.previewLastStartedAt = now;
    try {
      const inventory = await this.inventory();
      if (inventory.errors.length > 0) throw new AggregateError(inventory.errors, 'Log inventory failed');
      const cutoff = now - policy.retentionDays * DAY_MS;
      const result = inventory.candidates.reduce<LogCleanupPreview>(
        (total, candidate) => {
          if (candidate.stat?.isFile() && candidate.kind !== 'rotation' && candidate.stat.mtimeMs < cutoff) {
            total.files += 1;
            total.bytes += candidate.stat.size;
          }
          return total;
        },
        { files: 0, bytes: 0 }
      );
      this.previewCache = { key, completedAt: this.now(), result };
      return result;
    } finally {
      this.previewActive = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.activeMutation?.abort();
  }

  private enqueueMutation(work: (signal: AbortSignal) => Promise<LogCleanupResult>): Promise<LogCleanupResult> {
    if (this.stopped) return Promise.reject(new Error('Log maintenance service has stopped'));
    const run = async () => {
      this.assertRunning();
      const controller = new AbortController();
      this.activeMutation = controller;
      try {
        return await work(controller.signal);
      } finally {
        if (this.activeMutation === controller) this.activeMutation = undefined;
      }
    };
    const result = this.mutationTail.then(run, run);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async mutate(
    mode: 'clear' | 'sweep',
    policy: LogAutoCleanup | undefined,
    signal: AbortSignal
  ): Promise<LogCleanupResult> {
    const inventory = await this.inventory();
    const result = emptyResult();
    result.filesFailed = inventory.errors.length;
    const now = this.now();
    const cutoff = policy ? now - policy.retentionDays * DAY_MS : undefined;
    for (const candidate of inventory.candidates) {
      if (signal.aborted) break;
      if (mode === 'sweep' && candidate.kind === 'rotation') continue;
      if (!candidate.stat?.isFile()) {
        result.filesFailed += 1;
        continue;
      }
      try {
        const current = await this.revalidate(candidate);
        const operation = this.operationFor(candidate, current, mode, now, cutoff);
        if (!operation) continue;
        if (operation === 'truncate') await this.truncate(candidate.path, current);
        else {
          // Node/Bun has no unlinkat. This single pathname call follows immediate root, parent, and
          // entry checks; a same-user parent swap in this final gap is the bounded residual risk.
          await this.fileSystem.unlink(candidate.path);
        }
        if (signal.aborted) break;
        result.filesCleared += 1;
        result.bytesFreed += current.size;
      } catch {
        if (signal.aborted) break;
        result.filesFailed += 1;
      }
    }
    return result;
  }

  private async revalidate(candidate: Candidate): Promise<Stats> {
    const parent = resolve(dirname(candidate.path));
    const rel = relative(candidate.root, candidate.path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || parent !== candidate.parent) {
      throw new Error('Log candidate escaped its inventory root');
    }
    const root = await this.fileSystem.lstat(candidate.root);
    if (!isSameDirectory(root, candidate.rootStat)) throw new Error('Log inventory root changed');
    const parentStat = await this.fileSystem.lstat(parent);
    if (!isSameDirectory(parentStat, candidate.parentStat)) throw new Error('Log candidate parent changed');
    const entry = await this.fileSystem.lstat(candidate.path);
    if (!entry.isFile() || entry.isSymbolicLink() || !sameIdentity(entry, candidate.stat)) {
      throw new Error('Log candidate changed');
    }
    return entry;
  }

  private async truncate(path: string, expected: Stats): Promise<void> {
    if (!this.noFollowFlag) throw new Error('O_NOFOLLOW is unavailable');
    const handle = await this.fileSystem.open(path, constants.O_WRONLY | this.noFollowFlag);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameIdentity(opened, expected)) throw new Error('Opened log candidate changed');
      await handle.truncate(0);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private operationFor(
    candidate: Candidate,
    current: Stats,
    mode: 'clear' | 'sweep',
    now: number,
    cutoff: number | undefined
  ): Mutation | undefined {
    if (mode === 'sweep') {
      if (candidate.kind === 'rotation' || cutoff === undefined || current.mtimeMs >= cutoff) return undefined;
      return candidate.kind === 'fixed' || candidate.path === this.debugPath ? 'truncate' : 'unlink';
    }
    if (candidate.kind === 'fixed') return 'truncate';
    if (candidate.kind !== 'debug') return 'unlink';
    return candidate.path === this.debugPath || now - current.mtimeMs <= DAY_MS ? 'truncate' : 'unlink';
  }

  private async inventory(): Promise<Inventory> {
    const candidates = new Map<
      string,
      { kind: CandidateKind; parent: string; root: string; parentStat: Stats; rootStat: Stats }
    >();
    const errors: unknown[] = [];
    const addDirectory = async (directory: string, classify: (name: string) => CandidateKind | undefined) => {
      let names: string[];
      let rootStat: Stats;
      try {
        rootStat = await this.fileSystem.lstat(directory);
      } catch (error) {
        if (!isMissingPathError(error)) errors.push(error);
        return;
      }
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
      try {
        names = await this.fileSystem.readdir(directory);
      } catch (error) {
        if (!isMissingPathError(error)) errors.push(error);
        return;
      }
      for (const name of names) {
        const kind = classify(name);
        if (kind) {
          candidates.set(resolve(directory, name), {
            kind,
            parent: directory,
            root: directory,
            parentStat: rootStat,
            rootStat
          });
        }
      }
    };
    const addLiveEventDirectory = async () => {
      let rootStat: Stats;
      try {
        rootStat = await this.fileSystem.lstat(this.liveEventDir);
      } catch (error) {
        if (!isMissingPathError(error)) errors.push(error);
        return;
      }
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
      const visit = async (directory: string, depth: number): Promise<void> => {
        let names: string[];
        let parentStat: Stats;
        try {
          parentStat = await this.fileSystem.lstat(directory);
          if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return;
          names = await this.fileSystem.readdir(directory);
        } catch (error) {
          if (!isMissingPathError(error)) errors.push(error);
          return;
        }
        await Promise.all(
          names.map(async (name) => {
            const path = resolve(directory, name);
            let stat: Stats;
            try {
              stat = await this.fileSystem.lstat(path);
            } catch (error) {
              if (!isMissingPathError(error)) errors.push(error);
              return;
            }
            if (stat.isSymbolicLink()) return;
            if (depth < 4 && stat.isDirectory()) return visit(path, depth + 1);
            if (depth === 4 && stat.isFile() && isLiveEventLogPath(this.liveEventDir, path)) {
              candidates.set(path, {
                kind: 'live-event',
                parent: directory,
                root: this.liveEventDir,
                parentStat,
                rootStat
              });
            }
          })
        );
      };
      await visit(this.liveEventDir, 0);
    };
    await Promise.all([
      addDirectory(this.logsDir, classifyPersistentLog),
      addDirectory(this.debugDir, (name) => (isDebugLogFileName(name) ? 'debug' : undefined)),
      addDirectory(this.captureDir, (name) =>
        isMeshFixtureCaptureFileName(name) || isMeshFixtureCaptureTempFileName(name) ? 'capture' : undefined
      ),
      addLiveEventDirectory()
    ]);
    const inspected = await Promise.all(
      [...candidates].map(async ([path, location]): Promise<Candidate | undefined> => {
        try {
          return { ...location, path, stat: await this.fileSystem.lstat(path) };
        } catch (error) {
          errors.push(error);
          return undefined;
        }
      })
    );
    return { candidates: inspected.filter((candidate) => candidate !== undefined), errors };
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error('Log maintenance service has stopped');
  }
}

function isSameDirectory(current: Stats, expected: Stats): boolean {
  return current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, expected);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function sameIdentity(current: Stats, expected: Stats | undefined): boolean {
  return expected !== undefined && current.dev === expected.dev && current.ino === expected.ino;
}

function classifyPersistentLog(name: string): CandidateKind | undefined {
  if (name === 'daemon.log' || name === 'startup.log') return 'fixed';
  if (isDaemonRotation(name)) return 'rotation';
  if (isDeveloperLogFileName(name)) return 'developer';
  return undefined;
}

function isDaemonRotation(name: string): boolean {
  const match = /^daemon\.log\.(\d+)$/.exec(name);
  if (!match?.[1]) return false;
  const generation = Number(match[1]);
  return String(generation) === match[1] && generation >= 1 && generation <= DAEMON_LOG_KEEP;
}

function isLiveEventLogPath(root: string, path: string): boolean {
  const parts = relative(root, path).split(/[\\/]/);
  if (parts.length !== 5) return false;
  const [projectId, sessionId, memberId, meshSessionId, fileName] = parts;
  return (
    /^prj_[0-9A-Za-z]{12}$/.test(projectId ?? '') &&
    /^ses_[0-9A-Za-z]{12}$/.test(sessionId ?? '') &&
    !!memberId &&
    memberId !== '.' &&
    memberId !== '..' &&
    /^mesh_[0-9A-Za-z]{12}$/.test(meshSessionId ?? '') &&
    /^oep_[0-9A-Za-z]{12}\.jsonl$/.test(fileName ?? '')
  );
}

function emptyResult(): LogCleanupResult {
  return { filesCleared: 0, filesFailed: 0, bytesFreed: 0 };
}

async function sweepMatchedDir(
  directory: string,
  match: (name: string) => boolean,
  maxAgeMs: number,
  now: number,
  fileSystem: Pick<LogMaintenanceFileSystem, 'lstat' | 'readdir' | 'unlink'>
): Promise<number> {
  let names: string[];
  let rootStat: Stats;
  try {
    rootStat = await fileSystem.lstat(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return 0;
    names = await fileSystem.readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!match(name)) continue;
    const path = join(directory, name);
    try {
      const info = await fileSystem.lstat(path);
      if (info.isFile()) {
        const currentRoot = await fileSystem.lstat(directory);
        if (!isSameDirectory(currentRoot, rootStat)) continue;
        const currentParent = await fileSystem.lstat(dirname(path));
        if (!isSameDirectory(currentParent, rootStat)) continue;
        const currentEntry = await fileSystem.lstat(path);
        if (!currentEntry.isFile() || currentEntry.isSymbolicLink() || !sameIdentity(currentEntry, info)) continue;
        if (now - currentEntry.mtimeMs <= maxAgeMs) continue;
        // This compatibility seam has the same documented unlinkat limitation as the service.
        await fileSystem.unlink(path);
        removed += 1;
      }
    } catch {}
  }
  return removed;
}

export async function sweepStaleLogs(options: {
  logsDir: string;
  tempDir?: string;
  maxAgeMs?: number;
  now?: number;
  fileSystem?: Partial<Pick<LogMaintenanceFileSystem, 'lstat' | 'readdir' | 'unlink'>>;
}): Promise<number> {
  const maxAgeMs = options.maxAgeMs ?? STALE_LOG_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const fileSystem = { lstat, readdir, unlink, ...options.fileSystem };
  const [debug, developer] = await Promise.all([
    sweepMatchedDir(options.tempDir ?? debugLogDir, isDebugLogFileName, maxAgeMs, now, fileSystem),
    sweepMatchedDir(options.logsDir, isDeveloperLogFileName, maxAgeMs, now, fileSystem)
  ]);
  return debug + developer;
}
