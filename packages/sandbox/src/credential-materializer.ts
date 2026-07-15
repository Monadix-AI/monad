import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { SENTINEL_PREFIX } from './credential-sentinel.ts';

export const MAX_CREDENTIAL_BYTES = 1024 * 1024;
export const MAX_MATERIALIZED_BYTES = 2 * 1024 * 1024;
export const MAX_CREDENTIAL_CAPTURES = 128;
export const MAX_JWT_SEGMENT_BYTES = 64 * 1024;
export const MAX_JWT_NESTING = 16;
export const REGEX_DEADLINE_MS = 250;
export const REGEX_PROCESS_DEADLINE_MS = 2_000;

export interface CredentialTransform {
  extract?: string;
  maskDuplicates?: boolean;
  decode?: 'jwt';
  maskClaims?: readonly string[];
}

export interface CredentialSubstitution {
  fake: string;
  real: string;
  injectHosts: readonly string[];
}

export interface MaterializedCredential {
  childValue: string;
  substitutions: CredentialSubstitution[];
}

export enum CredentialMaterializationError {
  INPUT_TOO_LARGE = 'INPUT_TOO_LARGE',
  OUTPUT_TOO_LARGE = 'OUTPUT_TOO_LARGE',
  INVALID_REGEX = 'INVALID_REGEX',
  REGEX_TIMEOUT = 'REGEX_TIMEOUT',
  NO_MATCH = 'NO_MATCH',
  EMPTY_CAPTURE = 'EMPTY_CAPTURE',
  TOO_MANY_CAPTURES = 'TOO_MANY_CAPTURES',
  OVERLAPPING_CAPTURES = 'OVERLAPPING_CAPTURES',
  INVALID_JWT = 'INVALID_JWT',
  JWT_TOO_LARGE = 'JWT_TOO_LARGE',
  JWT_TOO_DEEP = 'JWT_TOO_DEEP',
  MISSING_JWT_CLAIM = 'MISSING_JWT_CLAIM',
  INVALID_JWT_CLAIM = 'INVALID_JWT_CLAIM'
}

export type CredentialMaterializationResult =
  | { ok: true; value: MaterializedCredential }
  | { ok: false; error: CredentialMaterializationError };

interface Capture {
  start: number;
  end: number;
  value: string;
}

interface RegexWorkerSuccess {
  ok: true;
  captures: Capture[];
}

interface RegexWorkerFailure {
  ok: false;
  error: CredentialMaterializationError;
}

function sentinel(): string {
  return SENTINEL_PREFIX + randomUUID();
}

function extractCaptures(input: string, pattern: string): RegexWorkerSuccess | RegexWorkerFailure {
  const worker = join(import.meta.dir, 'credential-regex-worker.ts');
  const result = spawnSync(process.execPath, [worker], {
    input: JSON.stringify({ input, pattern, maxCaptures: MAX_CREDENTIAL_CAPTURES, deadlineMs: REGEX_DEADLINE_MS }),
    encoding: 'utf8',
    timeout: REGEX_PROCESS_DEADLINE_MS,
    maxBuffer: MAX_MATERIALIZED_BYTES
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { ok: false, error: CredentialMaterializationError.REGEX_TIMEOUT };
  }
  if (result.status !== 0 || !result.stdout) {
    return { ok: false, error: CredentialMaterializationError.INVALID_REGEX };
  }
  try {
    return JSON.parse(result.stdout) as RegexWorkerSuccess | RegexWorkerFailure;
  } catch {
    return { ok: false, error: CredentialMaterializationError.INVALID_REGEX };
  }
}

function nesting(value: unknown, depth = 0): number {
  if (depth > MAX_JWT_NESTING) return depth;
  if (Array.isArray(value)) return value.reduce((max, item) => Math.max(max, nesting(item, depth + 1)), depth);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce((max, item) => Math.max(max, nesting(item, depth + 1)), depth);
  }
  return depth;
}

function decodeJsonSegment(segment: string): Record<string, unknown> | CredentialMaterializationError {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return CredentialMaterializationError.INVALID_JWT;
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.byteLength > MAX_JWT_SEGMENT_BYTES) return CredentialMaterializationError.JWT_TOO_LARGE;
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString('utf8'));
  } catch {
    return CredentialMaterializationError.INVALID_JWT;
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return CredentialMaterializationError.INVALID_JWT;
  }
  if (nesting(value) > MAX_JWT_NESTING) return CredentialMaterializationError.JWT_TOO_DEEP;
  return value as Record<string, unknown>;
}

