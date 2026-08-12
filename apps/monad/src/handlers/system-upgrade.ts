import type { SystemUpgradeAttempt, SystemUpgradeStatus } from '@monad/protocol';

import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MONAD_VERSION, systemUpgradeAttemptSchema } from '@monad/protocol';
import {
  isUpgradeAvailable,
  type ResolvedRelease,
  releaseChannelOfVersion,
  resolveRelease,
  shouldInstallRelease
} from '@monad/utils/release-update';
import {
  type PreparedUpgrade,
  prepareUpgradeAssets,
  upgradeWorkerCommand,
  upgradeWorkerLauncherCommand
} from '@monad/utils/release-upgrade';

declare const BUILD_DIST_TARGET: string | undefined;

export interface SystemUpgradeOptions {
  arch?: NodeJS.Architecture;
  binaryPath?: string;
  cacheDir?: string;
  distTarget?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  getUpgradeInfo?: () => { latestVersion: string; latestVersionCheckedAt: string } | null;
  parentPid?: number;
  platform?: NodeJS.Platform;
  scheduleExit?: () => void;
  spawn?: typeof Bun.spawn;
  now?: () => Date;
}

function upgradeAttemptPaths(cacheDir: string): { attempt: string; log: string; result: string } {
  return {
    attempt: join(cacheDir, 'attempt.json'),
    log: join(cacheDir, 'updater.log'),
    result: join(cacheDir, 'result.txt')
  };
}

const STAGES: Record<SystemUpgradeStatus['stage'], number> = {
  idle: 0,
  checking: 5,
  downloading: 25,
  verifying: 70,
  ready: 100,
  installing: 92,
  restarting: 98,
  complete: 100,
  failed: 100
};

