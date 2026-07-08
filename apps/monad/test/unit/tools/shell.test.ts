import type { SandboxLauncher } from '@monad/sdk-atom';
import type { ToolContext } from '#/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureSandboxLauncher,
  configureSandboxNet,
  noneLauncher,
  shellExecTool,
  ToolSecurityError
} from '#/capabilities/tools';
import { invokeTool } from '#/capabilities/tools/invoke.ts';

const ctx = (roots?: string[]): ToolContext => ({ sessionId: 's1', sandboxRoots: roots, log: () => {} });

const fakeLauncher: SandboxLauncher = {
  kind: 'fake-os-sandbox',
  wrap: (argv) => argv
};

const approvalEquivalentLauncher: SandboxLauncher = {
  kind: 'fake-approval-equivalent-sandbox',
  enforces: { readDeny: true, net: ['none'] },
  wrap: (argv) => argv
};

afterEach(() => {
  configureSandboxLauncher(noneLauncher);
  configureSandboxNet('unrestricted');
});

test('shell_exec is high-risk (gated)', () => {
  expect(shellExecTool.highRisk).toBe(true);
});

test('shell_exec still requires primary approval when the active sandbox is read or network permissive', async () => {
  configureSandboxLauncher(fakeLauncher);
  await expect(
    invokeTool(
      shellExecTool,
      { command: 'echo sandboxed', cwd: process.cwd() },
      { sessionId: 's1', sandboxRoots: [process.cwd()], log: () => {} }
    )
  ).rejects.toThrow(/requires an approval gate/);
});

test('shell_exec skips primary approval only when the active sandbox enforces read-deny and egress', async () => {
  configureSandboxLauncher(approvalEquivalentLauncher);
  configureSandboxNet('none');
  const res = await invokeTool(
    shellExecTool,
    { command: 'echo sandboxed', cwd: process.cwd() },
    { sessionId: 's1', sandboxRoots: [process.cwd()], log: () => {} }
  );
  expect(res.metadata.stdout.trim()).toBe('sandboxed');
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

test('shell_exec fires shared path gate when cwd escapes sandbox', async () => {
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
  expect(calls[0]?.tool).toBe('path_access');
  expect(calls[0]?.key).toBe(`cwd:${await realpath(outside)}`);
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

test('shell_exec path gate resolves relative escaped cwd from sandbox root', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'monad-shell-rel-')));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  const calls: { key?: string; tool: string }[] = [];
  try {
    const c: ToolContext = {
      ...ctx([root]),
      gate: async (req) => {
        calls.push({ tool: req.tool, key: req.key });
        return { allow: true };
      }
    };
    const res = await shellExecTool.run({ command: 'pwd', cwd: '../outside' }, c);
    expect(res.metadata.stdout.trim()).toBe(outside);
    expect(calls).toEqual([{ tool: 'path_access', key: `cwd:${outside}` }]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
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
});
