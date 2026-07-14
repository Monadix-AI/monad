import type { SandboxProcess, SandboxTerminalOptions, SandboxViolation } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeFrame,
  FrameDecoder,
  GuestFrameKind,
  HostFrameKind,
  MAX_STREAM_FRAME_BYTES
} from '../../src/exec/protocol.ts';
import { bridgeAsyncProcess, vsockExec } from '../../src/exec/vsock.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function protocolServer(
  handle: (frame: { kind: number; payload: Buffer }, send: (kind: number, value: unknown) => void) => void
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'monad-vsock-test-'));
  const socketPath = join(dir, 'agent.sock');
  let server: Server;
  server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) {
        handle(frame, (kind, value) => socket.write(encodeFrame(kind, Buffer.from(JSON.stringify(value)))));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return socketPath;
}

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

test('PTY start carries dimensions and resize sends a control frame', async () => {
  const received: Array<{ kind: number; payload: unknown }> = [];
  const socketPath = await protocolServer((frame, send) => {
    const payload = frame.payload.byteLength > 0 ? JSON.parse(frame.payload.toString()) : undefined;
    received.push({ kind: frame.kind, payload });
    if (frame.kind === HostFrameKind.Start) send(GuestFrameKind.Started, { runId: 'pty-1', pid: 42 });
    if (frame.kind === HostFrameKind.Resize) send(GuestFrameKind.Exit, { code: 0, signal: 0 });
  });
  const proc = vsockExec(['sh'], {
    socketPath,
    runId: 'pty-1',
    terminal: { cols: 80, rows: 24 },
    observation: { writableRoots: ['/work'], noWriteRoots: ['/work/readonly'] }
  });

  await proc.terminal?.resize(120, 40);
  await proc.exited;

  expect(received[0]).toEqual({
    kind: HostFrameKind.Start,
    payload: {
      version: 5,
      runId: 'pty-1',
      argv: ['sh'],
      env: {},
      limits: {},
      terminal: { cols: 80, rows: 24 },
      observation: { writableRoots: ['/work'], noWriteRoots: ['/work/readonly'] }
    }
  });
  expect(received[1]).toEqual({ kind: HostFrameKind.Resize, payload: { cols: 120, rows: 40 } });
  expect(proc.stderr).toBeUndefined();
});

test('PTY dimensions fail before opening the transport', () => {
  expect(() => vsockExec(['sh'], { socketPath: '/does/not/exist', terminal: { cols: 0, rows: 24 } })).toThrow(
    'terminal dimensions'
  );
  expect(() => vsockExec(['sh'], { socketPath: '/does/not/exist', terminal: { cols: 80, rows: 1001 } })).toThrow(
    'terminal dimensions'
  );
});

test('validated violation frames receive a host timestamp', async () => {
  const socketPath = await protocolServer((frame, send) => {
    if (frame.kind !== HostFrameKind.Start) return;
    send(GuestFrameKind.Started, { runId: 'violation-1', pid: 43 });
    send(GuestFrameKind.Violation, {
      kind: 'memory',
      operation: 'oom-kill',
      runId: 'violation-1',
      detail: 'memory.events increased'
    });
    send(GuestFrameKind.Exit, { code: 137, signal: 0 });
  });
  const proc = vsockExec(['true'], { socketPath, runId: 'violation-1' });
  const eventsPromise = collect(proc.violations as NonNullable<typeof proc.violations>);

  expect(await proc.exited).toBe(137);
  const events = await eventsPromise;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: 'memory',
    operation: 'oom-kill',
    runId: 'violation-1',
    detail: 'memory.events increased'
  });
  expect(Number.isNaN(Date.parse(events[0]?.timestamp ?? ''))).toBe(false);
});

test('invalid violation enums fail the run closed', async () => {
  const socketPath = await protocolServer((frame, send) => {
    if (frame.kind !== HostFrameKind.Start) return;
    send(GuestFrameKind.Started, { runId: 'violation-2', pid: 44 });
    send(GuestFrameKind.Violation, { kind: 'made-up', operation: 'oom-kill', runId: 'violation-2' });
  });
  const proc = vsockExec(['true'], { socketPath, runId: 'violation-2' });

  await expect(proc.exited).rejects.toThrow('invalid violation payload');
});

