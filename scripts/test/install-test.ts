#!/usr/bin/env bun

import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const dist = join(root, 'dist');
const testDir = join(dist, 'test-install');
const installDir = join(testDir, 'install');
const binDir = join(testDir, 'bin');
const homeDir = join(testDir, 'home');
const monad = join(binDir, process.platform === 'win32' ? 'monad.exe' : 'monad');

function fail(message: string): never {
  throw new Error(`[install-test] ${message}`);
}

function ok(message: string): void {
  process.stdout.write(`  ✓ ${message}\n`);
}

function step(message: string): void {
  process.stdout.write(`\n[install-test] ${message}\n`);
}

async function newestTarball(): Promise<string> {
  const pattern =
    Bun.env.TARBALL_GLOB ?? (process.platform === 'win32' ? 'monad-*-windows-*.tar.gz' : 'monad-*.tar.gz');
  const glob = new Bun.Glob(pattern);
  const candidates = (await readdir(dist))
    .filter((name) => glob.match(name) && !name.includes('test-install'))
    .map((name) => join(dist, name));
  const dated = await Promise.all(candidates.map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })));
  const tarball = dated.toSorted((a, b) => b.mtime - a.mtime)[0]?.path;
  return tarball ?? fail(`no tarball matching "${pattern}"; run "mise run release:build" first`);
}

async function run(command: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd: root,
    env: { ...Bun.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe'
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) fail(`${command[0]} exited ${exitCode}\n${stdout}${stderr}`);
  return stdout;
}

async function runInstaller(tarball: string): Promise<void> {
  const env = {
    MONAD_BIN_DIR: binDir,
    MONAD_APPLICATIONS_DIR: join(testDir, 'applications'),
    MONAD_HOME: homeDir,
    MONAD_INSTALL_DIR: installDir,
    MONAD_NO_DAEMON: '1',
    MONAD_NO_PATH_MODIFY: '1',
    MONAD_SKIP_GIT: Bun.env.MONAD_SKIP_GIT ?? '1',
    MONAD_SKIP_VERIFY: '1',
    MONAD_TARBALL: tarball
  };
  const command =
    process.platform === 'win32'
      ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'install.ps1')]
      : ['bash', join(root, 'scripts', 'install.sh')];
  await run(command, env);
}

async function smokeBinary(): Promise<void> {
  const help = await run([monad, '--help']);
  if (!help.trim()) fail('monad --help returned no output');
  ok('monad --help');
}

async function waitFor(url: string, tls = false): Promise<Response> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, tls ? ({ tls: { rejectUnauthorized: false } } as RequestInit) : undefined);
      if (response.ok) return response;
    } catch {}
    await Bun.sleep(100);
  }
  return fail(`${url} did not become ready`);
}

async function waitForDaemon(port: number): Promise<{ response: Response; url: string }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const url of [`https://127.0.0.1:${port}`, `http://127.0.0.1:${port}`]) {
      try {
        const response = await fetch(
          `${url}/health`,
          url.startsWith('https:') ? ({ tls: { rejectUnauthorized: false } } as RequestInit) : undefined
        );
        if (response.ok) return { response, url };
      } catch {}
    }
    await Bun.sleep(100);
  }
  return fail(`daemon on port ${port} did not become ready`);
}

async function runtimeSmoke(): Promise<void> {
  step('Runtime smoke tests');
  const webUrl = 'http://127.0.0.1:3099';
  const daemon = Bun.spawn([monad, 'daemon'], {
    env: { ...Bun.env, MONAD_HOME: homeDir, MONAD_MOCK_MODEL: '1', MONAD_PORT: '4399' },
    stderr: 'pipe',
    stdout: 'pipe'
  });
  let web: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const { response: health, url: daemonUrl } = await waitForDaemon(4399);
    web = Bun.spawn([monad, 'web'], {
      env: { ...Bun.env, MONAD_URL: daemonUrl, WEB_PORT: '3099' },
      stderr: 'pipe',
      stdout: 'pipe'
    });
    const home = await waitFor(`${webUrl}/`);
    const proxy = await waitFor(`${webUrl}/api/health`);
    if (!((await health.json()) as { status?: string }).status) fail('daemon health response is invalid');
    if (!(await home.text()).includes('<html')) fail('web root did not return HTML');
    if (!proxy.ok) fail('web daemon proxy failed');
    ok('daemon /health');
    ok('web / serves embedded SPA');
    ok('web → daemon proxy');
  } finally {
    daemon.kill();
    web?.kill();
    await Promise.allSettled([daemon.exited, web?.exited]);
  }
}

await stat(dist).catch(() => fail('dist/ not found; run "mise run release:build" first'));
if (Bun.argv.includes('--clean')) {
  step('Cleaning dist/test-install');
  await rm(testDir, { force: true, recursive: true });
}

const tarball = await newestTarball();
process.stdout.write(`[install-test] tarball : ${basename(tarball)}\n[install-test] install : ${installDir}\n`);

step('Flow 1: fresh install');
await rm(testDir, { force: true, recursive: true });
await runInstaller(tarball);
if (!(await Bun.file(monad).exists())) fail('binary not found after fresh install');
await smokeBinary();
const firstMtime = (await stat(monad)).mtimeMs;

step('Flow 2: upgrade');
await Bun.sleep(1_000);
await runInstaller(tarball);
if (!(await Bun.file(monad).exists())) fail('binary missing after upgrade');
await smokeBinary();
if ((await stat(monad)).mtimeMs < firstMtime) fail('binary mtime did not advance');
ok('binary replaced');

step('Flow 3: home data survives overwrite');
const sentinel = join(homeDir, 'install-test-sentinel');
await mkdir(homeDir, { recursive: true });
await appendFile(sentinel, 'keep\n');
await runInstaller(tarball);
if ((await Bun.file(sentinel).text()) !== 'keep\n') fail('home data was wiped');
ok('home data preserved');

await runtimeSmoke();
process.stdout.write(`\n[install-test] outputs remain inside ${testDir}\n`);
