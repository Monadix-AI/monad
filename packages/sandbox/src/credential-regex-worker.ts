import { z } from 'zod';

export interface RegexWorkerRequest {
  input: string;
  pattern: string;
  maxCaptures: number;
  deadlineMs: number;
}

const regexWorkerRequestSchema = z.object({
  input: z.string(),
  pattern: z.string(),
  maxCaptures: z.number().int().nonnegative(),
  deadlineMs: z.number().int().nonnegative()
});

export type RegexWorkerResult =
  | { ok: true; captures: Array<{ start: number; end: number; value: string }> }
  | { ok: false; error: 'INVALID_REGEX' | 'REGEX_TIMEOUT' | 'NO_MATCH' | 'EMPTY_CAPTURE' | 'TOO_MANY_CAPTURES' };

let request: RegexWorkerRequest;
try {
  request = regexWorkerRequestSchema.parse(await Bun.stdin.json());
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: 'INVALID_REGEX' } satisfies RegexWorkerResult));
  process.exit(0);
}

const worker = new Worker(new URL('./credential-regex-executor.ts', import.meta.url));
let settled = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function finish(result: RegexWorkerResult): void {
  if (settled) return;
  settled = true;
  if (timer) clearTimeout(timer);
  worker.terminate();
  process.stdout.write(JSON.stringify(result));
}

worker.addEventListener('message', (event: MessageEvent<RegexWorkerResult>) => finish(event.data));
worker.addEventListener('error', () => finish({ ok: false, error: 'INVALID_REGEX' }));
timer = setTimeout(() => finish({ ok: false, error: 'REGEX_TIMEOUT' }), request.deadlineMs);
worker.postMessage(request);
