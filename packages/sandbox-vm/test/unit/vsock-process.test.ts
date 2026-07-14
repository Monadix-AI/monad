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
import { vsockExec } from '../../src/exec/vsock.ts';

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
