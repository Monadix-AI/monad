import type { ToolContext } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { shellExecTool, ToolSecurityError } from '@/capabilities/tools';

const ctx = (roots?: string[]): ToolContext => ({ sessionId: 's1', sandboxRoots: roots, log: () => {} });

test('shell_exec is high-risk (gated)', () => {
  expect(shellExecTool.highRisk).toBe(true);
});

test('shell_exec gateKey is the command family (leading token, basename of a path)', () => {
  expect(shellExecTool.gateKey?.({ command: 'git push origin main' })).toBe('git');
  expect(shellExecTool.gateKey?.({ command: '  npm   install ' })).toBe('npm');
  expect(shellExecTool.gateKey?.({ command: '/usr/bin/python3 x.py' })).toBe('python3');
  expect(shellExecTool.gateKey?.({ command: ['rm', '-rf', '/tmp/x'] })).toBe('rm');
});

test('shell_exec aborts immediately when the session signal fires', async () => {
  const controller = new AbortController();
  const ac: ToolContext = { sessionId: 's1', sandboxRoots: undefined, signal: controller.signal, log: () => {} };
  const p = shellExecTool.run({ command: 'sleep 30', timeoutMs: 60_000 }, ac);
  setTimeout(() => controller.abort(), 50);
  await expect(p).rejects.toBeInstanceOf(ToolSecurityError);
});

test('shell_exec captures stdout and exit code', async () => {
  const res = await shellExecTool.run({ command: 'echo hello' }, ctx());
  expect(res.metadata.stdout.trim()).toBe('hello');
  expect(res.metadata.exitCode).toBe(0);
});

test('shell_exec reports a non-zero exit code', async () => {
  const res = await shellExecTool.run({ command: 'exit 3' }, ctx());
  expect(res.metadata.exitCode).toBe(3);
});

test('shell_exec rejects a cwd outside the sandbox (no gate)', async () => {
  // No gate present — the sandbox backend throws before the command is spawned.
  const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
  await expect(shellExecTool.run({ command: 'echo x', cwd: outside }, ctx([process.cwd()]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('shell_exec fires secondary gate (cmd@dir) when cwd escapes sandbox', async () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows' : '/tmp';
  const calls: { key?: string; tool: string }[] = [];
  const c: ToolContext = {
    ...ctx([process.cwd()]),
    gate: async (req) => {
      calls.push({ tool: req.tool, key: req.key });
      return { allow: false, reason: 'denied' };
    }
  };
  await expect(shellExecTool.run({ command: 'echo x', cwd: outside }, c)).rejects.toBeInstanceOf(ToolSecurityError);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.tool).toBe('shell_exec');
  expect(calls[0]?.key).toMatch(/^echo@/);
});

test('shell_exec secondary gate allow expands roots and runs the command', async () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows' : '/tmp';
  const c: ToolContext = {
    ...ctx([process.cwd()]),
    gate: async () => ({ allow: true })
  };
  const res = await shellExecTool.run({ command: 'echo expanded', cwd: outside }, c);
  expect(res.metadata.exitCode).toBe(0);
  expect(res.metadata.stdout.trim()).toBe('expanded');
});

test('shell_exec secondary gate not invoked when cwd is inside sandbox', async () => {
  const calls: unknown[] = [];
  const c: ToolContext = {
    ...ctx([process.cwd()]),
    gate: async (req) => {
      calls.push(req);
      return { allow: true };
    }
  };
  // cwd = process.cwd() is inside the sandbox root
  const res = await shellExecTool.run({ command: 'echo inside', cwd: process.cwd() }, c);
  expect(res.metadata.exitCode).toBe(0);
  // gate fires once for the primary highRisk check (invokeTool), but NOT for the secondary cwd check
  // invokeTool is not called here — we call tool.run() directly — so gate should never fire
  expect(calls).toHaveLength(0);
});
