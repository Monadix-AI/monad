import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SHELL_INSTALLER_AUTO_START } from '../../lib/dist-installer-autostart.ts';

test('the interactive shell installer starts Monad, skips automation, and preserves a successful install on launch failure', async () => {
  const enhancer = await Bun.file(join(import.meta.dir, '../../enhance-dist-installers.ts')).text();
  expect({
    callsShellStartup: enhancer.includes('monad_start_after_install "$_install_dir"'),
    callsWindowsStartup: enhancer.includes('Start-MonadAfterInstall $dest_dir'),
    injectsPowerShellRuntime: enhancer.includes(`${'$'}{POWERSHELL_INSTALLER_AUTO_START}`),
    injectsShellRuntime: enhancer.includes(`${'$'}{SHELL_INSTALLER_AUTO_START}`)
  }).toEqual({
    callsShellStartup: true,
    callsWindowsStartup: true,
    injectsPowerShellRuntime: true,
    injectsShellRuntime: true
  });
  const root = await mkdtemp(join(tmpdir(), 'monad-installer-autostart-'));
  try {
    const installDir = join(root, 'bin');
    const binary = join(installDir, 'monad');
    await Bun.write(
      binary,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$MONAD_TEST_LOG"
exit "\${MONAD_STUB_EXIT:-0}"
`
    );
    await chmod(binary, 0o755);
    const runner = join(root, 'run.sh');
    await Bun.write(
      runner,
      `#!/bin/sh
PRINT_QUIET=0
NO_COLOR=1
monad_is_interactive() { [ "\${MONAD_TEST_INTERACTIVE:-0}" = "1" ]; }
monad_step() { printf 'STEP %s\\n' "$1" >&2; }
monad_done() { printf 'DONE %s\\n' "$1" >&2; }
${SHELL_INSTALLER_AUTO_START}
monad_start_after_install "$1"
`
    );
    await chmod(runner, 0o755);

    const successLog = join(root, 'success.log');
    const success = await runShell(runner, installDir, {
      MONAD_TEST_INTERACTIVE: '1',
      MONAD_TEST_LOG: successLog
    });
    expect({ code: success.code, invocation: await Bun.file(successLog).text(), stderr: success.stderr }).toEqual({
      code: 0,
      invocation: 'up\n',
      stderr: 'STEP Starting Monad\nDONE Monad started\n'
    });

    const automatedLog = join(root, 'automated.log');
    const automated = await runShell(runner, installDir, {
      MONAD_TEST_INTERACTIVE: '0',
      MONAD_TEST_LOG: automatedLog
    });
    expect({ code: automated.code, invoked: await Bun.file(automatedLog).exists(), stderr: automated.stderr }).toEqual({
      code: 0,
      invoked: false,
      stderr: ''
    });

    const failureLog = join(root, 'failure.log');
    const failure = await runShell(runner, installDir, {
      MONAD_STUB_EXIT: '9',
      MONAD_TEST_INTERACTIVE: '1',
      MONAD_TEST_LOG: failureLog
    });
    expect({ code: failure.code, invocation: await Bun.file(failureLog).text(), stderr: failure.stderr }).toEqual({
      code: 0,
      invocation: 'up\n',
      stderr: `STEP Starting Monad\n  ! Monad installed, but automatic startup failed (exit 9). Run ${binary} up manually.\n`
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

async function runShell(
  runner: string,
  installDir: string,
  env: Record<string, string>
): Promise<{ code: number; stderr: string }> {
  const process = Bun.spawn(['/bin/sh', runner, installDir], {
    env: { ...Bun.env, ...env },
    stderr: 'pipe',
    stdout: 'ignore'
  });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  return { code, stderr };
}
