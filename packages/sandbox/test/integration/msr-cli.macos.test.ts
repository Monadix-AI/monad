import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../../src/cli.ts');

let dir: string;
let secret: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'msr-smoke-'));
  secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'TOP SECRET');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function runMsr(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

test('msr runs a command confined and exits with its status', async () => {
  const { code, stdout } = await runMsr(['--', 'echo', 'hello-from-sandbox']);
  expect(code).toBe(0);
  expect(stdout).toContain('hello-from-sandbox');
});

test('msr enforces --read-deny at the kernel: reading a denied file is refused', async () => {
  const { code } = await runMsr(['--read-deny', dir, '--', 'cat', secret]);
  expect(code).not.toBe(0);
});

test('msr --net filtered denies egress with no --allow-domain', async () => {
  const { code } = await runMsr(['--net', 'filtered', '--', 'curl', '-sS', '-m', '5', 'https://example.com']);
  expect(code).not.toBe(0);
});
