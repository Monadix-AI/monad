import type { Logger } from '@monad/logger';

import { expect, test } from 'bun:test';

import { supervisedSpawn } from '#/infra/spawn-supervisor.ts';

function createCaptureLogger(): { log: Logger; records: Array<{ level: string; obj: unknown; msg?: string }> } {
  const records: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const write = (level: string) => (obj: unknown, msg?: string) => records.push({ level, obj, msg });
  const log = {
    level: 'debug',
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    silent: write('silent'),
    isLevelEnabled: () => true,
    child: () => log
  } as Logger;
  return { log, records };
}

function recordAt(records: Array<{ level: string; obj: unknown; msg?: string }>, index: number) {
  const record = records[index];
  if (!record) throw new Error(`missing log record at index ${index}`);
  return record;
}

test('supervisedSpawn records process lifecycle without logging env', async () => {
  const { log, records } = createCaptureLogger();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const spawn = ((argv: string[], options: Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'>) => {
    expect(argv).toEqual(['provider-cli', 'run']);
    expect(options.env?.SECRET_TOKEN).toBe('hidden');
    return { pid: 1234, exited };
  }) as unknown as typeof Bun.spawn;

  supervisedSpawn(
    ['provider-cli', 'run'],
    {
      cwd: '/tmp/work',
      env: { SECRET_TOKEN: 'hidden' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true
    },
    {
      event: 'mesh.spawn',
      log,
      context: { meshSessionId: 'mesh_test000000' },
      spawn
    }
  );

  expect(records).toHaveLength(2);
  const startRecord = recordAt(records, 0);
  const pidRecord = recordAt(records, 1);
  expect(startRecord).toMatchObject({ level: 'debug', msg: 'process spawn' });
  expect(startRecord.obj).toMatchObject({
    event: 'mesh.spawn.start',
    meshSessionId: 'mesh_test000000',
    argv: ['provider-cli', '[redacted]'],
    cwd: '/tmp/work',
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', terminal: false },
    detached: true
  });
  expect(startRecord.obj).not.toHaveProperty('env');
  expect(pidRecord).toMatchObject({ level: 'debug', msg: 'process spawned' });
  expect(pidRecord.obj).toMatchObject({
    event: 'mesh.spawn.pid',
    meshSessionId: 'mesh_test000000',
    pid: 1234
  });

  resolveExit(7);
  await exited;
  await Bun.sleep(0);

  const exitRecord = recordAt(records, 2);
  expect(exitRecord).toMatchObject({ level: 'debug', msg: 'process exited' });
  expect(exitRecord.obj).toMatchObject({
    event: 'mesh.spawn.exit',
    meshSessionId: 'mesh_test000000',
    pid: 1234,
    exitCode: 7
  });
  expect(exitRecord.obj).toHaveProperty('durationMs');
});

test('supervisedSpawn redacts argv values from lifecycle logs', async () => {
  const { log, records } = createCaptureLogger();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const spawn = (() => ({ pid: 1235, exited })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['mcp-server', '--api-key=SECRET_VALUE', '--token', 'TOKEN_VALUE'],
    { stdout: 'pipe', stderr: 'pipe' },
    { event: 'mcp.stdio_spawn', log, spawn }
  );

  resolveExit(0);
  await proc.supervision.result;

  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain('SECRET_VALUE');
  expect(serialized).not.toContain('TOKEN_VALUE');
  expect(recordAt(records, 0).obj).toMatchObject({
    event: 'mcp.stdio_spawn.start',
    argv: ['mcp-server', '[redacted]', '[redacted]', '[redacted]']
  });
});

test('supervisedSpawn logs and rethrows synchronous spawn failures', () => {
  const { log, records } = createCaptureLogger();
  const spawnError = new Error('command not found');
  const spawn = (() => {
    throw spawnError;
  }) as unknown as typeof Bun.spawn;

  expect(() =>
    supervisedSpawn(
      ['missing-cli'],
      { cwd: '/tmp/work', stdout: 'pipe', stderr: 'pipe' },
      { event: 'probe.spawn', log, spawn }
    )
  ).toThrow(spawnError);

  const errorRecord = recordAt(records, records.length - 1);
  expect(errorRecord).toMatchObject({ level: 'error', msg: 'process spawn failed' });
  expect(errorRecord.obj).toMatchObject({
    event: 'probe.spawn.error',
    argv: ['missing-cli'],
    cwd: '/tmp/work',
    err: { message: 'command not found' }
  });
});

test('supervisedSpawn terminates and logs when a timeout elapses', async () => {
  const { log, records } = createCaptureLogger();
  const killed: Array<string | number | undefined> = [];
  const exited = new Promise<number>(() => {});
  const spawn = (() => ({
    pid: 4321,
    exited,
    kill: (signal?: string | number) => killed.push(signal)
  })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'status'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'probe.spawn',
      log,
      spawn,
      timeout: { ms: 1, signal: 'SIGTERM' }
    }
  );

  await proc.supervision.timeoutElapsed;

  expect(killed).toEqual(['SIGTERM']);
  const timeoutRecord = recordAt(records, records.length - 1);
  expect(timeoutRecord).toMatchObject({ level: 'warn', msg: 'process timed out' });
  expect(timeoutRecord.obj).toMatchObject({
    event: 'probe.spawn.timeout',
    exitReason: 'timeout',
    pid: 4321,
    timeoutMs: 1,
    signal: 'SIGTERM'
  });
});

