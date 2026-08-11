import { expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { POWERSHELL_INSTALLER_AUTO_START } from '../../lib/dist-installer-autostart.ts';
import { removeDirectory } from '../../test-fs.ts';

test('the interactive PowerShell installer starts Monad, skips automation, and preserves a successful install on launch failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monad-installer-autostart-'));
  try {
    const installDir = join(root, 'bin');
    await mkdir(installDir, { recursive: true });
    const stubSource = join(root, 'stub.ts');
    await Bun.write(
      stubSource,
      `await Bun.write(Bun.env.MONAD_TEST_LOG!, Bun.argv.slice(2).join(' ') + '\\n');
process.exit(Number(Bun.env.MONAD_STUB_EXIT ?? 0));
`
    );
    const build = Bun.spawn(
      [process.execPath, 'build', stubSource, '--compile', '--outfile', join(installDir, 'monad.exe')],
      {
        stderr: 'pipe',
        stdout: 'ignore'
      }
    );
    expect(await build.exited).toBe(0);

    const runner = join(root, 'run.ps1');
    await Bun.write(
      runner,
      `$ErrorActionPreference = 'Stop'
function Test-MonadInteractive { return $env:MONAD_TEST_INTERACTIVE -eq '1' }
function Write-MonadStep($message) { Write-Output "STEP $message" }
function Write-MonadDone($message) { Write-Output "DONE $message" }
function Get-ExceptionMessage($exception) { return $exception.Message }
${POWERSHELL_INSTALLER_AUTO_START}
Start-MonadAfterInstall $args[0]
`
    );

    const successLog = join(root, 'success.log');
    const success = await runPowerShell(runner, installDir, {
      MONAD_TEST_INTERACTIVE: '1',
      MONAD_TEST_LOG: successLog
    });
    expect({ code: success.code, invocation: await Bun.file(successLog).text(), output: success.output }).toEqual({
      code: 0,
      invocation: 'up\n',
      output: 'STEP Starting Monad\r\nDONE Monad started\r\n'
    });

    const automatedLog = join(root, 'automated.log');
    const automated = await runPowerShell(runner, installDir, {
      MONAD_TEST_INTERACTIVE: '0',
      MONAD_TEST_LOG: automatedLog
    });
    expect({ code: automated.code, invoked: await Bun.file(automatedLog).exists(), output: automated.output }).toEqual({
      code: 0,
      invoked: false,
      output: ''
    });

    const failureLog = join(root, 'failure.log');
    const failure = await runPowerShell(runner, installDir, {
      MONAD_STUB_EXIT: '9',
      MONAD_TEST_INTERACTIVE: '1',
      MONAD_TEST_LOG: failureLog
    });
    expect(failure.code).toBe(0);
    expect(await Bun.file(failureLog).text()).toBe('up\n');
    expect(failure.output).toContain('automatic startup failed (exit code 9)');
  } finally {
    await removeDirectory(root);
  }
  // Compiles a standalone executable and then starts PowerShell three times, none of which fits
  // Bun's 5s default on a loaded Windows runner.
}, 30_000);

async function runPowerShell(
  runner: string,
  installDir: string,
  env: Record<string, string>
): Promise<{ code: number; output: string }> {
  const process = Bun.spawn(
    ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner, installDir],
    {
      env: { ...Bun.env, ...env },
      stderr: 'pipe',
      stdout: 'pipe'
    }
  );
  // stderr has to be drained even though it is unused: an unread pipe fills up and blocks the
  // child, which surfaces as a test timeout rather than as an error.
  const [code, output] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ]);
  return { code, output };
}
