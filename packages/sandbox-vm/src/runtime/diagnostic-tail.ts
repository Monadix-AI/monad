export class DiagnosticTail {
  private value = Buffer.alloc(0);

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('diagnostic tail capacity must be positive');
  }

  append(chunk: Uint8Array<ArrayBufferLike>): void {
    if (chunk.byteLength >= this.capacity) {
      this.value = Buffer.from(chunk.subarray(chunk.byteLength - this.capacity));
      return;
    }
    const combined = Buffer.concat([this.value, chunk]);
    this.value =
      combined.byteLength > this.capacity ? combined.subarray(combined.byteLength - this.capacity) : combined;
  }

  bytes(): Buffer {
    return Buffer.from(this.value);
  }

  text(): string {
    return this.value.toString('utf8');
  }
}

export function drainDiagnosticStream(
  stream: ReadableStream<Uint8Array> | undefined,
  capacity = 64 * 1024
): { tail: DiagnosticTail; done: Promise<void> } {
  const tail = new DiagnosticTail(capacity);
  const done = (async () => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        tail.append(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  })();
  void done.catch(() => {});
  return { tail, done };
}
