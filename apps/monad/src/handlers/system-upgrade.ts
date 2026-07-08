import type { SystemUpgradeStatus } from '@monad/protocol';

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';

export interface SystemUpgradeOptions {
  getUpgradeInfo?: () => { latestVersion: string; latestVersionCheckedAt: string } | null;
  binaryPath?: string;
  cacheDir?: string;
  fetch?: typeof fetch;
  spawn?: typeof Bun.spawn;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
}

interface PreparedArtifact {
  latestVersion: string;
  installScriptPath: string;
  tarballPath: string;
}

const RELEASE_REPOSITORY = 'Monadix-AI/monad';
const RELEASE_DOWNLOAD_BASE = 'https://github.com';
const INSTALL_SCRIPT_NAMES: Record<string, string> = {
  win32: 'install.ps1'
};

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
  const fetchImpl = options.fetch ?? fetch;
  const spawn = options.spawn ?? Bun.spawn;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  let status = buildIdleStatus(options.getUpgradeInfo);
  let prepared: PreparedArtifact | null = null;
  let preparing: Promise<void> | null = null;
  let installing: Promise<void> | null = null;

  function current(): SystemUpgradeStatus {
    if (status.stage === 'idle') status = buildIdleStatus(options.getUpgradeInfo);
    if (options.cacheDir && status.available && status.stage === 'idle') void prepare();
    return status;
  }

  async function start(): Promise<SystemUpgradeStatus> {
    if (installing) return status;
    if (!status.available) {
      if (status.stage === 'idle') status = buildIdleStatus(options.getUpgradeInfo);
      return status;
    }
    if (!prepared) {
      void prepare();
      return status;
    }
    status = { ...status, stage: 'installing', progress: STAGES.installing, error: null };
    installing = runInstall(prepared).finally(() => {
      installing = null;
    });
    return status;
  }

  async function prepare(): Promise<void> {
    if (preparing) return preparing;
    if (installing) return installing;
    if (status.stage !== 'idle' && status.stage !== 'failed') return;
    status = { ...buildIdleStatus(options.getUpgradeInfo), stage: 'checking', progress: STAGES.checking, error: null };
    if (!status.available || !status.latestVersion) {
      status = { ...status, stage: 'complete', progress: 100 };
      return;
    }
    preparing = runPrepare(status.latestVersion).finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function runPrepare(latestVersion: string): Promise<void> {
    try {
      const cacheDir = options.cacheDir ?? join(process.cwd(), '.monad-upgrade-cache');
      await mkdir(cacheDir, { recursive: true });
      const tag = latestVersion.startsWith('v') ? latestVersion : `v${latestVersion}`;
      const artifactVersion = latestVersion.replace(/^v/, '');
      const artifactName = `monad-${artifactVersion}-${resolvePlatform(platform, arch)}`;
      const tarballPath = join(cacheDir, `${artifactName}.tar.gz`);
      const checksumPath = `${tarballPath}.sha256`;
      const installScriptName = INSTALL_SCRIPT_NAMES[platform] ?? 'install.sh';
      const installScriptPath = join(cacheDir, `${tag}-${installScriptName}`);
      const releaseBase = `${RELEASE_DOWNLOAD_BASE}/${RELEASE_REPOSITORY}/releases/download/${tag}`;

      setStage('downloading');
      await download(`${releaseBase}/${artifactName}.tar.gz`, tarballPath);
      await download(`${releaseBase}/${artifactName}.tar.gz.sha256`, checksumPath);
      await download(`${releaseBase}/${installScriptName}`, installScriptPath);
      await chmodInstallScript(installScriptPath, platform);

      setStage('verifying');
      await verifySha256(tarballPath, checksumPath);
      prepared = { latestVersion: artifactVersion, installScriptPath, tarballPath };
      status = { ...status, stage: 'ready', progress: 100, error: null };
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  async function runInstall(artifact: PreparedArtifact): Promise<void> {
    try {
      const upgradeEnv = {
        ...env,
        MONAD_NO_OPEN: '1',
        MONAD_TARBALL: artifact.tarballPath,
        MONAD_VERSION: artifact.latestVersion
      };
      const argv =
        platform === 'win32'
          ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', artifact.installScriptPath]
          : ['bash', artifact.installScriptPath, '--version', artifact.latestVersion];
      if (options.detached) {
        const proc = spawn(argv, {
          detached: true,
          env: upgradeEnv,
          stderr: 'ignore',
          stdin: 'ignore',
          stdout: 'ignore'
        });
        proc.unref?.();
        setStage('restarting');
        return;
      }
      const proc = spawn(argv, {
        env: upgradeEnv,
        stderr: 'pipe',
        stdout: 'pipe'
      });
      await Promise.all([consume(proc.stdout), consume(proc.stderr)]);
      const code = await proc.exited;
      if (code === 0) setStage('complete');
      else fail(`upgrade exited with code ${code}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  async function download(url: string, path: string): Promise<void> {
    const res = await fetchImpl(url, { headers: { 'User-Agent': `monad-daemon/${MONAD_VERSION}` } });
    if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
    await writeFile(path, new Uint8Array(await res.arrayBuffer()));
  }

  async function consume(stream: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      observeOutput(decoder.decode(chunk, { stream: true }));
    }
  }

  function observeOutput(text: string): void {
    if (/install/i.test(text)) setStage('installing');
    else if (/restart|start/i.test(text)) setStage('restarting');
  }

  function setStage(stage: SystemUpgradeStatus['stage']): void {
    if (status.stage === 'failed' || status.stage === 'complete') return;
    status = { ...status, stage, progress: Math.max(status.progress, STAGES[stage]), error: null };
  }

  function fail(error: string): void {
    status = { ...status, stage: 'failed', progress: 100, error };
  }

  return { getStatus: current, start };
}

async function chmodInstallScript(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return;
  await import('node:fs/promises').then((m) => m.chmod(path, 0o700));
}

async function verifySha256(tarballPath: string, checksumPath: string): Promise<void> {
  const checksumText = await Bun.file(checksumPath).text();
  const expected = checksumText.trim().split(/\s+/)[0]?.toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('invalid checksum file');
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(tarballPath).arrayBuffer());
  const actual = hasher.digest('hex');
  if (actual !== expected) throw new Error(`hash mismatch: expected ${expected}, got ${actual}`);
}

function resolvePlatform(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (platform === 'win32') return 'windows-x64';
  throw new Error(`unsupported platform: ${platform}`);
}

function buildIdleStatus(getUpgradeInfo?: SystemUpgradeOptions['getUpgradeInfo']): SystemUpgradeStatus {
  const latestVersion = getUpgradeInfo?.()?.latestVersion ?? null;
  return {
    available: Boolean(latestVersion && latestVersion !== MONAD_VERSION),
    currentVersion: MONAD_VERSION,
    latestVersion,
    stage: 'idle',
    progress: 0,
    error: null
  };
}
