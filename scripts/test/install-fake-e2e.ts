#!/usr/bin/env bun

import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const testDir = join(root, 'dist', process.platform === 'win32' ? 'test-install-fake-win' : 'test-install-fake');
const packageDir = join(testDir, 'packages');
const installDir = join(testDir, 'install');
const binDir = join(testDir, 'bin');
const homeDir = join(testDir, 'home');
const fakeHome = join(testDir, 'fake-home');
const monad = join(binDir, process.platform === 'win32' ? 'monad.exe' : 'monad');

function fail(message: string): never {
  throw new Error(`[install-fake-e2e] ${message}`);
}

function ok(message: string): void {
  process.stdout.write(`  ✓ ${message}\n`);
}

function step(message: string): void {
  process.stdout.write(`\n[install-fake-e2e] ${message}\n`);
}

async function run(
  command: string[],
  options: { allowFailure?: boolean; env?: Record<string, string> } = {}
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(command, {
    cwd: root,
    env: { ...Bun.env, ...options.env },
    stderr: 'pipe',
    stdout: 'pipe'
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0 && !options.allowFailure) fail(`${command[0]} exited ${exitCode}\n${stdout}${stderr}`);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function makePackage(version: string): Promise<string> {
  const packagePath = join(packageDir, `monad-${version}`);
  const executable = join(packagePath, 'bin', process.platform === 'win32' ? 'monad.exe' : 'monad');
  await rm(packagePath, { force: true, recursive: true });
  await mkdir(join(packagePath, 'bin'), { recursive: true });
  await mkdir(join(packagePath, 'assets'), { recursive: true });
  await Bun.write(join(packagePath, 'assets', 'favicon.ico'), 'fake ico\n');
  await Bun.write(join(packagePath, 'assets', 'monad-icon-vector-solid.svg'), '<svg></svg>\n');
  if (process.platform === 'win32') {
    await Bun.write(executable, `fake monad ${version}`);
  } else {
    await Bun.write(
      executable,
      `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version) echo "monad ${version}" ;;
  --help|-h) printf 'monad ${version}\\nUsage: monad [command]\\n' ;;
  init)
    mkdir -p "\${MONAD_HOME}"
    test -f "\${MONAD_HOME}/config.json" || printf '{"model":{"providers":[{"id":"sample-openai-compatible"}]}}\\n' >"\${MONAD_HOME}/config.json"
    ;;
  stop) exit 0 ;;
  *) echo "monad fake ${version}" ;;
esac
`
    );
    await chmod(executable, 0o755);
  }
  const tarball = join(packageDir, `monad-${version}.tar.gz`);
  await rm(tarball, { force: true });
  await run(['tar', '-czf', tarball, '-C', packagePath, '.']);
  return tarball;
}

async function makeFakeCurl(): Promise<{ binDir: string; log: string }> {
  const toolDir = join(testDir, 'tools');
  const executable = join(toolDir, 'curl');
  const log = join(testDir, 'curl.log');
  await mkdir(toolDir, { recursive: true });
  await Bun.write(
    executable,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf \'%s\\n\' "$*" >>"$MONAD_FAKE_CURL_LOG"',
      'url=""',
      'for arg in "$@"; do url="$arg"; done',
      'case " $* " in',
      '  *" -I"*) exit 0 ;;',
      'esac',
      '[[ "$url" != *.sha256 ]] || exit 42',
      'dest=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then dest="$2"; shift 2; else shift; fi',
      'done',
      '[ -n "$dest" ] || exit 0',
      'cp "$MONAD_FAKE_TARBALL" "$dest"'
    ].join('\n')
  );
  await chmod(executable, 0o755);
  return { binDir: toolDir, log };
}

function installerCommand(extraArgs: string[] = []): string[] {
  return process.platform === 'win32'
    ? [
        'powershell',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(root, 'scripts', 'install.ps1'),
        ...extraArgs
      ]
    : ['bash', join(root, 'scripts', 'install.sh'), ...extraArgs];
}

function installerEnv(tarball: string): Record<string, string> {
  return {
    HOME: fakeHome,
    MONAD_BIN_DIR: binDir,
    MONAD_DESKTOP_DIR: join(testDir, 'desktop'),
    MONAD_HOME: homeDir,
    MONAD_INSTALL_DIR: installDir,
    MONAD_NO_DAEMON: '1',
    MONAD_NO_PATH_MODIFY: '1',
    MONAD_SKIP_GIT: '1',
    MONAD_SKIP_VERIFY: '1',
    MONAD_START_MENU_DIR: join(testDir, 'start-menu'),
    MONAD_TARBALL: tarball
  };
}

async function runInstaller(tarball: string): Promise<void> {
  await run(installerCommand(['--no-daemon', '--no-verify', '--no-path-modify']), { env: installerEnv(tarball) });
}

async function assertVersion(version: string): Promise<void> {
  if (process.platform === 'win32') {
    if ((await Bun.file(monad).text()) !== `fake monad ${version}`) fail(`installed binary is not ${version}`);
    return;
  }
  const { output } = await run([monad, '--version']);
  if (output.trim() !== `monad ${version}`) fail(`expected monad ${version}, got ${output.trim()}`);
}

async function assertLauncher(): Promise<void> {
  if (process.platform === 'darwin') {
    const app = join(fakeHome, 'Applications', 'Monad.app', 'Contents');
    const launcher = await Bun.file(join(app, 'MacOS', 'monad')).text();
    const plist = await Bun.file(join(app, 'Info.plist')).text();
    if (!launcher.includes(monad) || !plist.includes('CFBundleIconFile')) fail('macOS launcher is invalid');
    return;
  }
  if (process.platform === 'linux') {
    for (const path of [
      join(fakeHome, '.local', 'share', 'applications', 'monad.desktop'),
      join(fakeHome, 'Desktop', 'Monad.desktop')
    ]) {
      const launcher = await Bun.file(path).text();
      if (!launcher.includes(`Exec=${monad} up`) || !launcher.includes(`Icon=${join(installDir, 'assets')}`)) {
        fail(`Linux launcher is invalid: ${path}`);
      }
    }
    return;
  }
  const links = [join(testDir, 'start-menu', 'Monad.lnk'), join(testDir, 'desktop', 'Monad.lnk')];
  const command = [
    '$shell=New-Object -ComObject WScript.Shell',
    `$links=@(${links.map((path) => `'${path.replaceAll("'", "''")}'`).join(',')})`,
    '$links|ForEach-Object{$s=$shell.CreateShortcut($_);[pscustomobject]@{Target=$s.TargetPath;Arguments=$s.Arguments;Icon=$s.IconLocation}}|ConvertTo-Json -Compress'
  ].join(';');
  const { output } = await run(['powershell', '-NoProfile', '-Command', command]);
  const shortcuts = JSON.parse(output) as Array<{ Arguments: string; Icon: string; Target: string }>;
  if (shortcuts.some((shortcut) => shortcut.Target !== monad || shortcut.Arguments !== 'up')) {
    fail('Windows launcher is invalid');
  }
}

await rm(testDir, { force: true, recursive: true });
await mkdir(packageDir, { recursive: true });
await mkdir(fakeHome, { recursive: true });
const first = await makePackage('1.0.0');
const second = await makePackage('1.1.0');
const third = await makePackage('1.2.0');

step('Flow 1: fresh install');
await runInstaller(first);
if (!(await Bun.file(monad).exists())) fail('explicit bin dir is missing monad');
if (process.platform !== 'win32' && !(await lstat(monad)).isSymbolicLink()) fail('monad link was not created');
await assertVersion('1.0.0');
await assertLauncher();
ok('fresh install created the binary, home, and launchers');

step('Flow 2: upgrade preserves home');
await mkdir(homeDir, { recursive: true });
const sentinel = join(homeDir, 'sentinel.txt');
await Bun.write(sentinel, 'keep');
await runInstaller(second);
await assertVersion('1.1.0');
await assertLauncher();
if ((await Bun.file(sentinel).text()) !== 'keep') fail('home data was wiped during upgrade');
ok('upgrade replaced the binary and preserved home');

step('Flow 3: force clears the install directory and skips verification');
const staleFile = join(installDir, 'stale', 'removed.txt');
await mkdir(join(installDir, 'stale'), { recursive: true });
await Bun.write(staleFile, 'remove');
const forceEnv = installerEnv(third);
forceEnv.MONAD_SKIP_VERIFY = '0';
if (process.platform === 'win32') {
  forceEnv.MONAD_TARBALL = third;
} else {
  const fakeCurl = await makeFakeCurl();
  delete forceEnv.MONAD_TARBALL;
  forceEnv.MONAD_FAKE_CURL_LOG = fakeCurl.log;
  forceEnv.MONAD_FAKE_TARBALL = third;
  forceEnv.MONAD_RELEASE_BASE_URL = 'https://release.invalid/monad';
  forceEnv.MONAD_VERSION = '1.2.0';
  forceEnv.PATH = `${fakeCurl.binDir}:${Bun.env.PATH ?? ''}`;
  const checkedInstall = await run(installerCommand(['--no-daemon', '--no-path-modify']), {
    allowFailure: true,
    env: forceEnv
  });
  if (checkedInstall.exitCode === 0) fail('installer unexpectedly accepted a missing checksum');
}
await run(installerCommand(['--force', '--no-daemon', '--no-path-modify']), { env: forceEnv });
await assertVersion('1.2.0');
// behavior-ok: --force clears stale files from the install directory before extracting the replacement
if (await Bun.file(staleFile).exists()) fail('force install left stale content behind');
if ((await Bun.file(sentinel).text()) !== 'keep') fail('force install wiped a separate monad home');
ok('force install replaced the full install tree and bypassed checksum download');

step('Flow 4: explicit bin dir skips PATH writes');
if (process.platform === 'win32') {
  const { output } = await run([
    'powershell',
    '-NoProfile',
    '-Command',
    "[Environment]::GetEnvironmentVariable('Path','User')"
  ]);
  if (output.split(';').includes(binDir)) fail('installer added explicit bin dir to user PATH');
} else {
  for (const path of [
    join(fakeHome, '.bashrc'),
    join(fakeHome, '.zshrc'),
    join(fakeHome, '.config', 'fish', 'config.fish')
  ]) {
    if ((await Bun.file(path).exists()) && (await Bun.file(path).text()).includes(binDir))
      fail(`PATH modified in ${path}`);
  }
}
ok('PATH configuration was not modified');

step('Flow 5: invalid input fails before install');
if (process.platform === 'win32') {
  const missing = join(packageDir, 'missing.tar.gz');
  const result = await run(installerCommand(), { allowFailure: true, env: installerEnv(missing) });
  if (result.exitCode === 0) fail('missing tarball unexpectedly succeeded');
} else {
  const invalidChannel = await run(installerCommand(['--channel', 'canary']), { allowFailure: true });
  if (invalidChannel.exitCode === 0 || !invalidChannel.output.includes("Unknown channel 'canary'")) {
    fail('invalid channel was not rejected');
  }
  const missingVersion = await run(installerCommand(['--version']), { allowFailure: true });
  if (missingVersion.exitCode === 0 || !missingVersion.output.includes('--version requires an argument')) {
    fail('missing --version argument was not rejected');
  }
}
ok('invalid installer input rejected');

const generated = await readdir(testDir);
if (generated.length === 0) fail('fake installer produced no outputs');
process.stdout.write('\n[install-fake-e2e] passed\n');
