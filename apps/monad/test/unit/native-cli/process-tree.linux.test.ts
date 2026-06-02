// Real POSIX process-group kill on Linux. The unit-injected tests in native-cli-adapters.test.ts
// cover the platform branching with a stubbed kill fn; this one exercises the actual syscall path —
// killNativeCliProcess must reap the whole group (the CLI leader AND anything it forked), not just
// the leader. Runs on Linux only (in Docker / CI ubuntu); the kill semantics are what we ship there.

if (process.platform !== 'linux') process.exit(0);

import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { killNativeCliProcess } from '@/services/native-cli/process.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return !isAlive(pid);
}

test('killNativeCliProcess reaps the whole process group, not just the leader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ncli-tree-'));
  const childPidFile = join(dir, 'child.pid');

  // detached → the shell becomes its own group leader; the backgrounded `sleep` shares that group,
  // mirroring how a native CLI agent forks subprocesses under one group.
  const proc = Bun.spawn(['sh', '-c', `sleep 60 & echo $! > "${childPidFile}"; wait`], {
    detached: true,
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore'
  });
  const parentPid = proc.pid;

  let childPid = 0;
  for (let i = 0; i < 100 && !childPid; i++) {
    try {
      childPid = Number((await readFile(childPidFile, 'utf8')).trim());
    } catch {
      await Bun.sleep(20);
    }
  }

  try {
    expect(childPid).toBeGreaterThan(0);
    expect(isAlive(parentPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    killNativeCliProcess(parentPid, 'SIGTERM');

    expect(await waitDead(parentPid)).toBe(true);
    // The forked child is reaped only if the negative-pid group kill worked — a leader-only kill
    // would leave it orphaned and alive.
    expect(await waitDead(childPid)).toBe(true);
  } finally {
    try {
      process.kill(-parentPid, 'SIGKILL');
    } catch {
      // already gone
    }
    await rm(dir, { recursive: true, force: true });
  }
});
