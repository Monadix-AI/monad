import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SHELL_INSTALLER_TERMINAL_GUARD } from '../../lib/dist-installer-terminal.ts';

const root = resolve(import.meta.dir, '../../..');

test('dist installer enhancement preserves the product and download contracts', async () => {
  const enhancer = await Bun.file(join(root, 'scripts/enhance-dist-installers.ts')).text();
  const docs = (await Bun.file(join(root, 'docs/docs.json')).json()) as {
    description: string;
  };

  expect(docs.description).toBe('Daemon-first agent team runtime with headless architecture.');
  expect(enhancer).toContain(docs.description);
  expect(enhancer).not.toContain('Local AI runtime');
  expect(enhancer).toContain('monad_download_progress "$1" "$2"');
  expect(enhancer).toContain('MONAD_FORCE_INTERACTIVE:-');
  expect(enhancer).toContain('shasum -a 256');
  expect(enhancer).not.toContain('--silent --head');
  expect(enhancer).toContain('--retry 3');
  expect(enhancer).toContain('MONAD_OUTPUT:-');
  expect(enhancer).toContain("$env:MONAD_OUTPUT -eq 'json'");
  expect(enhancer).toContain('Confirm-MonadArchiveSha256 $dir_path $url');
  expect(enhancer).toContain('Get-FileHash -LiteralPath $path -Algorithm SHA256');
  expect(enhancer).toContain('MONAD_INSTALLER_ARTIFACT_DIR');
  expect(enhancer).toContain('Write-MonadInlineProgress $status');
  expect(enhancer).toContain('$MonadGlyphBrand = [char]0x25c6');
  expect(enhancer).toContain('$MonadGlyphFilled = [char]0x25ae');
  expect(enhancer).toContain('([string]$MonadGlyphFilled * $filled)');
  expect(enhancer).not.toContain('Write-Progress');
  expect(enhancer).toContain('rejects code that PowerShell has already allowed to run');
  expect(enhancer).toContain('PowerShell installer must remain ASCII-safe for Windows PowerShell 5.1');
  expect(enhancer).toContain('copyFile(generatedShell, shellInstaller)');
  expect(enhancer).toContain('copyFile(generatedPowerShell, powerShellInstaller)');
});

test('animated installer output hides the cursor and consumes direction keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-installer-terminal-'));
  const shellPath = join(dir, 'terminal-guard.sh');
  const terminalPath = join(dir, 'terminal-input');
  const sttyLogPath = join(dir, 'stty.log');
  const drainedInputPath = join(dir, 'drained-input');
  await writeFile(terminalPath, '\x1b[A');
  await writeFile(
    shellPath,
    `monad_is_interactive() { return 0; }
${SHELL_INSTALLER_TERMINAL_GUARD}
MONAD_TERMINAL_DEVICE="$1"
MONAD_STTY_LOG="$2"
MONAD_DRAINED_INPUT="$3"
stty() {
    if [ "$1" = "-g" ]; then
        printf 'saved-state'
    else
        printf '%s\\n' "$*" >> "$MONAD_STTY_LOG"
    fi
}
cat() {
    command cat > "$MONAD_DRAINED_INPUT"
}
monad_terminal_lock
printf 'locked\\n' >&2
wait "$MONAD_INPUT_DRAIN_PID"
monad_terminal_unlock
printf 'restored\\n' >&2
`
  );

  try {
    const child = Bun.spawn(['sh', shellPath, terminalPath, sttyLogPath, drainedInputPath], {
      stdout: 'pipe',
      stderr: 'pipe'
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ]);
    const [sttyLog, drainedInput] = await Promise.all([
      readFile(sttyLogPath, 'utf8'),
      readFile(drainedInputPath, 'utf8')
    ]);
    const output = `${stdout}${stderr}`;

    expect(exitCode).toBe(0);
    expect(output).toContain('\x1b[?25llocked');
    expect(output).toContain('\x1b[?25hrestored');
    expect(sttyLog).toBe('-echo -icanon min 1 time 0\nsaved-state\n');
    expect(drainedInput).toBe('\x1b[A');
    // behavior-ok: the terminal guard consumes the injected direction key before restoring the TTY
    expect(output).not.toContain('^[[A');
    expect(output).not.toContain('\x1b[A');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
