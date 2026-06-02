import { expect, spyOn, test } from 'bun:test';
import { Writable } from 'node:stream';

import { createAgentFacingMcpHandler } from '../../src/lib/agent-facing-mcp-server.ts';
import { createOrderedJsonLineWriter, serveJsonRpcStdio } from '../../src/lib/agent-facing-mcp-stdio.ts';

class DelayedWritable extends Writable {
  readonly chunks: Buffer[] = [];
  failNextWrite = false;

  constructor() {
    super({ highWaterMark: 1024 });
  }

  override write(chunk: unknown, callback?: (error?: Error | null) => void): boolean;
  override write(chunk: unknown, encoding: BufferEncoding, callback?: (error?: Error | null) => void): boolean;
  override write(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      const completion = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      setTimeout(() => completion?.(new Error('simulated output failure')), 5);
      return false;
    }
    if (typeof encodingOrCallback === 'function' || encodingOrCallback === undefined) {
      return super.write(chunk, encodingOrCallback);
    }
    return super.write(chunk, encodingOrCallback, callback);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    setTimeout(() => {
      this.chunks.push(Buffer.from(chunk));
      callback();
    }, 5);
  }

  frames(): unknown[] {
    return Buffer.concat(this.chunks)
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
  }
}

function responseOfByteLength(id: number, byteLength: number) {
  const response = { jsonrpc: '2.0' as const, id, result: { payload: '' } };
  const overhead = new TextEncoder().encode(JSON.stringify(response)).byteLength;
  return { ...response, result: { payload: 'x'.repeat(byteLength - overhead) } };
}

async function* inputOf(...lines: string[]): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(`${lines.join('\n')}\n`);
}

test('agent-facing MCP stdio keeps concurrent large responses newline framed and request ordered', async () => {
  const output = new DelayedWritable();
  const writer = createOrderedJsonLineWriter(output);
  const first = responseOfByteLength(1, 81_838);
  const second = { jsonrpc: '2.0' as const, id: 2, result: { ready: true } };

  expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBe(81_838);
  await Promise.all([writer.write(first), writer.write(second)]);

  expect(output.frames()).toEqual([first, second]);
});

test('agent-facing MCP stdio rejects a failed write without poisoning the following response', async () => {
  const output = new DelayedWritable();
  output.failNextWrite = true;
  const writer = createOrderedJsonLineWriter(output);
  const first = writer.write({ jsonrpc: '2.0', id: 1, result: { ready: false } });
  const second = writer.write({ jsonrpc: '2.0', id: 2, result: { ready: true } });

  await expect(first).rejects.toThrow('simulated output failure');
  await expect(second).resolves.toBeUndefined();

  expect(output.frames()).toEqual([{ jsonrpc: '2.0', id: 2, result: { ready: true } }]);
});

test('agent-facing MCP stdio preserves input request order when a later handler resolves first', async () => {
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let secondHandled!: () => void;
  const secondHandledPromise = new Promise<void>((resolve) => {
    secondHandled = resolve;
  });
  const output = new DelayedWritable();
  const run = serveJsonRpcStdio(
    {
      async handle(request: { id: number }) {
        if (request.id === 1) {
          firstStarted();
          await firstRelease;
        } else {
          secondHandled();
        }
        return { jsonrpc: '2.0', id: request.id, result: { requestId: request.id } };
      },
      async close() {}
    },
    (value) => value as { id: number },
    {
      input: inputOf(JSON.stringify({ id: 1 }), JSON.stringify({ id: 2 })),
      output
    }
  );

  await Promise.all([firstStartedPromise, secondHandledPromise]);
  releaseFirst();
  await run;

  expect(output.frames()).toEqual([
    { jsonrpc: '2.0', id: 1, result: { requestId: 1 } },
    { jsonrpc: '2.0', id: 2, result: { requestId: 2 } }
  ]);
});

test('agent-facing MCP stdio keeps parse errors in their input position', async () => {
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const output = new DelayedWritable();
  const run = serveJsonRpcStdio(
    {
      async handle(request: { id: number }) {
        if (request.id === 1) {
          firstStarted();
          await firstRelease;
        }
        return { jsonrpc: '2.0', id: request.id, result: { requestId: request.id } };
      },
      async close() {}
    },
    (value) => value as { id: number },
    {
      input: inputOf(JSON.stringify({ id: 1 }), '{bad json', JSON.stringify({ id: 2 })),
      output
    }
  );

  await firstStartedPromise;
  releaseFirst();
  await run;

  expect(output.frames()).toEqual([
    { jsonrpc: '2.0', id: 1, result: { requestId: 1 } },
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
    { jsonrpc: '2.0', id: 2, result: { requestId: 2 } }
  ]);
});

test('agent-facing MCP stdio keeps chunk lines bounded and recovers after an invalid cursor', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let calls = 0;
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              read: {
                post: async () => {
                  calls++;
                  return {
                    data:
                      calls === 1
                        ? { messages: [{ text: 'large/'.repeat(20_000) }] }
                        : { messages: [{ text: 'small' }] },
                    status: 200
                  };
                }
              }
            }
          }
        }
      }
    }
  };
  const output = new DelayedWritable();
  try {
    await serveJsonRpcStdio(
      createAgentFacingMcpHandler(client as never),
      (value) => value as { jsonrpc: '2.0'; id: number; method: string; params?: unknown },
      {
        input: inputOf(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'project_read', arguments: { cursor: 'missing:49100' } }
          }),
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'project_read', arguments: {} }
          }),
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'project_read', arguments: {} }
          })
        ),
        output
      }
    );

    const lines = Buffer.concat(output.chunks).toString('utf8').trimEnd().split('\n');
    const frames = lines.map((line) => JSON.parse(line));
    expect(lines.every((line) => new TextEncoder().encode(`${line}\n`).byteLength <= 48 * 1024)).toBe(true);
    expect(frames).toMatchObject([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: expect.stringContaining('call project_read again without cursor') }],
          isError: true
        }
      },
      {
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [{ type: 'text' }],
          isError: false
        }
      },
      {
        jsonrpc: '2.0',
        id: 3,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ messages: [{ text: 'small' }] }, null, 2) }],
          isError: false
        }
      }
    ]);
    const chunk = JSON.parse(frames[1].result.content[0].text);
    expect(chunk).toMatchObject({
      encoding: 'json-utf8-chunks',
      offsetBytes: 0,
      complete: false,
      nextCursor: expect.any(String)
    });
    expect(calls).toBe(2);
  } finally {
    stderr.mockRestore();
  }
});
