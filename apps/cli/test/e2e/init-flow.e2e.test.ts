import { expect, test } from 'bun:test';

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
  const proc = Bun.spawn(['bun', `${import.meta.dir}/init-flow-child.ts`, 'retry'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: new URL('../../..', import.meta.url).pathname
  });
  const stderrPromise = collect(proc.stderr);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = '';
  let stepIndex = 0;
  let searchFrom = 0;

  const deadline = Date.now() + 10_000;
  while (!stdout.includes('RESULT:')) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for child output:\n${stdout}`);
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(250).then(() => ({ done: false, value: undefined as Uint8Array | undefined }))
    ]);
    if (next.value) stdout += decoder.decode(next.value, { stream: true });
    while (stepIndex < steps.length && stdout.slice(searchFrom).includes(steps[stepIndex]?.waitFor ?? '')) {
      const step = steps[stepIndex];
      if (step) {
        proc.stdin.write(step.write);
        await proc.stdin.flush();
      }
      stepIndex++;
      searchFrom = stdout.length;
    }
    if (next.done) break;
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
    { waitFor: 'Connection test failed', write: '1\n' },
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
});

test('cli init provider subprocess can go back after failed connection', async () => {
  const { stdout, stderr, exitCode } = await runChild([
    { waitFor: 'Select [1-2]: ', write: '1\n' },
    { waitFor: 'API key', write: 'bad-key\n' },
    { waitFor: 'Connection test failed', write: '2\n' },
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
});
