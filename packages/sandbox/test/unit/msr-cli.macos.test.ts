import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Live smoke: msr wraps a command under the macOS Seatbelt light launcher. Proves the CLI builds a
// real policy and that readDeny is enforced by the kernel (not just constructed).
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
  // Seatbelt denies the read → cat exits non-zero (the child could not open the file).
  expect(code).not.toBe(0);
});

test('msr --net filtered denies egress with no --allow-domain (proxy 403s the CONNECT)', async () => {
  // Deterministic and offline: Seatbelt limits the child to the local proxy port, HTTP(S)_PROXY routes
  // curl through it, and the proxy refuses the CONNECT (empty allowlist) before any real network dial.
  const { code } = await runMsr(['--net', 'filtered', '--', 'curl', '-sS', '-m', '5', 'https://example.com']);
  expect(code).not.toBe(0);
});

test('msr --config reads a sandbox.json base (net + credentials); secret refs are skipped', async () => {
  const cfg = join(dir, 'sandbox.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      net: 'filtered',
      allowedDomains: ['example.com'],
      tlsTerminate: { enabled: true },
      credentials: [
        { name: 'TOKEN', value: 'supersecret', injectHosts: ['example.com'] },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal secret-ref under test (msr must skip it)
        { name: 'SKIP', value: '${secret:X}', injectHosts: ['example.com'] }
      ]
    })
  );
  const { code, stdout, stderr } = await runMsr(['--config', cfg, '--', 'printenv', 'TOKEN']);
  expect(code).toBe(0);
  // Credential from the file: child sees the sentinel, never the real value.
  expect(stdout).toStartWith('fake_value_');
  expect(stdout).not.toContain('supersecret');
  // The secret-ref credential was skipped with a warning (msr can't resolve refs).
  expect(stderr).toContain('secret ref');
});
