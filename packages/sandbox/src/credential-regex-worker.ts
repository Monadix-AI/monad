interface Request {
  input: string;
  pattern: string;
  maxCaptures: number;
}

type WorkerResult =
  | { ok: true; captures: Array<{ start: number; end: number; value: string }> }
  | { ok: false; error: 'INVALID_REGEX' | 'NO_MATCH' | 'EMPTY_CAPTURE' | 'TOO_MANY_CAPTURES' };

function run(request: Request): WorkerResult {
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

let result: WorkerResult;
try {
  result = run((await Bun.stdin.json()) as Request);
} catch {
  result = { ok: false, error: 'INVALID_REGEX' };
}
process.stdout.write(JSON.stringify(result));
