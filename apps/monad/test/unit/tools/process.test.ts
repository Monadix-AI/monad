import type { SandboxLauncher } from '@monad/sdk-atom';
import type { ToolContext } from '#/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearProcesses,
  clearProcessesForSession,
  configureSandboxLauncher,
  configureSandboxNet,
  expireFinishedProcessesForTests,
  noneLauncher,
  processControlTool,
  shellExecTool
} from '#/capabilities/tools';
import { invokeTool } from '#/capabilities/tools/invoke.ts';

const ctx: ToolContext = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };
const ctxB: ToolContext = { sessionId: 's2', sandboxRoots: undefined, log: () => {} };
const fakeLauncher: SandboxLauncher = {
  kind: 'fake-os-sandbox',
  descriptor: { name: 'Fake OS sandbox' },
  wrap: (argv) => argv
};
const approvalEquivalentLauncher: SandboxLauncher = {
  kind: 'fake-approval-equivalent-sandbox',
  descriptor: { name: 'Fake approval equivalent sandbox' },
  enforces: { readDeny: true, net: ['none'] },
  wrap: (argv) => argv
};

const controlProcess = async (...args: Parameters<typeof processControlTool.run>) =>
  (await processControlTool.run(...args)).metadata;

type BackgroundStartInput = {
  command: string;
  cwd?: string;
  terminalMode?: 'pty' | 'pipe';
  cols?: number;
  rows?: number;
  idleTimeoutMs?: number;
  maxRuntimeMs?: number;
};

async function startProcess(input: BackgroundStartInput, c: ToolContext) {
  const result = (await shellExecTool.run({ ...input, mode: 'background' }, c)).metadata;
  if (result.status !== 'running') throw new Error('shell_exec did not start a background process');
  return { id: result.processId, pid: result.pid, mode: result.mode };
}

async function readProcessLogs(
  input: { id: string; cursor?: { stdout?: number; stderr?: number }; stripAnsi?: boolean },
  c: ToolContext
) {
  const result = await controlProcess({ action: 'logs', ...input }, c);
  if (!('status' in result)) throw new Error('process_control logs did not return a process snapshot');
  return result;
}

async function waitProcess(
  input: {
    id: string;
    pattern?: string;
    match?: 'literal' | 'regex';
    stripAnsi?: boolean;
    timeoutMs?: number;
    cursor?: { stdout?: number; stderr?: number };
  },
  c: ToolContext
) {
  const result = await controlProcess({ action: 'wait', ...input }, c);
  if (!('matched' in result)) throw new Error('process_control wait did not return a wait result');
  return result;
}

async function listProcesses(c: ToolContext) {
  const result = await controlProcess({ action: 'list' }, c);
  if (!('processes' in result)) throw new Error('process_control list did not return a process list');
  return result;
}

async function listProcessesByStatus(status: 'running' | 'exited' | 'killed', c: ToolContext) {
  const result = await controlProcess({ action: 'list', status }, c);
  if (!('processes' in result)) throw new Error('process_control list did not return a process list');
  return result;
}

const killProcess = (input: { id: string }, c: ToolContext) => controlProcess({ action: 'stop', ...input }, c);

afterEach(() => {
  clearProcesses();
  configureSandboxLauncher(noneLauncher);
  configureSandboxNet('unrestricted');
});

async function waitForExit(id: string, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const r = await readProcessLogs({ id }, ctx);
    if (r.status !== 'running' || Date.now() - start > ms) return r;
    await Bun.sleep(20);
  }
}

/** Poll stdout until it contains `needle` (or timeout). Avoids racy fixed sleeps on slow CI. */
async function waitForStdout(id: string, needle: string, ms = 5000) {
  const start = Date.now();
  for (;;) {
    const r = await readProcessLogs({ id }, ctx);
    if (r.stdout.includes(needle) || Date.now() - start > ms) return r;
    await Bun.sleep(20);
  }
}

test('shell_exec background is high-risk (gated)', () => {
  expect(shellExecTool.highRisk).toBe(true);
});

test('shell_exec background still requires primary approval when the active sandbox is read or network permissive', async () => {
  configureSandboxLauncher(fakeLauncher);
  await expect(
    invokeTool(
      shellExecTool,
      { command: 'bun -e "console.log(7)"', cwd: process.cwd(), terminalMode: 'pipe', mode: 'background' },
      { sessionId: 's1', sandboxRoots: [process.cwd()], log: () => {} }
    )
  ).rejects.toThrow(/requires an approval gate/);
});

