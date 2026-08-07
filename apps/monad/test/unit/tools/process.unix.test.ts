import type { ToolContext } from '#/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';

import { clearProcesses, processControlTool, shellExecTool } from '#/capabilities/tools';
import { waitFor } from '../../wait.ts';

const ctx: ToolContext = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };

const controlProcess = async (...args: Parameters<typeof processControlTool.run>) =>
  (await processControlTool.run(...args)).metadata;

async function startProcess(input: { command: string; terminalMode?: 'pty' | 'pipe'; cols?: number; rows?: number }) {
  const result = (await shellExecTool.run({ ...input, mode: 'background' }, ctx)).metadata;
  if (result.status !== 'running') throw new Error('shell_exec did not start a background process');
  return { id: result.processId, mode: result.mode };
}

async function readProcessLogs(id: string) {
  const result = await controlProcess({ action: 'logs', id }, ctx);
  if (!('status' in result)) throw new Error('process_control logs did not return a process snapshot');
  return result;
}

async function waitProcess(input: { id: string; pattern: string; match?: 'literal' | 'regex'; timeoutMs?: number }) {
  const result = await controlProcess({ action: 'wait', ...input }, ctx);
  if (!('matched' in result)) throw new Error('process_control wait did not return a wait result');
  return result;
}

async function waitForExit(id: string, timeoutMs = 3000) {
  const startedAt = Date.now();
  for (;;) {
    const result = await readProcessLogs(id);
    if (result.status !== 'running' || Date.now() - startedAt > timeoutMs) return result;
    await Bun.sleep(20);
  }
}

async function waitForStdout(id: string, needle: string, timeoutMs = 5000) {
  const startedAt = Date.now();
  for (;;) {
    const result = await readProcessLogs(id);
    if (result.stdout.includes(needle) || Date.now() - startedAt > timeoutMs) return result;
    await Bun.sleep(20);
  }
}

afterEach(() => clearProcesses());

test('start defaults to a pty and can answer an interactive prompt', async () => {
  const { id } = await startProcess({ command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans' });
  await waitForStdout(id, 'Proceed?');
  await controlProcess({ action: 'write', id, input: 'y\n' }, ctx);
  const result = await waitForExit(id);
  expect({ status: result.status, exitCode: result.exitCode, mode: result.mode }).toEqual({
    status: 'exited',
    exitCode: 0,
    mode: 'pty'
  });
});

test('wait returns when output contains a literal pattern', async () => {
  const { id } = await startProcess({ command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans' });
  const prompt = await waitProcess({ id, pattern: 'Proceed?', timeoutMs: 1000 });
  expect({ matched: prompt.matched, timedOut: prompt.timedOut, status: prompt.status }).toEqual({
    matched: true,
    timedOut: false,
    status: 'running'
  });
  await controlProcess({ action: 'write', id, input: 'y\n' }, ctx);
  expect((await waitProcess({ id, pattern: 'answer:y', timeoutMs: 1000 })).matched).toBe(true);
});

test('wait supports regex matching', async () => {
  const { id } = await startProcess({ command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans' });
  await waitProcess({ id, pattern: 'Proceed\\?', match: 'regex', timeoutMs: 1000 });
  await controlProcess({ action: 'write', id, input: 'y\n' }, ctx);
  expect((await waitProcess({ id, pattern: 'answer:[yn]', match: 'regex', timeoutMs: 1000 })).matched).toBe(true);
});

test('write supports structured keys', async () => {
  const { id } = await startProcess({ command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans' });
  await waitProcess({ id, pattern: 'Proceed?', timeoutMs: 1000 });
  await controlProcess({ action: 'write', id, input: 'y', key: 'enter' }, ctx);
  expect((await waitProcess({ id, pattern: 'answer:y', timeoutMs: 1000 })).matched).toBe(true);
});

test('start can set initial pty size and resize can change it', async () => {
  const { id } = await startProcess({ command: 'stty size; sleep 0.2; stty size', cols: 111, rows: 33 });
  await waitForStdout(id, '33 111');
  await controlProcess({ action: 'resize', id, cols: 100, rows: 30 }, ctx);
  expect((await waitForExit(id)).mode).toBe('pty');
});

test('signal sends SIGINT to a process group', async () => {
  const { id } = await startProcess({
    command: 'trap "echo got-int; exit 0" INT; echo ready; while true; do sleep 1; done',
    terminalMode: 'pipe'
  });
  await waitProcess({ id, pattern: 'ready', timeoutMs: 1000 });
  await controlProcess({ action: 'signal', id, signal: 'SIGINT' }, ctx);
  expect((await waitProcess({ id, pattern: 'got-int', timeoutMs: 1000 })).matched).toBe(true);
});

test('kill reaps the whole process group (grandchildren die too)', async () => {
  const { id } = await startProcess({ command: 'sleep 30 & echo "gpid:$!"; wait', terminalMode: 'pipe' });
  const output = await waitForStdout(id, 'gpid:');
  const grandchildPid = Number(output.stdout.match(/gpid:(\d+)/)?.[1]);
  expect(grandchildPid).toBeGreaterThan(0);
  await controlProcess({ action: 'stop', id }, ctx);
  await waitFor(
    () => {
      try {
        process.kill(grandchildPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    { message: 'grandchild survived the group kill' }
  );
  expect(() => process.kill(grandchildPid, 0)).toThrow();
});
