import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeFrame, FrameDecoder, GuestFrameKind, HostFrameKind } from '../../src/exec/protocol.ts';
import { confirmRestoredVmBaseline, prepareVmBaseline } from '../../src/exec/vsock.ts';

test('prepare and restored handshakes use non-workload control frames', async () => {
  const path = join(tmpdir(), `baseline-protocol-${process.pid}-${Date.now()}.sock`);
  const seen: number[] = [];
  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) {
        seen.push(frame.kind);
        const request = JSON.parse(frame.payload.toString('utf8')) as { agentDigest: string };
        socket.end(
          encodeFrame(
            GuestFrameKind.BaselineReady,
            Buffer.from(
              JSON.stringify({
                bootEpoch: 'epoch-a',
                agentDigest: request.agentDigest,
                activeRuns: 0,
                everStarted: false,
                captureEligible: true
              })
            )
          )
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    expect(await prepareVmBaseline(path, 'agent-a')).toMatchObject({ bootEpoch: 'epoch-a' });
    expect(await confirmRestoredVmBaseline(path, 'epoch-a', 'agent-a')).toMatchObject({ activeRuns: 0 });
    expect(seen).toEqual([HostFrameKind.PrepareBaseline, HostFrameKind.RestoredBaseline]);
  } finally {
    server.close();
  }
});