test('shell_exec background skips primary approval only when the active sandbox enforces read-deny and egress', async () => {
  configureSandboxLauncher(approvalEquivalentLauncher);
  configureSandboxNet('none');
  const out = await invokeTool(
    shellExecTool,
    { command: 'bun -e "console.log(7)"', cwd: process.cwd(), terminalMode: 'pipe', mode: 'background' },
    { sessionId: 's1', sandboxRoots: [process.cwd()], log: () => {} }
  );
  expect(out.metadata.status).toBe('running');
  if (out.metadata.status !== 'running') throw new Error('shell_exec did not start a background process');
  expect(out.metadata.processId).toMatch(/^proc_/);
  const r = await waitForExit(out.metadata.processId);
  expect(r.exitCode).toBe(0);
});

test('shell_exec background secondary gate allow expands roots and starts outside cwd', async () => {
  configureSandboxLauncher(fakeLauncher);
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'monad-process-out-')));
  const calls: { key?: string; tool: string }[] = [];
  try {
    const c: ToolContext = {
      ...ctx,
      sandboxRoots: [process.cwd()],
      gate: async (req) => {
        calls.push({ tool: req.tool, key: req.key });
        return { allow: true };
      }
    };
    const { id } = await startProcess({ command: 'pwd', cwd: outside, terminalMode: 'pipe' }, c);
    const r = await waitForExit(id);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(outside);
    expect(calls).toEqual([{ tool: 'path_access', key: `cwd:${outside}` }]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('start → captures stdout and exit code of a short process', async () => {
  const { id } = await startProcess({ command: 'bun -e "console.log(42)"', terminalMode: 'pipe' }, ctx);
  expect(id).toMatch(/^proc_/);
  const r = await waitForExit(id);
  expect(r.status).toBe('exited');
  expect(r.exitCode).toBe(0);
  expect(r.mode).toBe('pipe');
});

// Interactive PTY tests are Windows-skipped: Bun's terminal/PTY (ConPTY) mode does not capture
// output or deliver interactive stdin on Windows, so a `read`-driven prompt never round-trips
// there — consistent with the pty size/resize, signal, and process-group tests already gated
// below. Pipe-mode shell_exec background (the common path) is exercised cross-platform above.
test.skipIf(process.platform === 'win32')('start defaults to a pty and can answer an interactive prompt', async () => {
  const { id } = await startProcess(
    {
      command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans'
    },
    ctx
  );
  await waitForStdout(id, 'Proceed?');
  await controlProcess({ action: 'write', id, input: 'y\n' }, ctx);
  const r = await waitForExit(id);
  expect(r.status).toBe('exited');
  expect(r.exitCode).toBe(0);
  expect(r.mode).toBe('pty');
});

test.skipIf(process.platform === 'win32')('wait returns when output contains a literal pattern', async () => {
  const { id } = await startProcess(
    {
      command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans'
    },
    ctx
  );
  const prompt = await waitProcess({ id, pattern: 'Proceed?', timeoutMs: 1000 }, ctx);
  expect(prompt.matched).toBe(true);
  expect(prompt.timedOut).toBe(false);
  expect(prompt.status).toBe('running');
  await controlProcess({ action: 'write', id, input: 'y\n' }, ctx);
  const answer = await waitProcess({ id, pattern: 'answer:y', timeoutMs: 1000 }, ctx);
  expect(answer.matched).toBe(true);
});

test.skipIf(process.platform === 'win32')('wait supports regex matching', async () => {
  const { id } = await startProcess(
    {
      command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans'
    },
    ctx
  );
  await waitProcess({ id, pattern: 'Proceed\\?', match: 'regex', timeoutMs: 1000 }, ctx);
  await controlProcess({ action: 'write', id, input: 'y\n' }, ctx);
  const answer = await waitProcess({ id, pattern: 'answer:[yn]', match: 'regex', timeoutMs: 1000 }, ctx);
  expect(answer.matched).toBe(true);
});

test('logs and wait can strip ANSI sequences', async () => {
  const { id } = await startProcess(
    {
      command: 'printf "\\033[31mREADY\\033[0m\\n"',
      terminalMode: 'pipe'
    },
    ctx
  );
  const waited = await waitProcess({ id, pattern: 'READY', match: 'regex', stripAnsi: true, timeoutMs: 1000 }, ctx);
  expect(waited.matched).toBe(true);
  expect(waited.stdout).toContain('READY');
  expect(waited.stdout).not.toContain('\x1b');
  const raw = await readProcessLogs({ id }, ctx);
  const stripped = await readProcessLogs({ id, stripAnsi: true }, ctx);
  expect(raw.stdout).toContain('\x1b[31m');
  expect(stripped.stdout).toContain('READY');
  expect(stripped.stdout).not.toContain('\x1b');
});

test.skipIf(process.platform === 'win32')('write supports structured keys', async () => {
  const { id } = await startProcess(
    {
      command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans'
    },
    ctx
  );
  await waitProcess({ id, pattern: 'Proceed?', timeoutMs: 1000 }, ctx);
  await controlProcess({ action: 'write', id, input: 'y', key: 'enter' }, ctx);
  const answer = await waitProcess({ id, pattern: 'answer:y', timeoutMs: 1000 }, ctx);
  expect(answer.matched).toBe(true);
});

test('wait can wait for process exit without a pattern', async () => {
  const { id } = await startProcess({ command: 'bun -e "console.log(42)"', terminalMode: 'pipe' }, ctx);
  const r = await waitProcess({ id, timeoutMs: 1000 }, ctx);
  expect(r.matched).toBe(true);
  expect(r.timedOut).toBe(false);
  expect(r.status).toBe('exited');
  expect(r.exitCode).toBe(0);
});

test('logs can read only output after a cursor', async () => {
  const { id } = await startProcess(
    {
      command: 'bun -e "console.log(1); setTimeout(() => console.log(2), 80)"',
      terminalMode: 'pipe'
    },
    ctx
  );
  const first = await waitProcess({ id, pattern: '1', timeoutMs: 1000 }, ctx);
  const second = await waitProcess({ id, pattern: '2', timeoutMs: 1000 }, ctx);
  const delta = await readProcessLogs({ id, cursor: first.cursor }, ctx);
  expect(delta.cursor.stdout).toBe(second.cursor.stdout);
});

test('wait can return output after a cursor', async () => {
  const { id } = await startProcess(
    {
      command: 'bun -e "console.log(1); setTimeout(() => console.log(2), 80)"',
      terminalMode: 'pipe'
    },
    ctx
  );
  const first = await waitProcess({ id, pattern: '1', timeoutMs: 1000 }, ctx);
  const second = await waitProcess({ id, pattern: '2', timeoutMs: 1000, cursor: first.cursor }, ctx);
  expect(second.stdout.trim()).toContain('2');
  expect(second.stderr).toBe('');
});

test('idle timeout kills a quiet process', async () => {
  const { id } = await startProcess(
    {
      command: 'bun -e "setInterval(() => {}, 1000)"',
      terminalMode: 'pipe',
      idleTimeoutMs: 50
    },
    ctx
  );
  const r = await waitProcess({ id, timeoutMs: 1000 }, ctx);
  expect(r.status).toBe('killed');
});

test('max runtime kills a long-running process', async () => {
  const { id } = await startProcess(
    {
      command: 'bun -e "setInterval(() => console.log(Date.now()), 10)"',
      terminalMode: 'pipe',
      maxRuntimeMs: 50
    },
    ctx
  );
  const r = await waitProcess({ id, timeoutMs: 1000 }, ctx);
  expect(r.status).toBe('killed');
  expect(r.stderr).toContain('max runtime');
});

test('session abort kills a background process', async () => {
  const controller = new AbortController();
  const abortCtx: ToolContext = { ...ctx, signal: controller.signal };
  const { id } = await startProcess(
    {
      command: 'bun -e "setInterval(() => console.log(Date.now()), 10)"',
      terminalMode: 'pipe'
    },
    abortCtx
  );

  controller.abort();
  const r = await waitProcess({ id, timeoutMs: 1000 }, ctx);
  expect(r.status).toBe('killed');
  expect(r.stderr).toContain('session abort');
});

test.skipIf(process.platform === 'win32')('start can set initial pty size and resize can change it', async () => {
  const { id } = await startProcess(
    {
      command: 'stty size; sleep 0.2; stty size',
      cols: 111,
      rows: 33
    },
    ctx
  );
  await waitForStdout(id, '33 111');
  await controlProcess({ action: 'resize', id, cols: 100, rows: 30 }, ctx);
  const r = await waitForExit(id);
  expect(r.mode).toBe('pty');
});

test.skipIf(process.platform === 'win32')('signal sends SIGINT to a process group', async () => {
  const { id } = await startProcess(
    {
      command: 'trap "echo got-int; exit 0" INT; echo ready; while true; do sleep 1; done',
      terminalMode: 'pipe'
    },
    ctx
  );
  await waitProcess({ id, pattern: 'ready', timeoutMs: 1000 }, ctx);
  await controlProcess({ action: 'signal', id, signal: 'SIGINT' }, ctx);
  const r = await waitProcess({ id, pattern: 'got-int', timeoutMs: 1000 }, ctx);
  expect(r.matched).toBe(true);
});

test('resize rejects non-pty processes', async () => {
  const { id } = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', terminalMode: 'pipe' }, ctx);
  await expect(controlProcess({ action: 'resize', id, cols: 100, rows: 30 }, ctx)).rejects.toThrow(/not pty-backed/);
  await killProcess({ id }, ctx);
});

test('list shows a running process; kill stops it', async () => {
  const { id } = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', terminalMode: 'pipe' }, ctx);
  const listed = (await listProcesses(ctx)).processes;
  expect(listed.some((p) => p.id === id && p.status === 'running')).toBe(true);

  expect(await killProcess({ id }, ctx)).toEqual({ ok: true });
  expect((await readProcessLogs({ id }, ctx)).status).toBe('killed');
});

test('list filters by process status and includes start metadata', async () => {
  const cwd = process.cwd();
  const short = await startProcess({ command: 'bun -e "console.log(1)"', cwd, terminalMode: 'pipe' }, ctx);
  const long = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', cwd, terminalMode: 'pipe' }, ctx);
  await waitForExit(short.id);

  const running = (await listProcessesByStatus('running', ctx)).processes;
  expect(running.map((p) => p.id)).toEqual([long.id]);
  expect(running[0]).toMatchObject({
    id: long.id,
    command: 'bun -e "setInterval(() => {}, 1000)"',
    cwd,
    status: 'running',
    mode: 'pipe',
    limits: {}
  });
  expect(Date.parse(running[0]?.startedAt ?? '')).toBeGreaterThan(0);

  const exited = (await listProcessesByStatus('exited', ctx)).processes;
  expect(exited.map((p) => p.id)).toEqual([short.id]);

  await killProcess({ id: long.id }, ctx);
});

test('finished process entries are pruned after retention expires', async () => {
  const { id } = await startProcess({ command: 'bun -e "console.log(1)"', terminalMode: 'pipe' }, ctx);
  await waitForExit(id);
  expireFinishedProcessesForTests(31 * 60 * 1000);

  expect((await listProcesses(ctx)).processes.map((p) => p.id)).toEqual([]);
  await expect(readProcessLogs({ id }, ctx)).rejects.toThrow(/unknown process/);
});

test('process_control drives the background process lifecycle through one tool', async () => {
  const { id } = await startProcess(
    {
      command:
        "bun -e \"process.stdin.on('data', d => console.log('got:' + d.toString().trim())); console.log('ready'); setInterval(() => {}, 1000)\"",
      terminalMode: 'pipe'
    },
    ctx
  );
  const ready = await controlProcess({ action: 'wait', id, pattern: 'ready', timeoutMs: 1000 }, ctx);
  if (!('cursor' in ready)) throw new Error('process_control wait did not return a process snapshot');
  expect(ready).toMatchObject({ matched: true, status: 'running' });

  const listed = await controlProcess({ action: 'list' }, ctx);
  if (!('processes' in listed)) throw new Error('process_control list did not return a process list');
  expect(listed.processes.some((p) => p.id === id && p.status === 'running')).toBe(true);

  await controlProcess({ action: 'write', id, input: 'ping\n' }, ctx);
  const got = await controlProcess({ action: 'wait', id, pattern: 'got:ping', timeoutMs: 1000 }, ctx);
  expect(got).toMatchObject({ matched: true, timedOut: false });

  const delta = await controlProcess({ action: 'logs', id, cursor: ready.cursor }, ctx);
  if (!('stdout' in delta)) throw new Error('process_control logs did not return a process snapshot');
  expect(delta.stdout).toContain('got:ping');

  await controlProcess({ action: 'stop', id }, ctx);
  const stopped = await controlProcess({ action: 'logs', id }, ctx);
  if (!('status' in stopped)) throw new Error('process_control logs did not return a process snapshot');
  expect(stopped.status).toBe('killed');
});

test('write feeds the process stdin', async () => {
  // The child prints `ready` once its stdin listener is attached, so we never write before it can
  // receive (which would drop the data) — deterministic instead of a fixed sleep that's racy on
  // slow CI runners.
  const { id } = await startProcess(
    {
      command:
        "bun -e \"process.stdin.on('data', d => console.log('got:' + d.toString().trim())); console.log('ready')\"",
      terminalMode: 'pipe'
    },
    ctx
  );
  await waitForStdout(id, 'ready');
  await controlProcess({ action: 'write', id, input: 'ping\n' }, ctx);
  await killProcess({ id }, ctx);
});

test('logs/kill on an unknown id throws', async () => {
  try {
    await readProcessLogs({ id: 'proc-nope' }, ctx);
    throw new Error('unknown process id returned logs');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/unknown process/);
  }
});

test('write to a finished process throws', async () => {
  const { id } = await startProcess({ command: 'bun -e "console.log(1)"', terminalMode: 'pipe' }, ctx);
  await waitForExit(id);
  try {
    await controlProcess({ action: 'write', id, input: 'x' }, ctx);
    throw new Error('write to a finished process succeeded');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not running/);
  }
});

