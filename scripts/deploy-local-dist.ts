#!/usr/bin/env bun

import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import rootPackage from '../package.json' with { type: 'json' };

const root = resolve(import.meta.dir, '..');
const artifactsDir = join(root, 'target', 'distrib');
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    'build-only': { type: 'boolean' },
    'no-start': { type: 'boolean' },
    target: { type: 'string' }
  },
  strict: true
});

const dist = Bun.which('dist') ?? Bun.which('cargo-dist');
if (!dist) throw new Error('dist 0.32.0 is unavailable; run this command through mise');
if (process.platform === 'win32') {
  throw new Error('local source builds run on macOS or Linux; use the published PowerShell installer on Windows');
}

const version = rootPackage.version;
const target = values.target ?? hostDistTarget();
await run([dist, 'build', '--allow-dirty', `--target=${target}`, `--tag=v${version}`, '--force-tag'], {
  MONAD_DIST_VERSION: version
});
await run(['bun', join(root, 'scripts', 'enhance-dist-installers.ts')], {});

if (values['build-only']) {
  process.stdout.write(`[deploy-local-dist] built ${target} under ${artifactsDir}\n`);
  process.exit(0);
}

const installDir = Bun.env.MONAD_INSTALL_DIR ?? join(homedir(), '.monad', 'bin');
const installedBinary = join(installDir, 'monad');
const installer = join(artifactsDir, 'install.sh');
await access(installer);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const requestedName = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!requestedName || requestedName !== basename(requestedName)) return new Response('not found', { status: 404 });
    const file = Bun.file(join(artifactsDir, requestedName));
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  }
});

try {
  if (await Bun.file(installedBinary).exists()) {
    await run([installedBinary, 'stop'], {}, true);
  }

  const installerEnv = {
    MONAD_DOWNLOAD_URL: `http://127.0.0.1:${server.port}`,
    MONAD_INSTALL_DIR: installDir
  };
  await run(['sh', installer], installerEnv);
} finally {
  server.stop(true);
}

await access(installedBinary);
await access(join(installDir, 'monad-update'));

if (!values['no-start']) await run([installedBinary, 'up'], {});
process.stdout.write(`[deploy-local-dist] installed Monad ${version} in ${installDir}\n`);

function hostDistTarget(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'linux') {
    const ldd = Bun.spawnSync(['ldd', '--version']);
    const output = `${ldd.stdout.toString()}${ldd.stderr.toString()}`;
    return `${arch}-unknown-linux-${/musl/i.test(output) ? 'musl' : 'gnu'}`;
  }
  throw new Error(`unsupported local build platform: ${process.platform}`);
}

async function run(command: string[], extraEnv: Record<string, string>, allowFailure = false): Promise<void> {
  process.stdout.write(`[deploy-local-dist] ${command.join(' ')}\n`);
  const child = Bun.spawn(command, {
    env: { ...process.env, ...extraEnv },
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit'
  });
  const code = await child.exited;
  if (!allowFailure && code !== 0) throw new Error(`${command[0]} exited with code ${code}`);
}
