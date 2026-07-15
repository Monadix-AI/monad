import type { RegexWorkerRequest, RegexWorkerResult } from './credential-regex-worker.ts';

function run(request: RegexWorkerRequest): RegexWorkerResult {
  let regex: RegExp;
  try {
    regex = new RegExp(request.pattern, 'gd');
  } catch {
    return { ok: false, error: 'INVALID_REGEX' };
  }
  const captures: Array<{ start: number; end: number; value: string }> = [];
  for (const match of request.input.matchAll(regex)) {
    const value = match[1];
    const span = (match as RegExpMatchArray & { indices: Array<[number, number] | undefined> }).indices[1];
    if (value === undefined || value.length === 0 || span === undefined) {
      return { ok: false, error: 'EMPTY_CAPTURE' };
    }
    captures.push({ start: span[0], end: span[1], value });
    if (captures.length > request.maxCaptures) return { ok: false, error: 'TOO_MANY_CAPTURES' };
  }
  return captures.length === 0 ? { ok: false, error: 'NO_MATCH' } : { ok: true, captures };
}

addEventListener('message', (event: MessageEvent<RegexWorkerRequest>) => postMessage(run(event.data)));
