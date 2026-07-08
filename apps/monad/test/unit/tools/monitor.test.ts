import type { ToolContext, ToolGateRequest } from '#/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearProcesses, monitorWatchTool, shellExecTool, ToolSecurityError } from '#/capabilities/tools';

const ctx = (roots?: string[]): ToolContext => ({ sessionId: 's1', sandboxRoots: roots, log: () => {} });

afterEach(() => {
  clearProcesses();
});

async function startBackground(command: string) {
  const result = (await shellExecTool.run({ command, mode: 'background', terminalMode: 'pipe' }, ctx())).metadata;
  if (result.status !== 'running') throw new Error('shell_exec did not start a background process');
  return result.processId;
}

test('monitor_watch waits for background process output', async () => {
  const id = await startBackground('bun -e "setTimeout(() => console.log(42), 30)"');
  const result = (await monitorWatchTool.run({ target: 'process', id, pattern: '42', timeoutMs: 1000 }, ctx()))
    .metadata;
  expect(result).toMatchObject({ target: 'process', id, matched: true, timedOut: false, reason: 'pattern' });
});

test('monitor_watch reports process timeout without killing it', async () => {
  const id = await startBackground('bun -e "setInterval(() => {}, 1000)"');
  const result = (await monitorWatchTool.run({ target: 'process', id, pattern: 'never', timeoutMs: 30 }, ctx()))
    .metadata;
  expect(result).toMatchObject({ target: 'process', id, matched: false, timedOut: true, reason: 'timeout' });
});

test('monitor_watch waits for file creation', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-monitor-exists-')));
  const path = join(dir, 'ready.txt');
  try {
    setTimeout(() => void writeFile(path, 'ready'), 30);
    const result = (
      await monitorWatchTool.run({ target: 'file', path, condition: 'exists', timeoutMs: 1000 }, ctx([dir]))
    ).metadata;
    expect(result).toMatchObject({ target: 'file', path, matched: true, timedOut: false, exists: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor_watch waits for file content to change', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-monitor-change-')));
  const path = join(dir, 'state.txt');
  try {
    await writeFile(path, 'one');
    setTimeout(() => void writeFile(path, 'two'), 30);
    const result = (
      await monitorWatchTool.run({ target: 'file', path, condition: 'changes', timeoutMs: 1000 }, ctx([dir]))
    ).metadata;
    expect(result).toMatchObject({ target: 'file', path, matched: true, changed: true, exists: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor_watch waits for file content pattern', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-monitor-contains-')));
  const path = join(dir, 'log.txt');
  try {
    await writeFile(path, 'booting');
    setTimeout(() => void writeFile(path, 'READY port=1234'), 30);
    const result = (
      await monitorWatchTool.run(
        { target: 'file', path, condition: 'contains', pattern: 'READY port=\\d+', match: 'regex', timeoutMs: 1000 },
        ctx([dir])
      )
    ).metadata;
    expect(result).toMatchObject({ target: 'file', path, matched: true, contains: true, exists: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor_watch reports invalid file regex with a stable error code', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-monitor-regex-')));
  const path = join(dir, 'log.txt');
  try {
    await writeFile(path, 'READY');
    await monitorWatchTool.run(
      { target: 'file', path, condition: 'contains', pattern: '[', match: 'regex', timeoutMs: 1000 },
      ctx([dir])
    );
    throw new Error('invalid monitor regex was accepted');
  } catch (err) {
    expect(err).toBeInstanceOf(ToolSecurityError);
    expect((err as Error).message).toContain('invalid monitor_watch regex');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor_watch file target uses shared path access gate', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'monad-monitor-gate-')));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  const path = join(outside, 'ready.txt');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path, 'ready');
  const calls: { key?: string; tool: string }[] = [];
  try {
    const result = (
      await monitorWatchTool.run(
        { target: 'file', path, condition: 'exists', timeoutMs: 1000 },
        {
          ...ctx([root]),
          gate: async (req: ToolGateRequest) => {
            calls.push({ tool: req.tool, key: req.key });
            return { allow: true };
          }
        }
      )
    ).metadata;
    expect(result).toMatchObject({ matched: true, exists: true });
    expect(calls).toEqual([{ tool: 'path_access', key: outside }]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('monitor_watch file target rejects escaped paths without a gate', async () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
  await expect(
    monitorWatchTool.run({ target: 'file', path: outside, condition: 'exists', timeoutMs: 10 }, ctx([process.cwd()]))
  ).rejects.toBeInstanceOf(ToolSecurityError);
});
