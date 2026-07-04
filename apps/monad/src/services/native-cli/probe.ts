import { killNativeCliProcess } from '@/services/native-cli/process.ts';
import { createStreamingTextDecoder } from '@/services/native-cli/stream-decoder.ts';

/** Append `chunk` to `existing`, keeping only the trailing `max` bytes. The bound is what makes the
 *  in-memory output snapshot and the probe collectors safe against a runaway child. */
export function appendBounded(existing: string, chunk: string, max: number): string {
  const next = `${existing}${chunk}`;
  return next.length <= max ? next : next.slice(next.length - max);
}

/** Drain a child stream to a bounded string (decodes incrementally so multi-byte runes never split). */
async function collectText(stream: ReadableStream<Uint8Array> | undefined, maxBytes: number): Promise<string> {
  if (!stream) return '';
  const decoder = createStreamingTextDecoder();
  let output = '';
  for await (const data of stream) {
    output = appendBounded(output, decoder.decode(data), maxBytes);
  }
  return appendBounded(output, decoder.flush(), maxBytes);
}

/** Run a one-shot probe process to completion or timeout, returning its exit code and combined
 *  stdout+stderr. On timeout the child is SIGTERM'd so a hung provider CLI can't leak. */
export async function collectProbeResult(
  proc: {
    pid: number;
    stdout: ReadableStream<Uint8Array> | undefined;
    stderr: ReadableStream<Uint8Array> | undefined;
    exited: Promise<number>;
  },
  timeoutMs: number,
  maxBytes: number
): Promise<{ timedOut: boolean; code: number | null; output: string }> {
  const outputPromise = Promise.all([collectText(proc.stdout, maxBytes), collectText(proc.stderr, maxBytes)]).then(
    ([stdout, stderr]) => appendBounded(stdout, stderr, maxBytes)
  );
  let done = false;
  const exited = proc.exited.then((code) => {
    done = true;
    return { timedOut: false as const, code };
  });
  const timeout = Bun.sleep(timeoutMs).then(() => {
    if (done) return { timedOut: false as const, code: null };
    done = true;
    killNativeCliProcess(proc.pid, 'SIGTERM');
    return { timedOut: true as const, code: null };
  });
  const result = await Promise.race([exited, timeout]);
  return { ...result, output: await outputPromise.catch(() => '') };
}
