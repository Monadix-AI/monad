#!/usr/bin/env bun

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    channel: { type: 'string', default: 'stable' },
    'new-dir': { type: 'string' },
    'old-dir': { type: 'string' },
    tag: { type: 'string' }
  },
  strict: true
});

if (!values['old-dir'] || !values['new-dir'] || !values.tag) {
  throw new Error('usage: upgrade-dist-e2e.ts --old-dir <dir> --new-dir <dir> --tag <tag> [--channel stable]');
}
if (process.platform === 'win32') throw new Error('the dist upgrade E2E currently runs on Unix release runners');

const oldDir = resolve(values['old-dir']);
const newDir = resolve(values['new-dir']);
const targetTag = values.tag as string;
const targetVersion = targetTag.replace(/^v/, '');
const channel = values.channel;
const installerName = 'install.sh';
const updaterName = 'monad-update';
const root = mkdtempSync(join(tmpdir(), 'monad-dist-upgrade-e2e-'));

const artifactServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const release = releasePayload(`http://127.0.0.1:${artifactServer.port}`);
    if (url.pathname.endsWith('/releases/latest')) return Response.json(release);
    if (url.pathname.includes('/releases/tags/')) return Response.json(release);
    if (url.pathname.endsWith('/releases')) return Response.json([release]);

    const match = url.pathname.match(/^\/(old|new)\/([^/]+)$/);
    const requestedName = match?.[2];
    if (!match || !requestedName || basename(requestedName) !== requestedName) {
      return new Response('not found', { status: 404 });
    }
    const file = Bun.file(join(match[1] === 'old' ? oldDir : newDir, requestedName));
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  }
});

try {
  await runScenario('cli');
  await runScenario('web');
  process.stdout.write(`[upgrade-dist-e2e] CLI and Web upgraded and restarted on ${targetVersion}\n`);
} finally {
  artifactServer.stop(true);
  rmSync(root, { recursive: true, force: true });
}

async function runScenario(kind: 'cli' | 'web'): Promise<void> {
  const scenarioRoot = join(root, kind);
  const home = join(scenarioRoot, 'home');
  const installDir = join(scenarioRoot, 'install');
  const monadHome = join(scenarioRoot, 'state');
  const configHome = join(home, '.config');
  const daemonPort = await unusedPort();
  const serverBase = `http://127.0.0.1:${artifactServer.port}`;
  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    MONAD_HOME: monadHome,
    MONAD_INSTALL_DIR: installDir,
    MONAD_NO_MODIFY_PATH: '1',
    MONAD_NO_OPEN: '1',
    MONAD_PORT: String(daemonPort),
    MONAD_URL: `http://127.0.0.1:${daemonPort}`,
    MONAD_DOWNLOAD_URL: `${serverBase}/new`,
    MONAD_RELEASE_API_BASE_URL: `${serverBase}/repos/Monadix-AI/monad`,
    MONAD_RELEASE_DOWNLOAD_BASE_URL: serverBase,
    MONAD_INSTALLER_GHE_BASE_URL: serverBase
  };

  await run(['sh', join(oldDir, installerName)], { ...env, MONAD_DOWNLOAD_URL: `${serverBase}/old` });
  const monad = join(installDir, 'monad');
  const updater = join(installDir, updaterName);
  chmodSync(monad, 0o755);
  chmodSync(updater, 0o755);
  const oldVersion = await run([monad, '--version'], env);
  if (oldVersion.includes(targetVersion)) throw new Error(`${kind}: old install unexpectedly reports ${targetVersion}`);

  const daemon = Bun.spawn([join(installDir, 'monad-daemon'), 'daemon'], {
    env: { ...process.env, ...env },
    stderr: 'ignore',
    stdin: 'ignore',
    stdout: 'ignore'
  });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${daemonPort}/health`)).ok, `${kind}: daemon not ready`);
    await Bun.write(join(monadHome, 'runtime', 'monad.pid'), String(daemon.pid));
    if (kind === 'cli') {
      const channelArgs = channel === 'stable' ? [] : ['--channel', channel];
      await run([monad, 'upgrade', ...channelArgs], env);
    } else {
      const statusUrl = `http://127.0.0.1:${daemonPort}/v1/system/upgrade`;
      await waitFor(async () => (await fetch(statusUrl)).ok, `${kind}: daemon did not become reachable`);
      await waitFor(async () => {
        const response = await fetch(statusUrl);
        if (!response.ok) return false;
        const status = (await response.json()) as { error?: string | null; stage?: string };
        if (status.stage === 'failed') throw new Error(`${kind}: prepare failed: ${status.error ?? 'unknown error'}`);
        return status.stage === 'ready';
      }, `${kind}: upgrade did not become ready`);
      const response = await fetch(statusUrl, { method: 'POST' });
      if (!response.ok) throw new Error(`${kind}: upgrade POST failed with ${response.status}`);
    }

    await waitFor(async () => {
      try {
        return (await run([monad, '--version'], env, true)).includes(targetVersion);
      } catch {
        return false;
      }
    }, `${kind}: installed binary did not reach ${targetVersion}`);
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${daemonPort}/health`);
        if (!response.ok) return false;
        const health = (await response.json()) as { version?: string };
        return health.version === targetVersion;
      } catch {
        return false;
      }
    }, `${kind}: daemon did not restart on ${targetVersion}`);
  } finally {
    await run([monad, 'stop'], env, true);
    if (daemon.exitCode === null) daemon.kill();
    await Promise.race([daemon.exited, Bun.sleep(3000)]);
  }
}

function releasePayload(base: string) {
  const installerUrl = `${base}/new/${installerName}`;
  return {
    assets: [{ name: installerName, url: installerUrl, browser_download_url: installerUrl }],
    body: 'dist upgrade e2e',
    draft: false,
    name: targetTag,
    prerelease: channel !== 'stable',
    tag_name: targetTag,
    url: `${base}/api/v3/repos/Monadix-AI/monad/releases/tags/${encodeURIComponent(targetTag)}`
  };
}

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error('Bun did not allocate a test port');
  return port;
}

async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(250);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${message}${detail}`);
}

async function run(command: string[], extraEnv: Record<string, string>, quiet = false): Promise<string> {
  if (!quiet) process.stdout.write(`[upgrade-dist-e2e] ${command.join(' ')}\n`);
  const proc = Bun.spawn(command, {
    env: { ...process.env, ...extraEnv },
    stderr: quiet ? 'pipe' : 'inherit',
    stdout: 'pipe'
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = quiet ? await new Response(proc.stderr).text() : '';
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited ${exitCode}: ${stderr || stdout}`);
  if (!quiet && stdout) process.stdout.write(stdout);
  return stdout;
}