function fakeJwt(
  real: string,
  claims: readonly string[] | undefined
): { fake: string; real: string } | CredentialMaterializationError {
  const parts = real.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return CredentialMaterializationError.INVALID_JWT;
  const header = decodeJsonSegment(parts[0] ?? '');
  if (typeof header === 'string') return header;
  const payload = decodeJsonSegment(parts[1] ?? '');
  if (typeof payload === 'string') return payload;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2] ?? '')) return CredentialMaterializationError.INVALID_JWT;

  let fakePayload: Record<string, unknown>;
  if (claims === undefined || claims.length === 0) {
    fakePayload = { monad: sentinel() };
  } else {
    fakePayload = structuredClone(payload);
    for (const claim of claims) {
      if (!(claim in fakePayload)) return CredentialMaterializationError.MISSING_JWT_CLAIM;
      if (typeof fakePayload[claim] !== 'string') return CredentialMaterializationError.INVALID_JWT_CLAIM;
      fakePayload[claim] = sentinel();
    }
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    fake: `${encode({ alg: 'none', typ: 'JWT' })}.${encode(fakePayload)}.${Buffer.from(randomUUID()).toString('base64url')}`,
    real
  };
}

function replacementFor(
  real: string,
  transform: CredentialTransform
): { fake: string; real: string } | CredentialMaterializationError {
  return transform.decode === 'jwt' ? fakeJwt(real, transform.maskClaims) : { fake: sentinel(), real };
}

function expandDuplicates(input: string, captures: Capture[]): Capture[] | CredentialMaterializationError {
  const byValue = new Map<string, Capture>();
  for (const capture of captures) byValue.set(capture.value, capture);
  const spans: Capture[] = [];
  for (const [value] of byValue) {
    let start = 0;
    while (start <= input.length - value.length) {
      const found = input.indexOf(value, start);
      if (found < 0) break;
      spans.push({ start: found, end: found + value.length, value });
      start = found + value.length;
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  for (let index = 1; index < spans.length; index++) {
    if ((spans[index]?.start ?? 0) < (spans[index - 1]?.end ?? 0)) {
      return CredentialMaterializationError.OVERLAPPING_CAPTURES;
    }
  }
  return spans;
}

export function materializeCredential(
  input: string,
  injectHosts: readonly string[],
  transform: CredentialTransform = {}
): CredentialMaterializationResult {
  if (Buffer.byteLength(input, 'utf8') > MAX_CREDENTIAL_BYTES) {
    return { ok: false, error: CredentialMaterializationError.INPUT_TOO_LARGE };
  }

  if (transform.extract === undefined) {
    const replacement = replacementFor(input, transform);
    if (typeof replacement === 'string') return { ok: false, error: replacement };
    return {
      ok: true,
      value: { childValue: replacement.fake, substitutions: [{ ...replacement, injectHosts }] }
    };
  }

  const extracted = extractCaptures(input, transform.extract);
  if (!extracted.ok) return extracted;
  const captures = transform.maskDuplicates ? expandDuplicates(input, extracted.captures) : extracted.captures;
  if (typeof captures === 'string') return { ok: false, error: captures };
  const replacements = new Map<string, { fake: string; real: string }>();
  for (const capture of captures) {
    if (replacements.has(capture.value)) continue;
    const replacement = replacementFor(capture.value, transform);
    if (typeof replacement === 'string') return { ok: false, error: replacement };
    replacements.set(capture.value, replacement);
  }
  let childValue = '';
  let offset = 0;
  for (const capture of captures) {
    if (capture.start < offset) return { ok: false, error: CredentialMaterializationError.OVERLAPPING_CAPTURES };
    childValue += input.slice(offset, capture.start) + replacements.get(capture.value)?.fake;
    offset = capture.end;
  }
  childValue += input.slice(offset);
  if (Buffer.byteLength(childValue, 'utf8') > MAX_MATERIALIZED_BYTES) {
    return { ok: false, error: CredentialMaterializationError.OUTPUT_TOO_LARGE };
  }
  return {
    ok: true,
    value: {
      childValue,
      substitutions: [...replacements.values()].map((replacement) => ({ ...replacement, injectHosts }))
    }
  };
}
