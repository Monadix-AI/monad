import { createHash } from 'node:crypto';
import { createLogger } from '@monad/logger';
import { httpErrorSchema, publicErrorDescriptorSchema } from '@monad/protocol';
import { z } from 'zod';

import { HandlerError } from '#/handlers/handler-error.ts';
import {
  getRequestCorrelationId,
  mapDirectPublicError,
  mapPublicError,
  projectHttpErrorResponse
} from '#/transports/public-error.ts';

const IDEMPOTENCY_KEY_PATTERN = /^idem_[0-9A-Za-z]{12}$/;
const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const log = createLogger('transport:http:idempotency');
const responseHeadersSchema = z.record(z.string(), z.string());

interface HttpIdempotencyRecord {
  key: string;
  requestFingerprint: string;
  responseBody: string | null;
  responseHeaders: string | null;
  responseStatus: number | null;
  scope: string;
  status: 'completed' | 'processing';
}

type ReserveHttpIdempotencyResult =
  | { kind: 'reserved' }
  | { kind: 'existing'; record: HttpIdempotencyRecord }
  | { kind: 'conflict'; record: HttpIdempotencyRecord };

export interface IdempotencyStore {
  completeHttpIdempotency(args: {
    body: string;
    expiresAt: string;
    headers: Record<string, string>;
    key: string;
    now: string;
    scope: string;
    status: number;
  }): void;
  reserveHttpIdempotency(args: {
    expiresAt: string;
    fingerprint: string;
    key: string;
    now: string;
    scope: string;
  }): ReserveHttpIdempotencyResult;
}

interface InMemoryHttpIdempotencyEntry extends HttpIdempotencyRecord {
  expiresAt: number;
}

export function createInMemoryHttpIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, InMemoryHttpIdempotencyEntry>();
  const entryKey = (scope: string, key: string) => `${scope}\0${key}`;
  const pruneExpired = (nowMs: number) => {
    for (const [mapKey, entry] of entries) {
      if (entry.expiresAt <= nowMs) entries.delete(mapKey);
    }
  };

  return {
    reserveHttpIdempotency(args) {
      const nowMs = Date.parse(args.now);
      pruneExpired(nowMs);

      const mapKey = entryKey(args.scope, args.key);
      const existing = entries.get(mapKey);
      if (!existing) {
        entries.set(mapKey, {
          key: args.key,
          requestFingerprint: args.fingerprint,
          responseBody: null,
          responseHeaders: null,
          responseStatus: null,
          scope: args.scope,
          status: 'processing',
          expiresAt: Date.parse(args.expiresAt)
        });
        return { kind: 'reserved' };
      }

      return existing.requestFingerprint === args.fingerprint
        ? { kind: 'existing', record: existing }
        : { kind: 'conflict', record: existing };
    },
    completeHttpIdempotency(args) {
      const nowMs = Date.parse(args.now);
      pruneExpired(nowMs);

      const mapKey = entryKey(args.scope, args.key);
      const existing = entries.get(mapKey);
      if (!existing) return;
      entries.set(mapKey, {
        ...existing,
        responseBody: args.body,
        responseHeaders: JSON.stringify(args.headers),
        responseStatus: args.status,
        status: 'completed',
        expiresAt: Date.parse(args.expiresAt)
      });
    }
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function requestFingerprint(args: { body: unknown; method: string; path: string }): string {
  return createHash('sha256')
    .update(args.method.toUpperCase())
    .update('\n')
    .update(args.path)
    .update('\n')
    .update(canonicalJson(args.body))
    .digest('hex');
}

function authorizationScope(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization) return 'local';
  return createHash('sha256').update(authorization).digest('hex').slice(0, 16);
}

function idempotencyKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function errorResponse(error: unknown, request: Request): Response {
  return projectHttpErrorResponse(mapPublicError(error, getRequestCorrelationId(request)));
}

function idempotencyKey(request: Request): string | null {
  return request.headers.get('idempotency-key');
}

function headersObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) out[key] = value;
  return out;
}

