import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface InstallCargoDistOptions {
  version: string;
  expectedSha256: string;
  download?: (url: string) => Promise<Uint8Array>;
  execute?: (installerPath: string) => Promise<number>;
}

const download = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cargo-dist installer download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

const execute = async (installerPath: string): Promise<number> => {
  const process = Bun.spawn(['sh', installerPath], {
    env: Bun.env,
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit'
  });
  return process.exited;
};

export async function installCargoDist({
  version,
  expectedSha256,
  download: fetchInstaller = download,
  execute: runInstaller = execute
}: InstallCargoDistOptions): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid cargo-dist version: ${version}`);
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('cargo-dist installer SHA-256 must be 64 lowercase hexadecimal characters');
  }

  const url = `https://github.com/axodotdev/cargo-dist/releases/download/v${version}/cargo-dist-installer.sh`;
  const bytes = await fetchInstaller(url);
  const actualSha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(`cargo-dist installer checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }

  const directory = mkdtempSync(join(tmpdir(), 'monad-cargo-dist-'));
  const installerPath = join(directory, 'cargo-dist-installer.sh');
  try {
    await Bun.write(installerPath, bytes);
    const exitCode = await runInstaller(installerPath);
    if (exitCode !== 0) throw new Error(`cargo-dist installer exited with code ${exitCode}`);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const [version, expectedSha256] = process.argv.slice(2);
  if (!version || !expectedSha256) {
    throw new Error('usage: bun scripts/install-cargo-dist.ts <version> <installer-sha256>');
  }
  await installCargoDist({ version, expectedSha256 });
}