test('filesystem violations accept only bounded syscall operations', async () => {
  const socketPath = await protocolServer((frame, send) => {
    if (frame.kind !== HostFrameKind.Start) return;
    send(GuestFrameKind.Started, { runId: 'filesystem-1', pid: 45 });
    send(GuestFrameKind.Violation, {
      kind: 'filesystem',
      operation: 'openat',
      runId: 'filesystem-1',
      target: '/etc/passwd',
      pid: 7
    });
    send(GuestFrameKind.Exit, { code: 0, signal: 0 });
  });
  const proc = vsockExec(['true'], { socketPath, runId: 'filesystem-1' });
  const events = collect(proc.violations as NonNullable<typeof proc.violations>);

  expect(await proc.exited).toBe(0);
  expect(await events).toEqual([
    expect.objectContaining({
      kind: 'filesystem',
      operation: 'openat',
      runId: 'filesystem-1',
      target: '/etc/passwd',
      pid: 7
    })
  ]);
});

test.each([
  { operation: 'execve', target: '/etc/passwd' },
  { operation: 'openat', target: `/${'界'.repeat(1366)}` }
])('invalid filesystem violation %# fails the run closed', async (violation) => {
  const socketPath = await protocolServer((frame, send) => {
    if (frame.kind !== HostFrameKind.Start) return;
    send(GuestFrameKind.Started, { runId: 'filesystem-invalid', pid: 46 });
    send(GuestFrameKind.Violation, {
      kind: 'filesystem',
      runId: 'filesystem-invalid',
      ...violation
    });
  });
  const proc = vsockExec(['true'], { socketPath, runId: 'filesystem-invalid' });

  await expect(proc.exited).rejects.toThrow('invalid violation payload');
});

test('kill sends a signal frame and waits for the guest exit frame', async () => {
  let receivedSignal = 0;
  const socketPath = await protocolServer((frame, send) => {
    if (frame.kind === HostFrameKind.Start) send(GuestFrameKind.Started, { runId: 'run-1', pid: 42 });
    if (frame.kind === HostFrameKind.Signal) {
      receivedSignal = JSON.parse(frame.payload.toString()).signal;
      send(GuestFrameKind.Exit, { code: null, signal: 15 });
    }
  });
  const proc = vsockExec(['sleep', '60'], { socketPath, runId: 'run-1' });

  proc.kill('SIGTERM');

  expect(await proc.exit).toEqual({ code: null, signal: 15 });
  expect(await proc.exited).toBe(143);
  expect(receivedSignal).toBe(15);
  expect(proc.pid).toBe(42);
});

test('stdin writes are chunked to the protocol stream limit', async () => {
  const sizes: number[] = [];
  const socketPath = await protocolServer((frame, send) => {
    if (frame.kind === HostFrameKind.Start) send(GuestFrameKind.Started, { runId: 'run-2', pid: 43 });
    if (frame.kind === HostFrameKind.Stdin) sizes.push(frame.payload.byteLength);
    if (frame.kind === HostFrameKind.CloseStdin) send(GuestFrameKind.Exit, { code: 0, signal: 0 });
  });
  const proc = vsockExec(['sh'], { socketPath, runId: 'run-2' });

  await proc.stdin?.write(new Uint8Array(MAX_STREAM_FRAME_BYTES + 1));
  await proc.stdin?.end();

  expect(await proc.exited).toBe(0);
  expect(sizes).toEqual([MAX_STREAM_FRAME_BYTES, 1]);
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

  expect(proc.terminal).toBeDefined();
  expect(proc.violations).toBeDefined();
  if (!proc.terminal || !proc.violations) return;
  const resize = proc.terminal.resize(100, 30);
  const write = proc.terminal.write('hello');
  const events = collect(proc.violations);

  await Promise.all([resize, write, proc.exited]);
  expect(controls).toEqual(['resize:100x30', 'write:hello']);
  expect(await events).toEqual([event]);
});
