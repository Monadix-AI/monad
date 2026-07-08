import type { MonadPaths, ObscuraConfig } from '@monad/home';
import type { ObscuraStatusResponse, SetObscuraRequest } from '@monad/protocol';
import type { DownloadProgress } from '#/services/download.ts';

import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll, saveProfile } from '@monad/home';

import { resolveBinary } from '#/infra/resolve-binary.ts';
import { downloadBytes } from '#/services/download.ts';

function obscuraBinaryAssetName(): string {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return `obscura-${arch}-${os}`;
}

export type ObscuraDownloadProgress = DownloadProgress & { assetName: string };

async function ensureObscuraBinary(
  home: string,
  onDownloadProgress?: (progress: ObscuraDownloadProgress) => void
): Promise<string> {
  const binDir = join(home, 'bin');
  const binPath = join(binDir, process.platform === 'win32' ? 'obscura.exe' : 'obscura');

  const resolved = resolveBinary('obscura', [binPath]);
  if (resolved) return resolved;

  const rel = await fetch('https://api.github.com/repos/h4ckf0r0day/obscura/releases/latest', {
    headers: { 'User-Agent': 'monad-daemon' }
  }).then((r) => r.json() as Promise<{ assets: { name: string; browser_download_url: string }[] }>);

  const assetName = obscuraBinaryAssetName();
  const asset = rel.assets.find(
    (a) => a.name === assetName || a.name === `${assetName}.tar.gz` || a.name === `${assetName}.zip`
  );
  if (!asset) throw new Error(`obscura: no release asset for platform "${assetName}"`);
  const sha256Asset = rel.assets.find((a) => a.name === `${asset.name}.sha256`);

  const { bytes } = await downloadBytes(asset.browser_download_url, {
    headers: { 'User-Agent': 'monad-daemon' },
    accept: 'application/gzip, application/zip, application/octet-stream',
    allowedContentTypes: ['application/gzip', 'application/x-gzip', 'application/zip', 'application/octet-stream'],
    onProgress: (progress) => onDownloadProgress?.({ ...progress, assetName: asset.name })
  });

  if (sha256Asset) {
    const { createHash } = await import('node:crypto');
    const expected = (await fetch(sha256Asset.browser_download_url).then((r) => r.text())).trim();
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (!expected.startsWith(actual)) throw new Error('obscura: SHA256 mismatch — download may be tampered');
  }

  mkdirSync(binDir, { recursive: true });
  if (asset.name.endsWith('.tar.gz')) {
    const tmp = `${binPath}.tar.gz`;
    await Bun.write(tmp, bytes);
    await Bun.$`tar -xzf ${tmp} -C ${binDir}`.quiet();
    unlinkSync(tmp);
  } else if (asset.name.endsWith('.zip')) {
    const tmp = `${binPath}.zip`;
    await Bun.write(tmp, bytes);
    await Bun.$`unzip -o ${tmp} -d ${binDir}`.quiet();
    unlinkSync(tmp);
  } else {
    await Bun.write(binPath, bytes);
  }
  if (process.platform !== 'win32') chmodSync(binPath, 0o755);
  return binPath;
}

export interface ObscuraModuleDeps {
  paths: MonadPaths;
  connectObscura?: (config: ObscuraConfig, command: string) => Promise<{ connected: boolean; tools: string[] }>;
  disconnectObscura?: () => Promise<void>;
  getObscuraStatus?: () => { connected: boolean; tools: string[] };
  onDownloadProgress?: (progress: ObscuraDownloadProgress) => void;
}

export function createObscuraModule({
  paths,
  connectObscura,
  disconnectObscura,
  getObscuraStatus,
  onDownloadProgress
}: ObscuraModuleDeps) {
  function isBinaryPresent(): boolean {
    const binPath = join(paths.home, 'bin', process.platform === 'win32' ? 'obscura.exe' : 'obscura');
    return resolveBinary('obscura', [binPath]) !== undefined;
  }

  async function getObscura(): Promise<ObscuraStatusResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    const status = getObscuraStatus?.() ?? { connected: false, tools: [] };
    return {
      enabled: cfg?.obscura.enabled ?? false,
      stealth: cfg?.obscura.stealth ?? false,
      requestTimeoutMs: cfg?.obscura.requestTimeoutMs,
      installed: isBinaryPresent(),
      ...status
    };
  }

  async function setObscura(req: SetObscuraRequest): Promise<ObscuraStatusResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('obscura settings: config missing');

    if (req.enabled) {
      const command = await ensureObscuraBinary(paths.home, onDownloadProgress);
      cfg.obscura = { enabled: true, stealth: req.stealth ?? false, requestTimeoutMs: req.requestTimeoutMs };
      await saveProfile(paths.profile, cfg);
      const result = await (connectObscura?.(cfg.obscura, command) ?? { connected: false, tools: [] });
      return {
        enabled: true,
        stealth: cfg.obscura.stealth,
        requestTimeoutMs: cfg.obscura.requestTimeoutMs,
        installed: true,
        ...result
      };
    } else {
      cfg.obscura = {
        enabled: false,
        stealth: req.stealth ?? cfg.obscura.stealth,
        requestTimeoutMs: req.requestTimeoutMs
      };
      await saveProfile(paths.profile, cfg);
      await disconnectObscura?.();
      return {
        enabled: false,
        stealth: cfg.obscura.stealth,
        installed: isBinaryPresent(),
        connected: false,
        tools: []
      };
    }
  }

  return { getObscura, setObscura };
}
