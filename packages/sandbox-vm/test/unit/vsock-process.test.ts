import type { SandboxProcess, SandboxTerminalOptions, SandboxViolation } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { bridgeAsyncProcess, vsockExec, waitForVsock } from '../../src/exec/vsock.ts';

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return values;
      values.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

test('readiness fails as soon as the virtual machine exits', async () => {
  const startedAt = performance.now();
  await expect(
    waitForVsock(
      { socketPath: '/missing/vsock.sock' },
      { intervalMs: 10_000, probe: async () => false, timeoutMs: 60_000, vmmExited: Promise.resolve(78) }
    )
  ).rejects.toThrow('virtual machine exited with code 78');
  expect(performance.now() - startedAt).toBeLessThan(1_000);
});

test('PTY dimensions fail before opening the transport', () => {
  expect(() => vsockExec(['sh'], { socketPath: '/does/not/exist', terminal: { cols: 0, rows: 24 } })).toThrow(
    'terminal dimensions'
  );
  expect(() => vsockExec(['sh'], { socketPath: '/does/not/exist', terminal: { cols: 80, rows: 1001 } })).toThrow(
    'terminal dimensions'
  );
});

test('the async bridge rejects queued stdin when process startup fails', async () => {
  const proc = bridgeAsyncProcess(async () => {
    await Bun.sleep(5);
    throw new Error('start failed');
  });
  const write = proc.stdin?.write('queued');
  const outcome = Promise.race([
    Promise.resolve(write).then(
      () => 'resolved',
      (error) => (error as Error).message
    ),
    Bun.sleep(50).then(() => 'timeout')
  ]);

  await expect(proc.exited).rejects.toThrow('start failed');
  expect(await outcome).toBe('start failed');
});

test('the async bridge queues terminal controls and forwards violations', async () => {
  const controls: string[] = [];
  const event: SandboxViolation = {
    kind: 'runtime',
    operation: 'runtime-exit',
    runId: 'bridge-1',
    timestamp: '2026-07-14T00:00:00.000Z'
  };
  const bridgeWithTerminal = bridgeAsyncProcess as unknown as (
    start: () => Promise<SandboxProcess>,
    onFinally: undefined,
    terminal: SandboxTerminalOptions
  ) => SandboxProcess;
  const proc = bridgeWithTerminal(
    async () => {
      await Bun.sleep(5);
      return {
        terminal: {
          write(data) {
            controls.push(`write:${String(data)}`);
          },
          close() {
            controls.push('close');
          },
          resize(cols, rows) {
            controls.push(`resize:${cols}x${rows}`);
          }
        },
        violations: new ReadableStream<SandboxViolation>({
          start(controller) {
            controller.enqueue(event);
            controller.close();
          }
        }),
        exited: Promise.resolve(0),
        exitCode: 0,
        kill() {}
      };
    },
    undefined,
    { cols: 80, rows: 24 }
  );

  const resize = proc.terminal?.resize(100, 30);
  const write = proc.terminal?.write('hello');
  const events = proc.violations ? collect(proc.violations) : Promise.resolve([]);
  await Promise.all([resize, write, proc.exited]);
  expect(controls).toEqual(['resize:100x30', 'write:hello']);
  expect(await events).toEqual([event]);
});
