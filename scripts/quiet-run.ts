import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const inputArgs = Bun.argv.slice(2);
const loud = inputArgs.includes('--loud') || Bun.env.MONAD_QUALITY_LOUD === '1';
const command = inputArgs.filter((arg) => arg !== '--loud');

if (command.length === 0) {
  process.stderr.write('usage: bun scripts/quiet-run.ts <command> [...args] [--loud]\n');
  process.exit(2);
}

if (loud) {
  const child = Bun.spawn(command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...Bun.env, MONAD_QUALITY_LOUD: '1' }
  });
  process.exit(await child.exited);
}

const tempDir = mkdtempSync(join(tmpdir(), 'monad-quiet-run-'));
const outputPath = join(tempDir, 'output.log');
const output = openSync(outputPath, 'w');
let outputOpen = true;
let exitCode = 1;

try {
  const child = Bun.spawn(command, {
    stdin: 'inherit',
    stdout: output,
    stderr: output,
    env: { ...Bun.env, MONAD_QUALITY_LOUD: '0' }
  });
  exitCode = await child.exited;
  closeSync(output);
  outputOpen = false;

  if (exitCode !== 0) {
    const failureOutput = readFileSync(outputPath);
    if (failureOutput.byteLength > 0) {
      process.stderr.write(failureOutput);
    } else {
      process.stderr.write(`[quiet-run] ${command.join(' ')} exited with code ${exitCode}\n`);
    }
  }
} finally {
  if (outputOpen) closeSync(output);
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(exitCode);
