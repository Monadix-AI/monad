import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  CodeExecError,
  codeExecTool,
  configureCodeExec,
  localBackend,
  selectCodeExecBackend
} from '@/capabilities/tools';

beforeEach(() => configureCodeExec('local'));
afterEach(() => configureCodeExec('local'));

test('code_execute gateKey distinguishes host escape from sandbox runs', () => {
  expect(codeExecTool.gateKey?.({ language: 'bash', code: 'x', target: 'host' })).toBe('target:host');
  expect(codeExecTool.gateKey?.({ language: 'bash', code: 'x', target: 'sandbox' })).toBe('target:sandbox');
  expect(codeExecTool.gateKey?.({ language: 'bash', code: 'x' })).toBe('target:sandbox');
});

test('localBackend kills the snippet when the signal aborts', async () => {
  const controller = new AbortController();
  const p = localBackend.execute({
    language: 'bash',
    code: 'sleep 30',
    timeoutMs: 60_000,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 50);
  await expect(p).rejects.toBeInstanceOf(CodeExecError);
});

// ── backend selection via configureCodeExec ───────────────────────────────────

test('selectCodeExecBackend defaults to local', () => {
  expect(selectCodeExecBackend().name).toBe('local');
});

test('selectCodeExecBackend throws on an unknown backend', () => {
  configureCodeExec('nope');
  expect(() => selectCodeExecBackend()).toThrow(/unknown code-exec backend/);
});

test('code_execute is high-risk (gated) and schema-validated', () => {
  expect(codeExecTool.highRisk).toBe(true);
  expect(codeExecTool.name).toBe('code_execute');
  expect(codeExecTool.inputSchema?.safeParse({ language: 'ruby', code: 'x' }).success).toBe(false);
});

// ── local backend execution (runs under Bun; CI-only — the sandbox blocks the runtime) ──

test('local backend runs javascript and captures stdout + exit code', async () => {
  const res = await localBackend.execute({ language: 'javascript', code: "console.log('hi from js')" });
  expect(res.stdout.trim()).toBe('hi from js');
  expect(res.exitCode).toBe(0);
  expect(res.backend).toBe('local');
});

test('local backend reports a non-zero exit code', async () => {
  const res = await localBackend.execute({ language: 'javascript', code: 'process.exit(3)' });
  expect(res.exitCode).toBe(3);
});

test('local backend enforces a timeout', async () => {
  await expect(
    localBackend.execute({ language: 'javascript', code: 'setInterval(() => {}, 1e9)', timeoutMs: 150 })
  ).rejects.toBeInstanceOf(CodeExecError);
});
