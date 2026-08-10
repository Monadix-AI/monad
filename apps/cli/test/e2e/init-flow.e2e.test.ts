import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveBunExecutable(): string {
  const executable = [
    Bun.which('bun'),
    process.execPath,
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .map((directory) => join(directory, process.platform === 'win32' ? 'bun.exe' : 'bun'))
  ].find((candidate): candidate is string =>
    Boolean(candidate && !candidate.toLowerCase().includes('bun-node-') && existsSync(candidate))
  );
  if (!executable) throw new Error('Bun executable is required');
  return executable;
}

async function collect(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    out += decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function runChild(
  steps: Array<{ waitFor: string; write: string }>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([resolveBunExecutable(), `${import.meta.dir}/init-flow-child.ts`, 'retry'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: fileURLToPath(new URL('../../..', import.meta.url))
  });
  const stderrPromise = collect(proc.stderr);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = '';
  let stepIndex = 0;
  let searchFrom = 0;
  let pendingRead = reader.read();

  const deadline = Date.now() + 20_000;
  while (!stdout.includes('RESULT:')) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`timed out waiting for child output:\n${stdout}`);
    }
    const next = await Promise.race([
      pendingRead.then((result) => ({ kind: 'read' as const, result })),
      // biome-ignore lint/plugin: race arm that resolves rather than rejects, so an unmet condition still fails on the assertion below instead of hanging.
      Bun.sleep(250).then(() => ({ kind: 'tick' as const }))
    ]);
    if (next.kind === 'tick') continue;
    if (next.result.value) stdout += decoder.decode(next.result.value, { stream: true });
    while (stepIndex < steps.length && stdout.slice(searchFrom).includes(steps[stepIndex]?.waitFor ?? '')) {
      const step = steps[stepIndex];
      if (step) {
        proc.stdin.write(step.write);
        await proc.stdin.flush();
      }
      stepIndex++;
      searchFrom = stdout.length;
    }
    if (next.result.done) break;
    pendingRead = reader.read();
  }
  proc.stdin.end();
  stdout += decoder.decode();
  const [stderr, exitCode] = await Promise.all([stderrPromise, proc.exited]);
  return { stdout, stderr, exitCode };
}

function parseResult(stdout: string): { result: { label: string }; calls: string[] } {
  const line = stdout
    .split('\n')
    .find((entry) => entry.startsWith('RESULT:'))
    ?.slice('RESULT:'.length);
  if (!line) throw new Error(`missing RESULT line in stdout:\n${stdout}`);
  return JSON.parse(line);
}

test('cli init provider subprocess stays interactive after failed connection and retries', async () => {
  const { stdout, stderr, exitCode } = await runChild([
    { waitFor: 'Select [1-2]: ', write: '1\n' },
    { waitFor: 'API key', write: 'bad-key\n' },
    { waitFor: 'Back to provider selection\nSelect [1-2]: ', write: '1\n' },
    { waitFor: 'API key', write: 'good-key\n' }
  ]);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  const result = parseResult(stdout);
  expect(result.result.label).toBe('OpenAI');
  expect(result.calls).toEqual([
    'test:openai:bad-key',
    'test:openai:good-key',
    expect.stringContaining('save:openai-')
  ]);
}, 25_000);

test('cli init provider subprocess can go back after failed connection', async () => {
  const { stdout, stderr, exitCode } = await runChild([
    { waitFor: 'Select [1-2]: ', write: '1\n' },
    { waitFor: 'API key', write: 'bad-key\n' },
    { waitFor: 'Back to provider selection\nSelect [1-2]: ', write: '2\n' },
    { waitFor: 'Select [1-2]: ', write: '2\n' },
    { waitFor: 'API key', write: 'good-key\n' }
  ]);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  const result = parseResult(stdout);
  expect(result.result.label).toBe('Anthropic');
  expect(result.calls).toEqual([
    'test:openai:bad-key',
    'test:anthropic:good-key',
    expect.stringContaining('save:anthropic-')
  ]);
}, 25_000);
