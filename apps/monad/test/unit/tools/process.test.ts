import type { ToolContext } from '@/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';

import {
  clearProcesses,
  clearProcessesForSession,
  processKillTool,
  processListTool,
  processLogsTool,
  processResizeTool,
  processSignalTool,
  processStartTool,
  processWaitTool,
  processWriteTool
} from '@/capabilities/tools';

const ctx: ToolContext = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };
const ctxB: ToolContext = { sessionId: 's2', sandboxRoots: undefined, log: () => {} };

const startProcess = async (...args: Parameters<typeof processStartTool.run>) =>
  (await processStartTool.run(...args)).metadata;
const processLogs = async (...args: Parameters<typeof processLogsTool.run>) =>
  (await processLogsTool.run(...args)).metadata;
const waitProcess = async (...args: Parameters<typeof processWaitTool.run>) =>
  (await processWaitTool.run(...args)).metadata;
const listProcesses = async (...args: Parameters<typeof processListTool.run>) =>
  (await processListTool.run(...args)).metadata;
const killProcess = async (...args: Parameters<typeof processKillTool.run>) =>
  (await processKillTool.run(...args)).metadata;

afterEach(() => clearProcesses());

async function waitForExit(id: string, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const r = await processLogs({ id }, ctx);
    if (r.status !== 'running' || Date.now() - start > ms) return r;
    await Bun.sleep(20);
  }
}

/** Poll stdout until it contains `needle` (or timeout). Avoids racy fixed sleeps on slow CI. */
async function waitForStdout(id: string, needle: string, ms = 5000) {
  const start = Date.now();
  for (;;) {
    const r = await processLogs({ id }, ctx);
    if (r.stdout.includes(needle) || Date.now() - start > ms) return r;
    await Bun.sleep(20);
  }
}

test('process_start is high-risk (gated)', () => {
  expect(processStartTool.highRisk).toBe(true);
});

test('start → captures stdout and exit code of a short process', async () => {
  const { id } = await startProcess({ command: 'bun -e "console.log(42)"', terminalMode: 'pipe' }, ctx);
  expect(id).toMatch(/^proc_/);
  const r = await waitForExit(id);
  expect(r.status).toBe('exited');
  expect(r.exitCode).toBe(0);
  expect(r.mode).toBe('pipe');
  expect(r.stdout).toContain('42');
});

test('start defaults to a pty and can answer an interactive prompt', async () => {
  const { id } = await startProcess(
    {
      command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans'
    },
    ctx
  );
  await waitForStdout(id, 'Proceed?');
  await processWriteTool.run({ id, input: 'y\n' }, ctx);
  const r = await waitForExit(id);
  expect(r.status).toBe('exited');
  expect(r.exitCode).toBe(0);
  expect(r.mode).toBe('pty');
  expect(r.stdout).toContain('answer:y');
  expect(r.stdout).not.toContain('\r\n');
});

test('wait returns when output contains a literal pattern', async () => {
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
  await processWriteTool.run({ id, input: 'y\n' }, ctx);
  const answer = await waitProcess({ id, pattern: 'answer:y', timeoutMs: 1000 }, ctx);
  expect(answer.matched).toBe(true);
  expect(answer.stdout).toContain('answer:y');
});

test('wait supports regex matching', async () => {
  const { id } = await startProcess(
    {
      command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans'
    },
    ctx
  );
  await waitProcess({ id, pattern: 'Proceed\\?', match: 'regex', timeoutMs: 1000 }, ctx);
  await processWriteTool.run({ id, input: 'y\n' }, ctx);
  const answer = await waitProcess({ id, pattern: 'answer:[yn]', match: 'regex', timeoutMs: 1000 }, ctx);
  expect(answer.matched).toBe(true);
  expect(answer.stdout).toContain('answer:y');
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
  const raw = await processLogs({ id }, ctx);
  const stripped = await processLogs({ id, stripAnsi: true }, ctx);
  expect(raw.stdout).toContain('\x1b[31m');
  expect(stripped.stdout).toContain('READY');
  expect(stripped.stdout).not.toContain('\x1b');
});

