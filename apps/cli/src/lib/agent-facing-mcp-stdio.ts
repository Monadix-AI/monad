import { Writable } from 'node:stream';

export interface JsonLineWriter {
  write(value: unknown): Promise<void>;
  reserve(): (value: unknown | null) => Promise<void>;
}

export interface JsonRpcStdioHandler<Request, Response> {
  handle(request: Request): Promise<Response | null>;
  close(): Promise<void>;
}

interface ServeJsonRpcStdioOptions {
  input?: AsyncIterable<Uint8Array>;
  output?: Writable;
}

function writeChunk(output: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      output.write(bytes, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function createOrderedJsonLineWriter(output: Writable): JsonLineWriter {
  const encoder = new TextEncoder();
  let tail = Promise.resolve();
  const reserve = (): ((value: unknown | null) => Promise<void>) => {
    const previous = tail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    tail = previous.then(() => slot).catch(() => undefined);
    let fulfilled = false;
    return async (value) => {
      if (fulfilled) throw new Error('JSON line response slot is already fulfilled');
      fulfilled = true;
      try {
        await previous;
        if (value !== null) await writeChunk(output, encoder.encode(`${JSON.stringify(value)}\n`));
      } finally {
        release();
      }
    };
  };
  return {
    write(value) {
      return reserve()(value);
    },
    reserve
  };
}

export async function serveJsonRpcStdio<Request, Response>(
  handler: JsonRpcStdioHandler<Request, Response>,
  parseRequest: (value: unknown) => Request,
  options: ServeJsonRpcStdioOptions = {}
): Promise<void> {
  const input = options.input ?? (Bun.stdin.stream() as AsyncIterable<Uint8Array>);
  const output = options.output ?? process.stdout;
  const decoder = new TextDecoder();
  const writer = createOrderedJsonLineWriter(output);
  const pending = new Set<Promise<void>>();
  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task)
    );
  };
  const dispatch = (request: Request): void => {
    const fulfill = writer.reserve();
    track(
      handler.handle(request).then(
        (response) => fulfill(response),
        async (error) => {
          await fulfill(null);
          throw error;
        }
      )
    );
  };
  const dispatchParseError = (): void => {
    track(writer.reserve()({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
  };
  let buffer = '';
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        dispatch(parseRequest(JSON.parse(line)));
      } catch {
        dispatchParseError();
      }
    }
  }
  await handler.close();
  await Promise.allSettled([...pending]);
}
