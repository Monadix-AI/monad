if (process.platform === 'win32') process.exit(0);

import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  throw new Error('timeout');
}

async function waitDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  try {
    await waitFor(() => (!isAlive(pid) ? true : null), timeoutMs);
    return true;
  } catch {
    return !isAlive(pid);
  }
}

test('daemon child supervisor reaps a real child after the daemon owner is SIGKILLed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daemon-child-owner-'));
  const registryPath = join(dir, 'daemon-child-processes.json');
  const pidFile = join(dir, 'pids.json');
  const owner = Bun.spawn(
    [process.execPath, join(import.meta.dir, '..', 'fixtures', 'mock-daemon-child-owner.ts'), registryPath, pidFile],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  );

  const pids = await waitFor(async () => {
    try {
      return (await Bun.file(pidFile).json()) as { childPid: number; ownerPid: number };
    } catch {
      return null;
    }
  });

  try {
    expect(pids.ownerPid).toBe(owner.pid);
    expect(isAlive(pids.childPid)).toBe(true);
    expect(existsSync(registryPath)).toBe(true);

    process.kill(owner.pid, 'SIGKILL');
    await owner.exited.catch(() => {});

    expect(await waitDead(pids.childPid)).toBe(true);
    await waitFor(() => (!existsSync(registryPath) ? true : null));
  } finally {
    try {
      process.kill(-pids.childPid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      process.kill(owner.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
