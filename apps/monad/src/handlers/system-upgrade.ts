import type { SystemUpgradeAttempt, SystemUpgradeStatus } from '@monad/protocol';

import { readFileSync } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MONAD_VERSION, systemUpgradeAttemptSchema } from '@monad/protocol';
import {
  isUpgradeAvailable,
  monadUpdaterPath,
  type ResolvedRelease,
  releaseChannelOfVersion,
  resolveRelease,
  shouldInstallRelease
} from '@monad/utils/release-update';

export interface SystemUpgradeOptions {
  access?: (path: string) => Promise<void>;
  binaryPath?: string;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  getUpgradeInfo?: () => { latestVersion: string; latestVersionCheckedAt: string } | null;
  parentPid?: number;
  platform?: NodeJS.Platform;
  scheduleExit?: () => void;
  spawn?: typeof Bun.spawn;
  updaterPath?: string;
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
  installing: 75,
  restarting: 90,
  complete: 100,
  failed: 100
};

export function createSystemUpgradeModule(options: SystemUpgradeOptions = {}) {
  const binaryPath = options.binaryPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const updaterPath = options.updaterPath ?? monadUpdaterPath(binaryPath, platform);
  const fetchImpl = options.fetch ?? fetch;
  const spawn = options.spawn ?? Bun.spawn;
  const checkAccess = options.access ?? access;
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
  let prepared: ResolvedRelease | null = null;
  let preparing: Promise<void> | null = null;
  let installing = false;

  function current(): SystemUpgradeStatus {
    if (options.cacheDir && (status.stage === 'idle' || status.stage === 'complete')) void prepare();
    return status;
  }

  async function start(): Promise<SystemUpgradeStatus> {
    if (installing) return status;
    if (!prepared) {
      void prepare();
      return status;
    }

    installing = true;
    const startedAt = now().toISOString();
    const attempt: SystemUpgradeAttempt | null = attemptPaths
      ? {
          targetVersion: prepared.version,
          tag: prepared.tag,
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
          updaterPath,
          prepared.tag,
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

  async function prepare(): Promise<void> {
    if (preparing) return preparing;
    if (installing || status.stage === 'ready' || status.stage === 'restarting') return;
    preparing = runPrepare().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function runPrepare(): Promise<void> {
    status = {
      available: false,
      currentVersion: MONAD_VERSION,
      latestVersion: null,
      stage: 'checking',
      progress: STAGES.checking,
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
      await checkAccess(updaterPath);
      prepared = release;
      status = { ...status, stage: 'ready', progress: STAGES.ready, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingUpdater = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
      fail(
        missingUpdater
          ? `monad-update is missing at ${updaterPath}; reinstall Monad with the current installer`
          : message
      );
    }
  }

  function fail(error: string): void {
    status = { ...status, stage: 'failed', progress: STAGES.failed, error };
  }

  return { getStatus: current, start };
}

export function workerCommand(
  platform: NodeJS.Platform,
  parentPid: number,
  updaterPath: string,
  tag: string,
  binaryPath: string,
  resultPath?: string,
  logPath?: string
): string[] {
  const result = resultPath ?? platformNullDevice(platform);
  const log = logPath ?? platformNullDevice(platform);
  if (platform === 'win32') {
    const script =
      'Wait-Process -Id ([int]$args[0]) -ErrorAction SilentlyContinue; ' +
      '& $args[1] --tag $args[2] *> $args[5]; $updateCode = $LASTEXITCODE; ' +
      '$completed = [DateTime]::UtcNow.ToString("o"); ' +
      'Set-Content -LiteralPath "$($args[4]).tmp" -Value @($updateCode, $completed); ' +
      'Move-Item -Force -LiteralPath "$($args[4]).tmp" -Destination $args[4]; ' +
      '& $args[3] restart *>> $args[5]; exit $updateCode';
    return [
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
      String(parentPid),
      updaterPath,
      tag,
      binaryPath,
      result,
      log
    ];
  }
  const script =
    'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; ' +
    '"$2" --tag "$3" >"$6" 2>&1; update_code=$?; completed=$(date -u +%Y-%m-%dT%H:%M:%SZ); ' +
    'printf "%s\\n%s\\n" "$update_code" "$completed" >"$5.tmp"; mv "$5.tmp" "$5"; ' +
    '"$4" restart >>"$6" 2>&1; exit "$update_code"';
  return ['sh', '-c', script, 'monad-upgrade', String(parentPid), updaterPath, tag, binaryPath, result, log];
}

export function workerLauncherCommand(
  platform: NodeJS.Platform,
  parentPid: number,
  updaterPath: string,
  tag: string,
  binaryPath: string,
  resultPath?: string,
  logPath?: string
): string[] {
  const worker = workerCommand(platform, parentPid, updaterPath, tag, binaryPath, resultPath, logPath);
  if (platform === 'win32') {
    const invocation = `& ${worker.map(powerShellLiteral).join(' ')}`;
    const encoded = Buffer.from(invocation, 'utf16le').toString('base64');
    const script =
      "$proc = Start-Process -FilePath 'powershell' " +
      `-ArgumentList @('-NoProfile', '-EncodedCommand', '${encoded}') -WindowStyle Hidden -PassThru; $proc.Id`;
    return ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
  }
  return ['sh', '-c', 'nohup "$@" >/dev/null 2>&1 < /dev/null &', 'monad-upgrade-launch', ...worker];
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

function platformNullDevice(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}
