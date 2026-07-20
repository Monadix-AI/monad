import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', '..', 'mesh-fixture.ts');

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'monad-mesh-fixture-'));
  directories.push(dir);
  return dir;
}

async function run(input: string, output: string, ...flags: string[]) {
  const proc = Bun.spawn(['bun', SCRIPT, input, output, ...flags], { stdout: 'pipe', stderr: 'pipe' });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { stderr, exitCode };
}

test('a verbatim capture is redacted into a fixture at the requested path', async () => {
  const dir = await workDir();
  const input = join(dir, 'capture.raw.json');
  await Bun.write(
    input,
    JSON.stringify({
      provider: 'codex',
      page: {
        coverage: 'settled',
        records: [
          { data: { type: 'turn_context', payload: { cwd: '/Users/zeke/private-repo', api_key: 'sk-live-abc123' } } },
          { data: { type: 'event_msg', payload: { type: 'agent_message', message: 'deploying to prod' } } }
        ]
      }
    })
  );
  const output = join(dir, 'fixture.raw.json');

  const { exitCode } = await run(input, output);

  expect({ exitCode, fixture: await Bun.file(output).json() }).toEqual({
    exitCode: 0,
    fixture: {
      provider: 'codex',
      page: {
        coverage: 'settled',
        records: [
          { data: { type: 'turn_context', payload: { cwd: '<path:1>', api_key: '<secret:1>' } } },
          { data: { type: 'event_msg', payload: { type: 'agent_message', message: '<text:1>' } } }
        ]
      }
    }
  });
});

test('newline-delimited provider records are accepted when a provider is named', async () => {
  const dir = await workDir();
  const input = join(dir, 'rollout.jsonl');
  await Bun.write(
    input,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/zeke/repo' } })}\n${JSON.stringify({ type: 'event_msg', payload: { message: 'hello' } })}\n`
  );
  const output = join(dir, 'fixture.raw.json');

  const { exitCode } = await run(input, output, '--provider', 'codex');

  expect({ exitCode, fixture: await Bun.file(output).json() }).toEqual({
    exitCode: 0,
    fixture: {
      provider: 'codex',
      page: {
        coverage: 'settled',
        records: [
          { data: { type: 'session_meta', payload: { cwd: '<path:1>' } } },
          { data: { type: 'event_msg', payload: { message: '<text:1>' } } }
        ]
      }
    }
  });
});

test('newline-delimited input without a provider is rejected before anything is written', async () => {
  const dir = await workDir();
  const input = join(dir, 'rollout.jsonl');
  await Bun.write(input, `${JSON.stringify({ type: 'event_msg', payload: { message: 'hello' } })}\n`);
  const output = join(dir, 'fixture.raw.json');

  const { exitCode, stderr } = await run(input, output);

  expect({
    exitCode,
    reported: stderr.includes('needs --provider'),
    wrote: await Bun.file(output).exists()
  }).toEqual({ exitCode: 2, reported: true, wrote: false });
});