test('supervisedSpawn escalates timeout termination when the child keeps running', async () => {
  const { log, records } = createCaptureLogger();
  const killed: Array<string | number | undefined> = [];
  const spawn = (() => ({
    pid: 4322,
    exited: new Promise<number>(() => {}),
    kill: (signal?: string | number) => killed.push(signal)
  })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'status'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'probe.spawn',
      log,
      spawn,
      timeout: { ms: 1, signal: 'SIGTERM', killAfterMs: 1, killSignal: 'SIGKILL' }
    }
  );

  await proc.supervision.timeoutElapsed;
  await Bun.sleep(2);

  expect(killed).toEqual(['SIGTERM', 'SIGKILL']);
  expect(records.at(-1)).toMatchObject({ level: 'warn', msg: 'process timeout escalation' });
  expect(records.at(-1)?.obj).toMatchObject({
    event: 'probe.spawn.timeout_escalated',
    exitReason: 'timeout',
    signal: 'SIGKILL'
  });
});

test('supervisedSpawn abort signal terminates the child and classifies the result', async () => {
  const { log, records } = createCaptureLogger();
  const controller = new AbortController();
  const killed: Array<string | number | undefined> = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const spawn = (() => ({
    pid: 4323,
    exited,
    kill: (signal?: string | number) => killed.push(signal)
  })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'run'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'abort.spawn',
      log,
      spawn,
      abortSignal: controller.signal,
      abortKillSignal: 'SIGTERM'
    }
  );

  controller.abort();
  await Bun.sleep(0);
  resolveExit(143);
  const result = await proc.supervision.result;

  expect(killed).toEqual(['SIGTERM']);
  expect(result).toMatchObject({ exitReason: 'abort', exitCode: 143 });
  expect(records.find((record) => (record.obj as { event?: string }).event === 'abort.spawn.abort')).toMatchObject({
    level: 'warn',
    msg: 'process aborted'
  });
});

test('supervisedSpawn tracks successful children and untracks them on exit', async () => {
  const { log } = createCaptureLogger();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const tracked: Array<{ pid: number; label: string; kill: () => void }> = [];
  const untracked: number[] = [];
  const killed: Array<string | number | undefined> = [];
  const spawn = (() => ({
    pid: 2468,
    exited,
    kill: (signal?: string | number) => killed.push(signal)
  })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'run'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'tracked.spawn',
      log,
      spawn,
      trackLabel: 'mesh-agent-test',
      tracker: {
        track: (pid, label, kill) => {
          tracked.push({ pid, label, kill });
        },
        untrack: (pid) => {
          untracked.push(pid);
        }
      }
    }
  );
  await proc.supervision.tracked;

  expect(tracked).toHaveLength(1);
  expect(tracked[0]?.pid).toBe(2468);
  expect(tracked[0]?.label).toBe('mesh-agent-test');
  tracked[0]?.kill();
  expect(killed).toEqual(['SIGTERM']);

  resolveExit(0);
  await exited;
  await Bun.sleep(0);

  expect(untracked).toEqual([2468]);
});

test('supervisedSpawn emits lifecycle callbacks with classified results', async () => {
  const { log } = createCaptureLogger();
  const lifecycle: string[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const spawn = (() => ({ pid: 2469, exited, kill: () => {} })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'run'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'lifecycle.spawn',
      log,
      spawn,
      tracker: {
        track: () => {},
        untrack: () => {}
      },
      onLifecycle: (event) => lifecycle.push(event.phase)
    }
  );

  await proc.supervision.tracked;
  resolveExit(0);
  const result = await proc.supervision.result;

  expect(result).toMatchObject({ exitReason: 'exit', exitCode: 0 });
  expect(lifecycle).toEqual(['start', 'pid', 'tracked', 'exit', 'untracked']);
});