test('wait reports invalid regex with a stable error code', async () => {
  const { id } = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', terminalMode: 'pipe' }, ctx);
  try {
    await waitProcess({ id, pattern: '[', match: 'regex', timeoutMs: 1000 }, ctx);
    throw new Error('invalid regex was accepted');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/invalid process_control wait regex/);
  } finally {
    await killProcess({ id }, ctx);
  }
});

test('a session cannot see or control another session’s processes', async () => {
  const { id } = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', terminalMode: 'pipe' }, ctx);

  // Not visible in the other session's list.
  expect((await listProcesses(ctxB)).processes.some((p) => p.id === id)).toBe(false);

  // logs/write/kill from the other session look exactly like an unknown id — no existence leak.
  const unknown = /unknown process/;
  await expect(readProcessLogs({ id }, ctxB)).rejects.toThrow(unknown);
  await expect(controlProcess({ action: 'write', id, input: 'x' }, ctxB)).rejects.toThrow(unknown);
  await expect(killProcess({ id }, ctxB)).rejects.toThrow(unknown);

  // Owner is unaffected: still running.
  expect((await readProcessLogs({ id }, ctx)).status).toBe('running');
  await killProcess({ id }, ctx);
});

test.skipIf(process.platform === 'win32')('kill reaps the whole process group (grandchildren die too)', async () => {
  // The shell forks a grandchild (sleep) and prints its pid, then waits. Killing only the
  // direct child would orphan the grandchild; killTree signals the group so it dies too.
  const { id } = await startProcess({ command: 'sleep 30 & echo "gpid:$!"; wait', terminalMode: 'pipe' }, ctx);
  const out = await waitForStdout(id, 'gpid:');
  const gpid = Number(out.stdout.match(/gpid:(\d+)/)?.[1]);
  expect(gpid).toBeGreaterThan(0);

  await killProcess({ id }, ctx);
  // Give the group signal a moment to reach the grandchild.
  await Bun.sleep(300);
  // process.kill(pid, 0) throws ESRCH once the grandchild is gone.
  expect(() => process.kill(gpid, 0)).toThrow();
});

test('clearProcessesForSession kills only that session’s processes', async () => {
  const a = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', terminalMode: 'pipe' }, ctx);
  const b = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', terminalMode: 'pipe' }, ctxB);

  clearProcessesForSession('s1');

  // s1's process is gone from the registry entirely (unknown to its owner now).
  await expect(readProcessLogs({ id: a.id }, ctx)).rejects.toThrow(/unknown process/);
  // s2's process survives.
  expect((await readProcessLogs({ id: b.id }, ctxB)).status).toBe('running');
  await killProcess({ id: b.id }, ctxB);
});
