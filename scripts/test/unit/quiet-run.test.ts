import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const script = resolve(import.meta.dir, '../../quiet-run.ts');

async function runQuiet(args: string[]) {
  const child = Bun.spawn([process.execPath, script, process.execPath, '-e', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...Bun.env, MONAD_QUALITY_LOUD: '0' }
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  return { stdout, stderr, exitCode };
}

test('successful commands produce no output', async () => {
  const result = await runQuiet(["process.stdout.write('pass output'); process.stderr.write('pass error')"]);

  expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
});

test('failed commands emit their combined diagnostics and preserve the exit code', async () => {
  const result = await runQuiet([
    "process.stdout.write('failure output\\n'); process.stderr.write('failure error\\n'); process.exit(7)"
  ]);

  expect(result).toEqual({
    stdout: '',
    stderr: 'failure output\nfailure error\n',
    exitCode: 7
  });
});

test('loud commands stream output and mark nested quality commands as loud', async () => {
  const result = await runQuiet([
    "process.stdout.write('loud=' + Bun.env.MONAD_QUALITY_LOUD + '\\n'); process.stderr.write('debug\\n')",
    '--loud'
  ]);

  expect(result).toEqual({
    stdout: 'loud=1\n',
    stderr: 'debug\n',
    exitCode: 0
  });
});
