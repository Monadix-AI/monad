// biome-ignore-all lint/suspicious/noConsole: standalone smoke CLI reports machine-readable evidence
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildSandboxPolicy,
  configureNativeLauncherPath,
  configureSandboxLauncher,
  configureSandboxNet,
  configureSandboxReadDeny,
  disposeSandboxSession,
  noneLauncher,
  sandboxedSpawn,
  selectSandboxLauncher
} from '../../src/index.ts';

if (process.platform !== 'win32') {
  console.log('skip: Windows-only smoke test');
  process.exit(0);
}

const launcher = resolve(process.argv[2] ?? 'monad-sandbox-appcontainer.exe');
if (!existsSync(launcher)) {
  console.error(`launcher not found: ${launcher}`);
  process.exit(2);
}

const sessionId = `spawnsmoke${process.pid}`;
const profile = `monad.${sessionId}`;
const work = mkdtempSync(join(tmpdir(), 'monad-appcontainer-spawn-'));
const outside = mkdtempSync(join(process.cwd(), 'denied-write-'));
const secret = mkdtempSync(join(process.cwd(), 'denied-read-'));

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(command: string) {
  const proc = sandboxedSpawn(
    ['cmd', '/c', command],
    { stdout: 'pipe', stderr: 'pipe' },
    buildSandboxPolicy([work], [], sessionId)
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { stdout, stderr, exitCode };
}

function profileExists(): boolean {
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Packages');
  return existsSync(packages) && readdirSync(packages).some((name) => name.startsWith(profile));
}

async function profileWasRemoved(): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!profileExists()) return true;
    await Bun.sleep(100);
  }
  return false;
}

try {
  configureNativeLauncherPath(launcher);
  const selected = selectSandboxLauncher('win32');
  assert(selected.kind === 'appcontainer', `auto selected ${selected.kind}`);
  configureSandboxLauncher(selected);
  configureSandboxNet('none');
  configureSandboxReadDeny([secret]);

  const inside = join(work, 'inside.txt');
  const insideResult = await run(`echo daemon> ${inside}`);
  assert(insideResult.exitCode === 0, `inside write exited ${insideResult.exitCode}: ${insideResult.stderr}`);
  assert((await Bun.file(inside).text()).trim() === 'daemon', 'inside write content mismatch');

  const escaped = join(outside, 'escaped.txt');
  await run(`echo escaped> ${escaped}`);
  assert(!existsSync(escaped), `outside write escaped to ${escaped}`);

  const credential = join(secret, 'credential.txt');
  writeFileSync(credential, 'APP_CONTAINER_SECRET');
  const denied = await run(`type ${credential}`);
  assert(!denied.stdout.includes('APP_CONTAINER_SECRET'), 'deny-read credential leaked');

  const longRunning = sandboxedSpawn(
    ['cmd', '/c', 'ping -n 30 127.0.0.1 >nul'],
    { stdout: 'pipe', stderr: 'pipe' },
    buildSandboxPolicy([work], [], sessionId)
  );
  await Bun.sleep(250);
  longRunning.kill();
  await Promise.race([
    longRunning.exited,
    Bun.sleep(5_000).then(() => {
      throw new Error('cancelled AppContainer process did not exit within 5 seconds');
    })
  ]);

  assert(profileExists(), `expected profile ${profile} before disposal`);
  disposeSandboxSession(sessionId);
  assert(await profileWasRemoved(), `profile ${profile} remained after disposal`);

  console.log(
    JSON.stringify({
      ok: true,
      selected: selected.kind,
      insideWrite: true,
      outsideWriteBlocked: true,
      denyReadBlocked: true,
      cancellation: true,
      profileDisposed: true
    })
  );
} finally {
  configureSandboxLauncher(noneLauncher);
  configureNativeLauncherPath(undefined);
  configureSandboxNet('unrestricted');
  configureSandboxReadDeny([]);
  disposeSandboxSession(sessionId);
  rmSync(work, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(secret, { recursive: true, force: true });
}
