import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The logger snapshots its destination when the underlying pino instance is built. Loggers are
// created at module scope (before the daemon sets its routing flags), so createLogger must build
// lazily — reading setLogStderr()/setLogFile() at first USE. These run in a child process so the real
// fd/file routing (not an in-process mock) is exercised in production mode.
const SRC = resolve(import.meta.dir, '../../src/index.ts');

async function runChild(setup: string): Promise<{ stdout: string; stderr: string }> {
  const script = `
    import { logger, setLogStderr, setLogFile } from ${JSON.stringify(SRC)};
    ${setup}
    logger.info('MARKER_ROUTED');
    await new Promise((r) => setTimeout(r, 200));
  `;
  const proc = Bun.spawn(['bun', '-e', script], {
    env: { ...Bun.env, NODE_ENV: 'production' },
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout, stderr };
}

test('setLogStderr(true) routes the shared logger to stderr, keeping stdout clean', async () => {
  const { stdout, stderr } = await runChild('setLogStderr(true);');
  expect(stdout).not.toContain('MARKER_ROUTED');
  expect(stderr).toContain('MARKER_ROUTED');
});

test('by default the shared logger routes to stdout', async () => {
  const { stdout } = await runChild('');
  expect(stdout).toContain('MARKER_ROUTED');
});

test('setLogFile routes the shared logger to the file, keeping stdout and stderr clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-log-'));
  const file = join(dir, 'daemon.log');
  try {
    const { stdout, stderr } = await runChild(`setLogStderr(true); setLogFile(${JSON.stringify(file)});`);
    expect(stdout).not.toContain('MARKER_ROUTED');
    expect(stderr).not.toContain('MARKER_ROUTED');
    expect(readFileSync(file, 'utf8')).toContain('MARKER_ROUTED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
