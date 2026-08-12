import type { ReleaseFetch, ResolvedRelease, ResolvedReleaseAsset } from './release-update.ts';

import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';

export interface UpgradeDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
}

export interface PreparedUpgrade {
  archivePath: string;
  installerPath: string;
  downloadDirectory: string;
}

export interface PrepareUpgradeOptions {
  directory: string;
  distTarget: string;
  fetch: ReleaseFetch;
  platform: NodeJS.Platform;
  release: ResolvedRelease;
  onProgress: (progress: UpgradeDownloadProgress) => void;
}

export interface UpgradeWorkerOptions {
  binaryPath: string;
  downloadDirectory: string;
  installerPath: string;
  logPath?: string;
  parentPid: number;
  platform: NodeJS.Platform;
  restart: boolean;
  resultPath?: string;
}

const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/;

export async function prepareUpgradeAssets(options: PrepareUpgradeOptions): Promise<PreparedUpgrade> {
  if (!options.release.immutable) throw new Error(`GitHub release ${options.release.tag} is not immutable`);
  const installerName = options.platform === 'win32' ? 'install.ps1' : 'install.sh';
  const archiveName = `monad-${options.distTarget}.${options.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const assets = [requireAsset(options.release, archiveName), requireAsset(options.release, installerName)];
  const totalBytes = assets.reduce((total, asset) => total + asset.size, 0);
  const loadedByAsset = new Map<string, number>();
  const startedAt = performance.now();
  const abort = new AbortController();
  await mkdir(options.directory, { recursive: true });

  const downloads = assets.map((asset) =>
    downloadVerifiedAsset(asset, options.directory, options.fetch, abort.signal, (loadedBytes) => {
      loadedByAsset.set(asset.name, loadedBytes);
      const downloadedBytes = [...loadedByAsset.values()].reduce((total, loaded) => total + loaded, 0);
      const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
      options.onProgress({ downloadedBytes, totalBytes, bytesPerSecond: downloadedBytes / elapsedSeconds });
    })
  );
  let paths: string[];
  try {
    paths = await Promise.all(downloads);
  } catch (error) {
    abort.abort();
    await Promise.allSettled(downloads);
    throw error;
  }
  const byName = new Map(assets.map((asset, index) => [asset.name, paths[index] as string]));
  return {
    archivePath: byName.get(archiveName) as string,
    installerPath: byName.get(installerName) as string,
    downloadDirectory: options.directory
  };
}

export function upgradeWorkerCommand(options: UpgradeWorkerOptions): string[] {
  const result = options.resultPath ?? platformNullDevice(options.platform);
  const log = options.logPath ?? platformNullDevice(options.platform);
  const installDir = (options.platform === 'win32' ? win32 : posix).dirname(options.binaryPath);
  if (options.platform === 'win32') {
    const restart = options.restart ? '& $args[2] restart *>> $args[4]; ' : '';
    const script =
      'Wait-Process -Id ([int]$args[0]) -ErrorAction SilentlyContinue; ' +
      '$env:MONAD_INSTALLER_ARTIFACT_DIR = $args[5]; $env:CARGO_DIST_FORCE_INSTALL_DIR = $args[6]; ' +
      "$env:MONAD_NO_MODIFY_PATH = '1'; " +
      '& $args[1] *> $args[4]; $updateCode = $LASTEXITCODE; ' +
      '$completed = [DateTime]::UtcNow.ToString("o"); ' +
      'Set-Content -LiteralPath "$($args[3]).tmp" -Value @($updateCode, $completed); ' +
      'Move-Item -Force -LiteralPath "$($args[3]).tmp" -Destination $args[3]; ' +
      restart +
      'exit $updateCode';
    return [
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
      String(options.parentPid),
      options.installerPath,
      options.binaryPath,
      result,
      log,
      options.downloadDirectory,
      installDir
    ];
  }
  const restart = options.restart ? '"$3" restart >>"$5" 2>&1; ' : '';
  const script =
    'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; ' +
    'MONAD_INSTALLER_ARTIFACT_DIR="$6" CARGO_DIST_FORCE_INSTALL_DIR="$7" MONAD_NO_MODIFY_PATH=1 ' +
    'sh "$2" --no-modify-path >"$5" 2>&1; update_code=$?; completed=$(date -u +%Y-%m-%dT%H:%M:%SZ); ' +
    'printf "%s\\n%s\\n" "$update_code" "$completed" >"$4.tmp"; mv "$4.tmp" "$4"; ' +
    restart +
    'exit "$update_code"';
  return [
    'sh',
    '-c',
    script,
    'monad-upgrade',
    String(options.parentPid),
    options.installerPath,
    options.binaryPath,
    result,
    log,
    options.downloadDirectory,
    installDir
  ];
}

export function upgradeWorkerLauncherCommand(options: UpgradeWorkerOptions): string[] {
  const worker = upgradeWorkerCommand(options);
  if (options.platform === 'win32') {
    const invocation = `& ${worker.map(powerShellLiteral).join(' ')}`;
    const encoded = Buffer.from(invocation, 'utf16le').toString('base64');
    const script =
      "$proc = Start-Process -FilePath 'powershell' " +
      `-ArgumentList @('-NoProfile', '-EncodedCommand', '${encoded}') -WindowStyle Hidden -PassThru; $proc.Id`;
    return ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
  }
  return ['sh', '-c', 'nohup "$@" >/dev/null 2>&1 < /dev/null &', 'monad-upgrade-launch', ...worker];
}

function requireAsset(release: ResolvedRelease, name: string): ResolvedReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`GitHub release ${release.tag} is missing ${name}`);
  if (!SHA256_DIGEST.test(asset.digest ?? '')) throw new Error(`GitHub release asset ${name} has no SHA-256 digest`);
  if (asset.size <= 0 || asset.size > MAX_ASSET_BYTES) throw new Error(`GitHub release asset ${name} has invalid size`);
  return asset;
}

async function downloadVerifiedAsset(
  asset: ResolvedReleaseAsset,
  directory: string,
  fetchImpl: ReleaseFetch,
  signal: AbortSignal,
  onProgress: (loadedBytes: number) => void
): Promise<string> {
  const destination = join(directory, asset.name);
  const temporary = `${destination}.part`;
  await rm(temporary, { force: true });
  const response = await fetchImpl(asset.url, { headers: { 'User-Agent': 'monad-upgrade' }, signal });
  if (!response.ok) throw new Error(`download ${asset.name} failed: HTTP ${response.status}`);
  if (!response.body) throw new Error(`download ${asset.name} returned an empty response body`);

  const writer = Bun.file(temporary).writer();
  const hasher = new Bun.CryptoHasher('sha256');
  const reader = response.body.getReader();
  let loadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      loadedBytes += value.byteLength;
      if (loadedBytes > asset.size || loadedBytes > MAX_ASSET_BYTES)
        throw new Error(`download ${asset.name} is too large`);
      hasher.update(value);
      await writer.write(value);
      onProgress(loadedBytes);
    }
    await writer.end();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await Promise.resolve(writer.end()).catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (loadedBytes !== asset.size) {
    await rm(temporary, { force: true });
    throw new Error(`download ${asset.name} size mismatch: expected ${asset.size}, got ${loadedBytes}`);
  }
  const actual = `sha256:${hasher.digest('hex')}`;
  if (actual !== asset.digest) {
    await rm(temporary, { force: true });
    throw new Error(`GitHub digest mismatch for ${asset.name}: expected ${asset.digest}, got ${actual}`);
  }
  await rm(destination, { force: true });
  await rename(temporary, destination);
  if (asset.name === 'install.sh') await chmod(destination, 0o700);
  return destination;
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function platformNullDevice(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}
