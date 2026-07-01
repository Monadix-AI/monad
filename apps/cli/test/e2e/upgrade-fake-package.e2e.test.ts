import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';

import { type CommandContext } from '../../src/commands/types.ts';
import { createUpgradeCommand } from '../../src/commands/upgrade.ts';
import { setOutputMode } from '../../src/lib/output.ts';

const originalHome = Bun.env.MONAD_HOME;

let home: string;
let targetBinary: string;
let server: ReturnType<typeof Bun.serve>;
let output = '';

function ctx(positionals: string[] = [], flags: Record<string, unknown> = {}): CommandContext {
  return {
    positionals,
    flags,
    globals: { json: false, quiet: false, verbose: 0, yes: false, color: false },
    client: {} as CommandContext['client']
  };
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher('sha256').update(new TextEncoder().encode(text)).digest('hex');
}

beforeEach(async () => {
  home = join(tmpdir(), `monad-upgrade-fake-package-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  targetBinary = join(home, 'bin', 'monad');
  await mkdir(join(home, 'bin'), { recursive: true });
  await Bun.write(targetBinary, 'monad-current');
  Bun.env.MONAD_HOME = home;
  output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  setOutputMode({ format: 'human', quiet: false, color: false });
});

afterEach(async () => {
  server?.stop(true);
  process.stdout.write = originalStdoutWrite;
  Bun.env.MONAD_HOME = originalHome;
  setOutputMode({ format: 'human', quiet: false, color: false });
  await rm(home, { recursive: true, force: true });
});

const originalStdoutWrite = process.stdout.write.bind(process.stdout);

test('upgrade e2e installs a fake package through a real downloaded install script', async () => {
  const installedBinary = 'monad-fake-package-v9.9.9';
  const installScriptName = process.platform === 'win32' ? 'install.ps1' : 'install.sh';
  const installScript =
    process.platform === 'win32'
      ? `<#
Fake monad installer for upgrade e2e.
#>
$ErrorActionPreference = 'Stop'
if (-not $env:MONAD_UPGRADE_TARGET) { throw 'MONAD_UPGRADE_TARGET is required' }
if (-not $env:MONAD_FAKE_PACKAGE_URL) { throw 'MONAD_FAKE_PACKAGE_URL is required' }
Invoke-WebRequest -Uri $env:MONAD_FAKE_PACKAGE_URL -OutFile $env:MONAD_UPGRADE_TARGET -UseBasicParsing
`
      : `#!/usr/bin/env bash
set -euo pipefail
: "\${MONAD_UPGRADE_TARGET:?}"
: "\${MONAD_FAKE_PACKAGE_URL:?}"
bun -e 'const [url,target]=process.argv.slice(-2); const res=await fetch(url); if (!res.ok) process.exit(7); await Bun.write(target, await res.text());' "$MONAD_FAKE_PACKAGE_URL" "$MONAD_UPGRADE_TARGET"
`;
  const installHash = sha256Hex(installScript);

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/repos/monadix-labs/monad/releases/latest') {
        return Response.json({ tag_name: 'v9.9.9' });
      }
      if (url.pathname === `/monadix-labs/monad/releases/download/v9.9.9/${installScriptName}.sha256`) {
        return new Response(`${installHash}  ${installScriptName}\n`);
      }
      if (url.pathname === `/scripts/${installScriptName}`) {
        return new Response(installScript);
      }
      if (url.pathname === '/packages/monad-fake-v9.9.9') {
        return new Response(installedBinary);
      }
      return new Response('not found', { status: 404 });
    }
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const command = createUpgradeCommand({
    binaryPath: targetBinary,
    releaseApiBaseUrl: `${baseUrl}/repos/monadix-labs/monad`,
    releaseDownloadBaseUrl: baseUrl,
    installScriptUrl: `${baseUrl}/scripts/${installScriptName}`,
    installerEnv: {
      MONAD_FAKE_PACKAGE_URL: `${baseUrl}/packages/monad-fake-v9.9.9`
    }
  });

  await command.run(ctx());

  expect(await Bun.file(targetBinary).text()).toBe(installedBinary);
  expect(await Bun.file(join(home, 'backup', 'binaries', `monad-${MONAD_VERSION}`)).text()).toBe('monad-current');
  expect(output).toContain('SHA-256');
});