export function createSystemUpgradeModule(options: SystemUpgradeOptions = {}) {
  const binaryPath = options.binaryPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const distTarget = options.distTarget ?? currentDistTarget(platform, options.arch ?? process.arch);
  const fetchImpl = options.fetch ?? fetch;
  const spawn = options.spawn ?? Bun.spawn;
  const parentPid = options.parentPid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const channel = releaseChannelOfVersion(MONAD_VERSION);
  const attemptPaths = options.cacheDir ? upgradeAttemptPaths(options.cacheDir) : null;
  const lastAttempt = attemptPaths ? readUpgradeAttempt(attemptPaths.attempt, attemptPaths.result) : null;
  const scheduleExit =
    options.scheduleExit ??
    (() => {
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
    });
  let status = buildIdleStatus(options.getUpgradeInfo, channel, lastAttempt);
  let selectedRelease: ResolvedRelease | null = null;
  let prepared: PreparedUpgrade | null = null;
  let checking: Promise<void> | null = null;
  let preparing: Promise<void> | null = null;
  let installing = false;

  function current(): SystemUpgradeStatus {
    if (options.cacheDir && (status.stage === 'idle' || status.stage === 'complete')) void check();
    return status;
  }

  async function start(): Promise<SystemUpgradeStatus> {
    if (installing) return status;
    await check();
    if (!selectedRelease || !status.available) return status;
    if (!prepared) await prepare();
    if (!prepared || status.stage === 'failed' || installing) return status;

    installing = true;
    const startedAt = now().toISOString();
    const attempt: SystemUpgradeAttempt | null = attemptPaths
      ? {
          targetVersion: selectedRelease.version,
          tag: selectedRelease.tag,
          startedAt,
          completedAt: null,
          exitCode: null,
          logPath: attemptPaths.log,
          state: 'installing'
        }
      : null;
    if (attemptPaths && attempt) {
      await mkdir(options.cacheDir as string, { recursive: true });
      await rm(attemptPaths.result, { force: true });
      await Bun.write(attemptPaths.attempt, `${JSON.stringify(attempt, null, 2)}\n`);
      await Bun.write(attemptPaths.log, '');
    }
    status = { ...status, stage: 'installing', progress: STAGES.installing, error: null, lastAttempt: attempt };
    try {
      const proc = spawn(
        workerLauncherCommand(
          platform,
          parentPid,
          prepared.installerPath,
          prepared.downloadDirectory,
          binaryPath,
          attemptPaths?.result,
          attemptPaths?.log
        ),
        {
          env: { ...process.env, ...options.env, MONAD_NO_OPEN: '1' },
          stderr: 'ignore',
          stdin: 'ignore',
          stdout: 'ignore'
        }
      );
      const launcherExitCode = await proc.exited;
      if (launcherExitCode !== 0) throw new Error(`upgrade worker launcher exited with code ${launcherExitCode}`);
      status = { ...status, stage: 'restarting', progress: STAGES.restarting, error: null };
      scheduleExit();
    } catch (error) {
      installing = false;
      fail(error instanceof Error ? error.message : String(error));
    }
    return status;
  }

  async function check(): Promise<void> {
    if (checking) return checking;
    if (installing || status.stage === 'restarting' || (selectedRelease && status.stage === 'ready')) return;
    checking = runCheck().finally(() => {
      checking = null;
    });
    return checking;
  }

  async function runCheck(): Promise<void> {
    prepared = null;
    selectedRelease = null;
    status = {
      available: false,
      currentVersion: MONAD_VERSION,
      latestVersion: null,
      stage: 'checking',
      progress: STAGES.checking,
      downloadedBytes: null,
      totalBytes: null,
      bytesPerSecond: null,
      error: null,
      lastAttempt: status.lastAttempt
    };
    try {
      const release = await resolveRelease(channel, {
        apiBaseUrl: options.env?.MONAD_RELEASE_API_BASE_URL ?? Bun.env.MONAD_RELEASE_API_BASE_URL,
        downloadBaseUrl: options.env?.MONAD_RELEASE_DOWNLOAD_BASE_URL ?? Bun.env.MONAD_RELEASE_DOWNLOAD_BASE_URL,
        fetch: fetchImpl,
        userAgent: `monad-daemon/${MONAD_VERSION}`
      });
      if (!release) throw new Error(`no ${channel} release found`);
      const available = shouldInstallRelease(MONAD_VERSION, release.version, channel, false);
      status = { ...status, available, latestVersion: release.version };
      if (!available) {
        status = { ...status, stage: 'complete', progress: STAGES.complete };
        return;
      }
      selectedRelease = release;
      status = { ...status, stage: 'ready', progress: 0, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(message);
    }
  }

  async function prepare(): Promise<void> {
    if (preparing) return preparing;
    preparing = runPrepare().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function runPrepare(): Promise<void> {
    try {
      if (!selectedRelease) throw new Error('system upgrade release is unavailable');
      if (!options.cacheDir) throw new Error('system upgrade cache directory is unavailable');
      const release = selectedRelease;
      status = { ...status, stage: 'downloading', progress: STAGES.downloading, error: null };
      prepared = await prepareUpgradeAssets({
        directory: join(
          options.cacheDir,
          'staged',
          new Bun.CryptoHasher('sha256').update(release.tag).digest('hex').slice(0, 24)
        ),
        distTarget,
        fetch: fetchImpl,
        platform,
        release,
        onProgress: ({ downloadedBytes, totalBytes, bytesPerSecond }) => {
          status = {
            ...status,
            stage: 'downloading',
            progress: totalBytes === 0 ? STAGES.downloading : 10 + (downloadedBytes / totalBytes) * 75,
            downloadedBytes,
            totalBytes,
            bytesPerSecond
          };
        }
      });
      status = { ...status, stage: 'verifying', progress: 90, bytesPerSecond: 0 };
      status = { ...status, stage: 'ready', progress: STAGES.ready, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(message);
    }
  }

  function fail(error: string): void {
    status = { ...status, stage: 'failed', progress: STAGES.failed, bytesPerSecond: 0, error };
  }

  return { getStatus: current, start };
}

export function workerCommand(
  platform: NodeJS.Platform,
  parentPid: number,
  installerPath: string,
  downloadDirectory: string,
  binaryPath: string,
  resultPath?: string,
  logPath?: string
): string[] {
  return upgradeWorkerCommand({
    binaryPath,
    downloadDirectory,
    installerPath,
    logPath,
    parentPid,
    platform,
    restart: true,
    resultPath
  });
}

export function workerLauncherCommand(
  platform: NodeJS.Platform,
  parentPid: number,
  installerPath: string,
  downloadDirectory: string,
  binaryPath: string,
  resultPath?: string,
  logPath?: string
): string[] {
  return upgradeWorkerLauncherCommand({
    binaryPath,
    downloadDirectory,
    installerPath,
    logPath,
    parentPid,
    platform,
    restart: true,
    resultPath
  });
}

function buildIdleStatus(
  getUpgradeInfo: SystemUpgradeOptions['getUpgradeInfo'],
  channel: ReturnType<typeof releaseChannelOfVersion>,
  lastAttempt: SystemUpgradeAttempt | null
): SystemUpgradeStatus {
  const latestVersion = channel === 'stable' ? (getUpgradeInfo?.()?.latestVersion ?? null) : null;
  const failedAttempt = lastAttempt?.state === 'failed' ? lastAttempt : null;
  const interruptedAttempt = lastAttempt?.state === 'installing' ? lastAttempt : null;
  return {
    available: Boolean(latestVersion && isUpgradeAvailable(MONAD_VERSION, latestVersion)),
    currentVersion: MONAD_VERSION,
    latestVersion,
    stage: failedAttempt || interruptedAttempt ? 'failed' : lastAttempt?.state === 'complete' ? 'complete' : 'idle',
    progress: failedAttempt || interruptedAttempt || lastAttempt?.state === 'complete' ? 100 : STAGES.idle,
    downloadedBytes: null,
    totalBytes: null,
    bytesPerSecond: null,
    error: failedAttempt
      ? `Update to ${failedAttempt.targetVersion} failed with exit code ${failedAttempt.exitCode}; see ${failedAttempt.logPath}`
      : interruptedAttempt
        ? `Update to ${interruptedAttempt.targetVersion} did not record completion; see ${interruptedAttempt.logPath}`
        : null,
    lastAttempt
  };
}

function readUpgradeAttempt(attemptPath: string, resultPath: string): SystemUpgradeAttempt | null {
  try {
    const attempt = systemUpgradeAttemptSchema.parse(JSON.parse(readFileSync(attemptPath, 'utf8')));
    try {
      const [rawCode, completedAt] = readFileSync(resultPath, 'utf8').trim().split('\n');
      const exitCode = Number(rawCode);
      if (!Number.isInteger(exitCode) || !completedAt) return attempt;
      return {
        ...attempt,
        completedAt,
        exitCode,
        state: exitCode === 0 ? 'complete' : 'failed'
      };
    } catch {
      return attempt;
    }
  } catch {
    return null;
  }
}

function currentDistTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  if (typeof BUILD_DIST_TARGET === 'string') return BUILD_DIST_TARGET;
  const targetArch = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  if (!targetArch) throw new Error(`unsupported release architecture: ${arch}`);
  if (platform === 'darwin') return `${targetArch}-apple-darwin`;
  if (platform === 'linux') return `${targetArch}-unknown-linux-gnu`;
  if (platform === 'win32') return `${targetArch}-pc-windows-msvc`;
  throw new Error(`unsupported release platform: ${platform}`);
}