function replay(
  record: {
    responseBody: string | null;
    responseHeaders: string | null;
    responseStatus: number | null;
    status: string;
  },
  request: Request
): Response {
  if (record.status !== 'completed' || record.responseStatus === null) {
    return projectHttpErrorResponse(
      mapDirectPublicError(request, 409, 'IDEMPOTENCY_IN_PROGRESS', 'idempotent request is still processing', true)
    );
  }
  const headers = new Headers(
    record.responseHeaders ? responseHeadersSchema.parse(JSON.parse(record.responseHeaders)) : {}
  );
  headers.set('idempotent-replayed', 'true');
  if (record.responseBody && record.responseStatus >= 400) {
    let storedBody: unknown;
    try {
      storedBody = JSON.parse(record.responseBody);
    } catch {
      storedBody = undefined;
    }
    const parsed = httpErrorSchema.safeParse(storedBody);
    if (parsed.success && parsed.data.code && parsed.data.retryable !== undefined && parsed.data.requestId) {
      const descriptor = publicErrorDescriptorSchema.safeParse({
        code: parsed.data.code,
        message: parsed.data.error,
        retryable: parsed.data.retryable,
        requestId: getRequestCorrelationId(request),
        ...(parsed.data.details ? { details: parsed.data.details } : {})
      });
      if (descriptor.success) {
        return projectHttpErrorResponse({ status: record.responseStatus, descriptor: descriptor.data }, headers);
      }
    }
  }
  return new Response(record.responseBody ?? '', { headers, status: record.responseStatus });
}

export async function withHttpIdempotency({
  body,
  handler,
  method,
  path,
  request,
  scope,
  store,
  ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS
}: {
  body: unknown;
  handler: () => Promise<Response> | Response;
  method: string;
  path: string;
  request: Request;
  scope: string;
  store: IdempotencyStore | null;
  ttlMs?: number;
}): Promise<Response> {
  const key = idempotencyKey(request);
  if (!key) return handler();
  const requestId = getRequestCorrelationId(request);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    log.warn({ event: 'http.idempotency.invalid_key', requestId }, 'rejected invalid idempotency key');
    return projectHttpErrorResponse(mapDirectPublicError(request, 400, 'VALIDATION', 'invalid idempotency key', false));
  }
  if (!store) return handler();

  const now = new Date();
  const authScope = authorizationScope(request);
  const scopedKey = `${scope}:auth:${authScope}`;
  const logContext = { authScope, keyHash: idempotencyKeyHash(key), method, path, requestId, scope };
  const reserved = store.reserveHttpIdempotency({
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    fingerprint: requestFingerprint({ body, method, path }),
    key,
    now: now.toISOString(),
    scope: scopedKey
  });
  if (reserved.kind === 'conflict') {
    log.warn({ ...logContext, event: 'http.idempotency.conflict' }, 'idempotency key conflict');
    return projectHttpErrorResponse(
      mapDirectPublicError(
        request,
        409,
        'IDEMPOTENCY_CONFLICT',
        'idempotency key reused with different request parameters',
        false
      )
    );
  }
  if (reserved.kind === 'existing') {
    const event = reserved.record.status === 'completed' ? 'http.idempotency.replay' : 'http.idempotency.in_progress';
    log.debug(
      { ...logContext, event, storedStatus: reserved.record.status, responseStatus: reserved.record.responseStatus },
      'idempotency key reused'
    );
    return replay(reserved.record, request);
  }

  log.debug({ ...logContext, event: 'http.idempotency.reserve' }, 'reserved idempotency key');

  let response: Response;
  try {
    response = await handler();
  } catch (error) {
    if (!(error instanceof HandlerError)) {
      log.error(
        { ...logContext, err: error, event: 'http.idempotency.handler_error' },
        'idempotent request handler failed'
      );
    }
    response = errorResponse(error, request);
  }
  const responseText = await response.clone().text();
  store.completeHttpIdempotency({
    body: responseText,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    headers: headersObject(response.headers),
    key,
    now: new Date().toISOString(),
    scope: scopedKey,
    status: response.status
  });
  log.debug(
    { ...logContext, event: 'http.idempotency.complete', responseStatus: response.status },
    'completed idempotent request'
  );
  return response;
}

export function idempotentJsonHandler<Ctx extends { body: unknown; request: Request }>({
  route,
  scope,
  store,
  handler
}: {
  handler: (ctx: Ctx) => Promise<Response> | Response;
  route: (ctx: Ctx) => string;
  scope?: (ctx: Ctx) => string;
  store: IdempotencyStore | null;
}) {
  return (ctx: Ctx) => {
    const path = route(ctx);
    return withHttpIdempotency({
      body: ctx.body,
      handler: () => handler(ctx),
      method: 'POST',
      path,
      request: ctx.request,
      scope: scope?.(ctx) ?? `POST:${path}`,
      store
    });
  };
}