test('write supports structured keys', async () => {
  const { id } = await startProcess(
    {
      command: 'printf "Proceed? [y/N] "; read ans; echo answer:$ans'
    },
    ctx
  );
  await waitProcess({ id, pattern: 'Proceed?', timeoutMs: 1000 }, ctx);
  await processWriteTool.run({ id, input: 'y', key: 'enter' }, ctx);
  const answer = await waitProcess({ id, pattern: 'answer:y', timeoutMs: 1000 }, ctx);
  expect(answer.matched).toBe(true);
  expect(answer.stdout).toContain('answer:y');
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
  expect(first.stdout).toContain('1');
  const second = await waitProcess({ id, pattern: '2', timeoutMs: 1000 }, ctx);
  const delta = await processLogs({ id, cursor: first.cursor }, ctx);
  expect(second.stdout).toContain('2');
  expect(delta.stdout).not.toContain('1');
  expect(delta.stdout).toContain('2');
  expect(delta.cursor.stdout).toBe(second.cursor.stdout);
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
  expect(r.stderr).toContain('idle timeout');
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
  await processResizeTool.run({ id, cols: 100, rows: 30 }, ctx);
  const r = await waitForExit(id);
  expect(r.mode).toBe('pty');
  expect(r.stdout).toContain('33 111');
  expect(r.stdout).toContain('30 100');
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
  await processSignalTool.run({ id, signal: 'SIGINT' }, ctx);
  const r = await waitProcess({ id, pattern: 'got-int', timeoutMs: 1000 }, ctx);
  expect(r.matched).toBe(true);
  expect(r.stdout).toContain('got-int');
});

test('resize rejects non-pty processes', async () => {
  const { id } = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', terminalMode: 'pipe' }, ctx);
  await expect(processResizeTool.run({ id, cols: 100, rows: 30 }, ctx)).rejects.toThrow(/not pty-backed/);
  await killProcess({ id }, ctx);
});

test('list shows a running process; kill stops it', async () => {
  const { id } = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', terminalMode: 'pipe' }, ctx);
  const listed = (await listProcesses({}, ctx)).processes;
  expect(listed.some((p) => p.id === id && p.status === 'running')).toBe(true);

  expect(await killProcess({ id }, ctx)).toEqual({ ok: true });
  expect((await processLogs({ id }, ctx)).status).toBe('killed');
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
  await processWriteTool.run({ id, input: 'ping\n' }, ctx);
  expect((await waitForStdout(id, 'got:ping')).stdout).toContain('got:ping');
  await killProcess({ id }, ctx);
});

test('logs/kill on an unknown id throws', async () => {
  await expect(processLogs({ id: 'proc-nope' }, ctx)).rejects.toThrow(/unknown process/);
});

test('write to a finished process throws', async () => {
  const { id } = await startProcess({ command: 'bun -e "console.log(1)"', terminalMode: 'pipe' }, ctx);
  await waitForExit(id);
  await expect(processWriteTool.run({ id, input: 'x' }, ctx)).rejects.toThrow(/not running/);
});

test('a session cannot see or control another session’s processes', async () => {
  const { id } = await startProcess({ command: 'bun -e "setInterval(() => {}, 1000)"', terminalMode: 'pipe' }, ctx);

  // Not visible in the other session's list.
  expect((await listProcesses({}, ctxB)).processes.some((p) => p.id === id)).toBe(false);

  // logs/write/kill from the other session look exactly like an unknown id — no existence leak.
  const unknown = /unknown process/;
  await expect(processLogs({ id }, ctxB)).rejects.toThrow(unknown);
  await expect(processWriteTool.run({ id, input: 'x' }, ctxB)).rejects.toThrow(unknown);
  await expect(killProcess({ id }, ctxB)).rejects.toThrow(unknown);

  // Owner is unaffected: still running.
  expect((await processLogs({ id }, ctx)).status).toBe('running');
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
  await expect(processLogs({ id: a.id }, ctx)).rejects.toThrow(/unknown process/);
  // s2's process survives.
  expect((await processLogs({ id: b.id }, ctxB)).status).toBe('running');
  await killProcess({ id: b.id }, ctxB);
});