test('supervisedSpawn stop classifies manual termination', async () => {
  const { log, records } = createCaptureLogger();
  const killed: Array<string | number | undefined> = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const spawn = (() => ({
    pid: 3333,
    exited,
    kill: (signal?: string | number) => killed.push(signal)
  })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'run'],
    { stdout: 'pipe', stderr: 'pipe' },
    { event: 'manual.spawn', log, spawn }
  );

  proc.supervision.stop('manual', 'SIGTERM');
  resolveExit(143);
  const result = await proc.supervision.result;

  expect(killed).toEqual(['SIGTERM']);
  expect(result).toMatchObject({ exitReason: 'manual', exitCode: 143 });
  expect(records.find((record) => (record.obj as { event?: string }).event === 'manual.spawn.stop')).toMatchObject({
    level: 'warn',
    msg: 'process stop requested'
  });
});

test('supervisedSpawn tracker kill classifies daemon shutdown', async () => {
  const { log } = createCaptureLogger();
  const killed: Array<string | number | undefined> = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let trackerKill!: () => void;
  const spawn = (() => ({
    pid: 3334,
    exited,
    kill: (signal?: string | number) => killed.push(signal)
  })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'run'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'shutdown.spawn',
      log,
      spawn,
      tracker: {
        track: (_pid, _label, kill) => {
          trackerKill = kill;
        },
        untrack: () => {}
      }
    }
  );
  await proc.supervision.tracked;

  trackerKill();
  resolveExit(143);
  const result = await proc.supervision.result;

  expect(killed).toEqual(['SIGTERM']);
  expect(result).toMatchObject({ exitReason: 'shutdown', exitCode: 143 });
});

test('supervisedSpawn clears timeout escalation when the child exits after timeout kill', async () => {
  const { log, records } = createCaptureLogger();
  const killed: Array<string | number | undefined> = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const spawn = (() => ({
    pid: 3335,
    exited,
    kill: (signal?: string | number) => {
      killed.push(signal);
      resolveExit(143);
    }
  })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'status'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'timeout.race',
      log,
      spawn,
      timeout: { ms: 1, signal: 'SIGTERM', killAfterMs: 5, killSignal: 'SIGKILL' }
    }
  );

  await proc.supervision.result;
  await Bun.sleep(10);

  expect(killed).toEqual(['SIGTERM']);
  expect(records.some((record) => (record.obj as { event?: string }).event === 'timeout.race.timeout_escalated')).toBe(
    false
  );
});

test('supervisedSpawn keeps abort classification when timeout would fire later', async () => {
  const { log } = createCaptureLogger();
  const controller = new AbortController();
  const killed: Array<string | number | undefined> = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const spawn = (() => ({
    pid: 3336,
    exited,
    kill: (signal?: string | number) => killed.push(signal)
  })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'run'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'abort.timeout_race',
      log,
      spawn,
      abortSignal: controller.signal,
      timeout: { ms: 20, signal: 'SIGTERM', killAfterMs: 20, killSignal: 'SIGKILL' }
    }
  );

  controller.abort();
  await Bun.sleep(0);
  resolveExit(143);
  const result = await proc.supervision.result;
  await Bun.sleep(25);

  expect(killed).toEqual(['SIGTERM']);
  expect(result).toMatchObject({ exitReason: 'abort', exitCode: 143 });
});

test('supervisedSpawn untrack is idempotent across manual untrack and exit', async () => {
  const { log } = createCaptureLogger();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const untracked: number[] = [];
  const spawn = (() => ({ pid: 3337, exited, kill: () => {} })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'run'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'untrack.race',
      log,
      spawn,
      tracker: {
        track: () => {},
        untrack: (pid) => {
          untracked.push(pid);
        }
      }
    }
  );
  await proc.supervision.tracked;

  await proc.supervision.untrack();
  resolveExit(0);
  await proc.supervision.result;

  expect(untracked).toEqual([3337]);
});

test('supervisedSpawn untracks when async tracking resolves after process exit', async () => {
  const { log } = createCaptureLogger();
  let resolveTrack!: () => void;
  const trackDone = new Promise<void>((resolve) => {
    resolveTrack = resolve;
  });
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const lifecycle: string[] = [];
  const untracked: number[] = [];
  const spawn = (() => ({ pid: 3338, exited, kill: () => {} })) as unknown as typeof Bun.spawn;

  const proc = supervisedSpawn(
    ['provider-cli', 'run'],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      event: 'async_track.race',
      log,
      spawn,
      tracker: {
        track: () => trackDone,
        untrack: (pid) => {
          untracked.push(pid);
        }
      },
      onLifecycle: (event) => lifecycle.push(event.phase)
    }
  );

  resolveExit(0);
  await Bun.sleep(0);
  expect(untracked).toEqual([]);

  resolveTrack();
  await proc.supervision.tracked;
  await proc.supervision.result;

  expect(untracked).toEqual([3338]);
  expect(lifecycle).toEqual(['start', 'pid', 'exit', 'tracked', 'untracked']);
});
